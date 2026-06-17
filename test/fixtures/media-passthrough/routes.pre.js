import { createRateAwareCap } from "../rate-resilience/cap.js";
/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";

// @openclaw-bridge:concurrency-cap v1
const __OB_MAX = Math.max(1, parseInt(process.env.OPENCLAW_BRIDGE_MAX_CONCURRENT || "4", 10));
let __OB_active = 0;
const __OB_waiters = [];
// @openclaw-bridge:rate-resilience v1
const __obRateCap = createRateAwareCap({ baseMax: __OB_MAX, cooldownMs: 60000 });
globalThis.__OB_TEST_rateCap = __obRateCap;
function __obAcquire() {
  if (__OB_active < __obRateCap.currentMax()) { __OB_active++; return Promise.resolve(); }
  return new Promise((resolve) => __OB_waiters.push(() => { __OB_active++; resolve(); }));
}
function __obRelease() {
  __OB_active--;
  // @openclaw-bridge:rate-resilience v1 — drain only up to the (possibly shrunk) effective max; new arrivals ramp back via __obAcquire's fast path after cooldown
  if (__OB_active < __obRateCap.currentMax()) {
    const next = __OB_waiters.shift();
    if (next) next();
  }
}
globalThis.__OB_TEST_acquire = __obAcquire;
globalThis.__OB_TEST_release = __obRelease;
globalThis.__OB_TEST_max = __OB_MAX;

// @openclaw-bridge:session-serialize v1
const __OB_sessionLocks = new Map();
function __obSessionLock(sessionId) {
  if (!sessionId) {
    return { wait: Promise.resolve(), release: () => {} };
  }
  const prev = __OB_sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = () => {
    if (__OB_sessionLocks.get(sessionId) === chain) __OB_sessionLocks.delete(sessionId);
    resolve();
  }; });
  const chain = prev.then(() => next);
  __OB_sessionLocks.set(sessionId, chain);
  return { wait: prev, release };
}
globalThis.__OB_TEST_sessionLock = __obSessionLock;

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(req, res) {
    await __obAcquire();
    let __obLock = { release: () => {} };
    try {
        const __obSessionId = (req.body && typeof req.body.user === "string") ? req.body.user : "";
        __obLock = __obSessionLock(__obSessionId);
        await __obLock.wait;
        try {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Convert to CLI input format
        const cliInput = openaiToCli(body);
        // @openclaw-bridge:rotator v1
        const { prepare: __rotatorPrepare, complete: __rotatorComplete } = await import("../rotator/index.js");
        const __rotatorCtx = await __rotatorPrepare(body);
        if (__rotatorCtx && __rotatorCtx.noHealthy) {
            res.status(429).json({ error: { type: "rate_limit", message: "rotator_" + __rotatorCtx.noHealthy } });
            return;
        }
        const subprocess = new ClaudeSubprocess();
        subprocess.envOverrides = __rotatorCtx ? __rotatorCtx.env : {};
        subprocess.once("close", (__code) => {
            __rotatorComplete(__rotatorCtx, { exitCode: __code, stderrTail: subprocess.stderrTail });
        });
        // @openclaw-bridge:rotator-end v1
        if (stream) {
            await __OB_TEST_handleStreamingResponse(req, res, subprocess, cliInput, requestId);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message,
                    type: "server_error",
                    code: null,
                },
            });
        }
    }
    } finally { __obLock.release(); }
    } finally { __obRelease(); }
}
/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
// @openclaw-bridge:stream-safety v1
export async function __OB_TEST_handleStreamingResponse(req, res, subprocess, cliInput, requestId) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    // CRITICAL: Flush headers immediately to establish SSE connection
    // Without this, headers are buffered and client times out waiting
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    let __obSawDelta = false;
    const __obKeepAlive = setInterval(() => {
        if (!res.writableEnded) { try { res.write(":keep-alive\n\n"); } catch (_) {} }
    }, 15000);
    function __obStopKeepAlive() { if (__obKeepAlive) clearInterval(__obKeepAlive); }
    return new Promise((resolve, reject) => {
        let isFirst = true;
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        // Handle actual client disconnect (response stream closed)
        res.on("close", () => { __obStopKeepAlive();
            if (!isComplete) {
                // Client disconnected before response completed - kill subprocess
                subprocess.kill();
            }
            resolve();
        });
        // Handle streaming content deltas
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) { __obSawDelta = true;
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{
                            index: 0,
                            delta: {
                                role: isFirst ? "assistant" : undefined,
                                content: text,
                            },
                            finish_reason: null,
                        }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
            }
        });
        // Handle final assistant message (for model name)
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });
        subprocess.on("result", (_result) => {
            __obStopKeepAlive();
            if (!__obSawDelta && _result && typeof _result.result === "string" && _result.result.length > 0 && !res.writableEnded) {
                const fallbackChunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: "assistant", content: _result.result }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(fallbackChunk)}\n\n`);
            }
            isComplete = true;
            if (!res.writableEnded) {
                // Send final done chunk with finish_reason
                const doneChunk = createDoneChunk(requestId, lastModel);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        subprocess.on("error", (error) => { __obStopKeepAlive();
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => { __obStopKeepAlive();
            // @openclaw-bridge:rate-resilience v1 — react to rate limits on the streaming path (cannot send 429 after headers, but shrink the cap)
            if (subprocess.rateLimit) __obRateCap.onRateLimited(subprocess.rateLimit.subtype);
            // Subprocess exited - ensure response is closed
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    // Abnormal exit without result - send error
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
                    })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess
        // @openclaw-bridge:systemPrompt v1
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
        }).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
    });
}
/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId) {
    return new Promise((resolve) => {
        let finalResult = null;
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (subprocess.rateLimit && !res.headersSent) {
                // @openclaw-bridge:rate-resilience v1
                __obRateCap.onRateLimited(subprocess.rateLimit.subtype);
                const retryMs = subprocess.rateLimit.retryAfterMs;
                if (typeof retryMs === "number" && retryMs > 0) res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
                res.status(429).json({ error: { type: "rate_limited", code: subprocess.rateLimit.subtype, message: "claude CLI " + subprocess.rateLimit.subtype + " limit" } });
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        // Start the subprocess
        // @openclaw-bridge:systemPrompt v1
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
        })
            .catch((error) => {
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            {
                id: "claude-opus-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-sonnet-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-haiku-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
        ],
    });
}
/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
//# sourceMappingURL=routes.js.map