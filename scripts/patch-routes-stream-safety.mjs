#!/usr/bin/env node
// Idempotent installer-patcher: adds streaming-safety logic to the proxy's
// handleStreamingResponse:
//
//   (1) Every 15s, write `:keep-alive\n\n` (SSE comment, no-op for the
//       client) so upstream gateways with short idle timeouts (~55s observed
//       in OpenClaw) do not abort quiet streams mid-flight.
//   (2) When the CLI emits a `result` event without any preceding
//       `content_delta` events, synthesize one chunk from `result.result` so
//       the client never sees an empty SSE stream followed by `[DONE]`. This
//       was the root cause of `[agent/embedded] incomplete turn detected ...
//       stopReason=stop payloads=0` in gateway logs.
//
// Independent of concurrency-cap / session-serialize — only touches
// handleStreamingResponse.
//
// Guarded by the sentinel `@openclaw-bridge:stream-safety v1`.
//
// Usage: node patch-routes-stream-safety.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:stream-safety v1";

const FN_RENAME_FROM = "async function handleStreamingResponse(req, res, subprocess, cliInput, requestId) {";
const FN_RENAME_TO = `${SENTINEL}\nexport async function __OB_TEST_handleStreamingResponse(req, res, subprocess, cliInput, requestId) {`;

const CALLER_FROM = "await handleStreamingResponse(req, res, subprocess, cliInput, requestId);";
const CALLER_TO = "await __OB_TEST_handleStreamingResponse(req, res, subprocess, cliInput, requestId);";

const OK_ANCHOR = `res.write(":ok\\n\\n");`;
const OK_INJECT = `
    let __obSawDelta = false;
    const __obKeepAlive = setInterval(() => {
        if (!res.writableEnded) { try { res.write(":keep-alive\\n\\n"); } catch (_) {} }
    }, 15000);
    function __obStopKeepAlive() { if (__obKeepAlive) clearInterval(__obKeepAlive); }`;

const DELTA_ANCHOR = `if (text && !res.writableEnded) {`;
const DELTA_REPLACEMENT = `if (text && !res.writableEnded) { __obSawDelta = true;`;

const RESULT_ANCHOR = `subprocess.on("result", (_result) => {`;
const RESULT_REPLACEMENT = `subprocess.on("result", (_result) => {
            __obStopKeepAlive();
            if (!__obSawDelta && _result && typeof _result.result === "string" && _result.result.length > 0 && !res.writableEnded) {
                const fallbackChunk = {
                    id: \`chatcmpl-\${requestId}\`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: "assistant", content: _result.result }, finish_reason: null }],
                };
                res.write(\`data: \${JSON.stringify(fallbackChunk)}\\n\\n\`);
            }`;

const ERROR_ANCHOR = `subprocess.on("error", (error) => {`;
const ERROR_REPLACEMENT = `subprocess.on("error", (error) => { __obStopKeepAlive();`;

const CLOSE_ANCHOR = `subprocess.on("close", (code) => {\n            // Subprocess exited`;
const CLOSE_REPLACEMENT = `subprocess.on("close", (code) => { __obStopKeepAlive();\n            // Subprocess exited`;

const RES_CLOSE_ANCHOR = `res.on("close", () => {`;
const RES_CLOSE_REPLACEMENT = `res.on("close", () => { __obStopKeepAlive();`;

function die(msg, code = 1) {
  console.error(`patch-routes-stream-safety: ${msg}`);
  process.exit(code);
}

function patch(src) {
  if (src.includes(SENTINEL)) return src;

  let out = src;

  // 1. Rename + export the streaming handler so tests can drive it.
  if (!out.includes(FN_RENAME_FROM)) die(`anchor not found: handleStreamingResponse signature`);
  out = out.replace(FN_RENAME_FROM, FN_RENAME_TO);

  if (!out.includes(CALLER_FROM)) die(`anchor not found: handleStreamingResponse caller`);
  out = out.replace(CALLER_FROM, CALLER_TO);

  // 2. Insert keep-alive + sawDelta tracking after the initial ":ok" frame.
  if (!out.includes(OK_ANCHOR)) die(`anchor not found: res.write(":ok") frame`);
  out = out.replace(OK_ANCHOR, OK_ANCHOR + OK_INJECT);

  // 3. Mark sawDelta when a content chunk is actually written.
  if (!out.includes(DELTA_ANCHOR)) die(`anchor not found: content_delta write guard`);
  out = out.replace(DELTA_ANCHOR, DELTA_REPLACEMENT);

  // 4. On result: synthesize a chunk if no delta was ever sent.
  if (!out.includes(RESULT_ANCHOR)) die(`anchor not found: subprocess.on("result")`);
  out = out.replace(RESULT_ANCHOR, RESULT_REPLACEMENT);

  // 5. Stop keep-alive on every terminal path.
  if (!out.includes(ERROR_ANCHOR)) die(`anchor not found: subprocess.on("error")`);
  out = out.replace(ERROR_ANCHOR, ERROR_REPLACEMENT);

  if (!out.includes(CLOSE_ANCHOR)) die(`anchor not found: subprocess.on("close") with comment`);
  out = out.replace(CLOSE_ANCHOR, CLOSE_REPLACEMENT);

  if (!out.includes(RES_CLOSE_ANCHOR)) die(`anchor not found: res.on("close")`);
  out = out.replace(RES_CLOSE_ANCHOR, RES_CLOSE_REPLACEMENT);

  return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-routes-stream-safety.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const routesPath = path.join(proxyRoot, "dist", "server", "routes.js");
if (!fs.existsSync(routesPath)) die(`expected file not found: ${routesPath}`);

const orig = fs.readFileSync(routesPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);
const updated = alreadyPatched ? orig : patch(orig);

if (dryRun) {
  console.log(`patch-routes-stream-safety: dry-run against ${proxyRoot}`);
  console.log(`  routes.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(routesPath, updated);

console.log(`patch-routes-stream-safety:`);
console.log(`  routes.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
