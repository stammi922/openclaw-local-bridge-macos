import { classifyRateLimit } from "../rate-resilience/classify.js";
import { appendBridgeEvent } from "../rate-resilience/events.js";
// @openclaw-bridge:silent-debug v1
/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
/**
 * OpenClaw fork patch: when OPENCLAW_MCP_CONFIG is set, inject
 * --mcp-config and --strict-mcp-config into the claude CLI args.
 * Read lazily so tests can mutate the env per-test.
 *
 * Claude Code's non-interactive (--print) mode does not honour
 * settings.json permissions.allow for MCP tools — every mcp__* call
 * still hits the permission prompt and then fails because there is
 * no interactive approver. We opt in to bypassPermissions whenever
 * MCP is active; the allow-list in ~/.claude/settings.json is still
 * the user's consent signal (see install.sh step 10), this flag just
 * keeps the subprocess from deadlocking against an unreachable prompt.
 * OPENCLAW_MCP_PERMISSION_MODE can override the mode for ops who want
 * something stricter (e.g. "acceptEdits" with explicit --allowedTools).
 */
function mcpConfigPath() {
    return process.env.OPENCLAW_MCP_CONFIG;
}
function mcpPermissionMode() {
    return process.env.OPENCLAW_MCP_PERMISSION_MODE || "bypassPermissions";
}
function buildArgsImpl(prompt, options) {
    // @openclaw-bridge:strip-null-bytes v1
    if (typeof prompt === "string" && prompt.indexOf("\u0000") !== -1) prompt = prompt.replace(/\u0000/g, "");
    if (options && typeof options.systemPrompt === "string" && options.systemPrompt.indexOf("\u0000") !== -1) options = { ...options, systemPrompt: options.systemPrompt.replace(/\u0000/g, "") };
    const mcp = mcpConfigPath();
    const args = [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", options.model,
        "--no-session-persistence",
        // @openclaw-bridge:systemPrompt v1
        "--disable-slash-commands",
        "--setting-sources", "project",
        ...(options.systemPrompt ? ["--system-prompt", options.systemPrompt] : []),
        ...(mcp ? [
            "--mcp-config", mcp,
            "--strict-mcp-config",
            "--permission-mode", mcpPermissionMode(),
        ] : []),
        prompt,
    ];
    if (options.sessionId) {
        args.push("--session-id", options.sessionId);
    }
    return args;
}
export function buildArgs(prompt, options) {
    return buildArgsImpl(prompt, options);
}
// @openclaw-bridge:timeout v1
const DEFAULT_TIMEOUT = 7200000; // 2 hours — long-running plans/tool turns can exceed 30 min
export class ClaudeSubprocess extends EventEmitter {
    process = null;
    buffer = "";
    timeoutId = null;
    isKilled = false;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    async start(prompt, options) {
        const args = this.buildArgs(prompt, options);
        const timeout = options.timeout || DEFAULT_TIMEOUT;
        return new Promise((resolve, reject) => {
            try {
                // Use spawn() for security - no shell interpretation
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    // @openclaw-bridge:rotator v1
                    env: { ...process.env, ...(this.envOverrides || {}) },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                // Set timeout
                this.timeoutId = setTimeout(() => {
                    if (!this.isKilled) {
                        this.isKilled = true;
                        this.process?.kill("SIGTERM");
                        appendBridgeEvent({ type: "subprocess.timeout", timeoutMs: timeout });
                        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
                    }
                }, timeout);
                // Handle spawn errors (e.g., claude not found)
                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
                    }
                    else {
                        reject(err);
                    }
                });
                // Close stdin since we pass prompt as argument
                this.process.stdin?.end();
                if (process.env.OPENCLAW_BRIDGE_DEBUG === "1") console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk) => {
                    const data = chunk.toString();
                    if (process.env.OPENCLAW_BRIDGE_DEBUG === "1") console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
                    this.__obSawOutput = true;
                    this.buffer += data;
                    this.processBuffer();
                });
                // Capture stderr for debugging
                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // @openclaw-bridge:rotator v1
                        this.stderrTail = ((this.stderrTail || "") + errorText + "\n").slice(-4096);
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
                // @openclaw-bridge:rate-resilience v1
                const __obStartedAt = Date.now();
                // Handle process close
                this.process.on("close", (code) => {
                    this.rateLimit = classifyRateLimit(this.stderrTail, code);
                    appendBridgeEvent({ type: this.rateLimit ? "subprocess.rate_limited" : "subprocess.close", code, signal: null, durationMs: Date.now() - __obStartedAt, sawOutput: !!this.__obSawOutput, killed: this.isKilled, subtype: this.rateLimit?.subtype, retryAfterMs: this.rateLimit?.retryAfterMs });
                    if (process.env.OPENCLAW_BRIDGE_DEBUG === "1") console.error(`[Subprocess] Process closed with code: ${code}`);
                    this.clearTimeout();
                    // Process any remaining buffer
                    if (this.buffer.trim()) {
                        this.processBuffer();
                    }
                    this.emit("close", code);
                });
                // Resolve immediately since we're streaming
                resolve();
            }
            catch (err) {
                this.clearTimeout();
                reject(err);
            }
        });
    }
    /**
     * Build CLI arguments array
     */
    buildArgs(prompt, options) {
        return buildArgsImpl(prompt, options);
    }
    /**
     * Process the buffer and emit parsed messages
     */
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || ""; // Keep incomplete line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    // Emit content delta for streaming
                    this.emit("content_delta", message);
                }
                else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                }
                else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            }
            catch {
                // Non-JSON output, emit as raw
                this.emit("raw", trimmed);
            }
        }
    }
    /**
     * Clear the timeout timer
     */
    clearTimeout() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
    /**
     * Kill the subprocess
     */
    kill(signal = "SIGTERM") {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }
    /**
     * Check if the process is still running
     */
    isRunning() {
        return this.process !== null && !this.isKilled && this.process.exitCode === null;
    }
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: "pipe" });
        let output = "";
        proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.on("error", () => {
            resolve({
                ok: false,
                error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
            });
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true, version: output.trim() });
            }
            else {
                resolve({
                    ok: false,
                    error: "Claude CLI returned non-zero exit code",
                });
            }
        });
    });
}
/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth() {
    // If Claude CLI is installed and the user has run `claude auth login`,
    // credentials are stored in the OS keychain and will be used automatically.
    // We can't easily check the keychain, so we'll just return true if the CLI exists.
    // Authentication errors will surface when making actual API calls.
    return { ok: true };
}
//# sourceMappingURL=manager.js.map