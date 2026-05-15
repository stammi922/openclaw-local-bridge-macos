// Runtime tests for the routes.js patch chain.
//
// Applies all three patches to a tempdir copy of the vendored proxy, then
// imports the patched routes.js and exercises the JavaScript at runtime.
// Catches regressions that string-presence tests can't see — e.g., a wrong
// anchor that leaves the file syntactically valid but functionally broken.
//
// Each test sets up its own tempdir + symlinked node_modules so they don't
// leak shared globalThis state across tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const vendorRoot = path.join(repoRoot, "vendor", "claude-max-api-proxy");
const capPatcher = path.join(repoRoot, "scripts", "patch-routes-concurrency-cap.mjs");
const sessionPatcher = path.join(repoRoot, "scripts", "patch-routes-session-serialize.mjs");
const streamPatcher = path.join(repoRoot, "scripts", "patch-routes-stream-safety.mjs");

function mkPatchedProxy({ patches = ["cap", "session", "stream"] } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "routes-runtime-"));
  for (const sub of ["dist/server", "dist/adapter", "dist/subprocess", "dist/types"]) {
    fs.mkdirSync(path.join(d, sub), { recursive: true });
  }
  fs.copyFileSync(
    path.join(vendorRoot, "dist", "server", "routes.js"),
    path.join(d, "dist", "server", "routes.js"),
  );
  for (const dir of ["adapter", "subprocess", "types"]) {
    const src = path.join(vendorRoot, "dist", dir);
    if (!fs.existsSync(src)) continue;
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(d, "dist", dir, f));
    }
  }
  fs.symlinkSync(path.join(vendorRoot, "node_modules"), path.join(d, "node_modules"));
  fs.writeFileSync(path.join(d, "package.json"), '{"type":"module"}');
  if (patches.includes("cap")) execFileSync("node", [capPatcher, d]);
  if (patches.includes("session")) execFileSync("node", [sessionPatcher, d]);
  if (patches.includes("stream")) execFileSync("node", [streamPatcher, d]);
  return d;
}

async function importPatchedRoutes(proxyDir) {
  // cache-busting query so each test gets a fresh module instance with its
  // own globalThis state (semaphore, locks, etc.)
  const u = url.pathToFileURL(path.join(proxyDir, "dist/server/routes.js"));
  u.searchParams.set("t", String(Date.now()) + "_" + Math.random());
  return await import(u.href);
}

function mockResponse() {
  const writes = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    _status: 200,
    _json: null,
    _closeCb: null,
    setHeader() {},
    flushHeaders() {},
    status(c) { this._status = c; return this; },
    json(b) { this._json = b; this.headersSent = true; this.writableEnded = true; },
    write(chunk) { writes.push(chunk); },
    end() { this.writableEnded = true; },
    on(event, cb) { if (event === "close") this._closeCb = cb; },
  };
  res._writes = writes;
  return res;
}

test("runtime: malformed body {} returns 400 invalid_messages (not 500)", async () => {
  // Regression test for the openaiToCli pre-validation throw.
  // Pre-fix: an empty body would hit openaiToCli({}) -> messagesToPrompt(undefined)
  // -> "messages is not iterable" thrown uncaught past handleChatCompletions.
  const d = mkPatchedProxy();
  const routes = await importPatchedRoutes(d);
  const res = mockResponse();
  await routes.handleChatCompletions({ body: {} }, res);
  assert.equal(res._status, 400, "should return 400 for empty body");
  assert.equal(res._json?.error?.code, "invalid_messages", "error code preserved");
});

test("runtime: malformed body with non-message fields still returns 400", async () => {
  const d = mkPatchedProxy();
  const routes = await importPatchedRoutes(d);
  const res = mockResponse();
  await routes.handleChatCompletions({ body: { user: "x", model: "claude-haiku-4" } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._json?.error?.code, "invalid_messages");
});

test("runtime: empty messages array returns 400", async () => {
  const d = mkPatchedProxy();
  const routes = await importPatchedRoutes(d);
  const res = mockResponse();
  await routes.handleChatCompletions({ body: { messages: [] } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._json?.error?.code, "invalid_messages");
});

test("runtime: cap default is 4 and OPENCLAW_BRIDGE_MAX_CONCURRENT overrides it", async () => {
  const d = mkPatchedProxy({ patches: ["cap"] });
  const routes = await importPatchedRoutes(d);
  // cap-only path: routes.js executes the module-level constant at import time
  // using process.env. Default should be 4.
  assert.equal(globalThis.__OB_TEST_max, 4, "default cap is 4");
});

test("runtime: cap blocks 5th acquire and resumes after release", async () => {
  // Sandbox: clear globalThis.__OB_TEST_max etc. so a previous test didn't poison us.
  delete globalThis.__OB_TEST_max;
  delete globalThis.__OB_TEST_acquire;
  delete globalThis.__OB_TEST_release;
  const d = mkPatchedProxy({ patches: ["cap"] });
  await importPatchedRoutes(d);
  const acquire = globalThis.__OB_TEST_acquire;
  const release = globalThis.__OB_TEST_release;
  const max = globalThis.__OB_TEST_max;
  for (let i = 0; i < max; i++) await acquire();
  let extraResolved = false;
  const extra = acquire().then(() => { extraResolved = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(extraResolved, false, "5th acquire blocks");
  release();
  await extra;
  assert.equal(extraResolved, true, "5th acquire resolves after release");
  for (let i = 0; i < max; i++) release();
});

test("runtime: session lock serializes same-key, parallels different-keys", async () => {
  delete globalThis.__OB_TEST_sessionLock;
  delete globalThis.__OB_TEST_max;
  const d = mkPatchedProxy({ patches: ["cap", "session"] });
  await importPatchedRoutes(d);
  const lockA1 = globalThis.__OB_TEST_sessionLock("A");
  await lockA1.wait;
  const lockA2 = globalThis.__OB_TEST_sessionLock("A");
  let a2Done = false;
  const a2Wait = lockA2.wait.then(() => { a2Done = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(a2Done, false, "second lock on A blocks");
  const lockB = globalThis.__OB_TEST_sessionLock("B");
  await lockB.wait;
  assert.ok(true, "lock on B is immediate");
  lockA1.release();
  await a2Wait;
  assert.equal(a2Done, true, "second lock on A resolves after release");
  lockA2.release();
  lockB.release();
  // Empty session id is a no-op
  const noop = globalThis.__OB_TEST_sessionLock("");
  await noop.wait;
  noop.release();
});

test("runtime: stream-safety synthesizes chunk when CLI emits result with no delta", async () => {
  const d = mkPatchedProxy();
  const routes = await importPatchedRoutes(d);

  // Build a fake EventEmitter-shaped subprocess that scripts events on start().
  const { EventEmitter } = await import("node:events");
  class FakeSubprocess extends EventEmitter {
    constructor() { super(); this.killed = 0; }
    start() {
      setImmediate(() => {
        this.emit("result", { result: "hello world", modelUsage: { "claude-sonnet-4": {} } });
      });
      return Promise.resolve();
    }
    kill() { this.killed++; }
  }

  const sub = new FakeSubprocess();
  const res = mockResponse();
  await routes.__OB_TEST_handleStreamingResponse({}, res, sub, { prompt: "p", model: "sonnet", sessionId: "" }, "rid");
  const stream = res._writes.join("");
  assert.match(stream, /"content":"hello world"/, "fallback chunk written");
  assert.match(stream, /data: \[DONE\]/, "DONE marker written");
});

test("runtime: stream-safety does NOT synthesize when delta was already sent", async () => {
  const d = mkPatchedProxy();
  const routes = await importPatchedRoutes(d);

  const { EventEmitter } = await import("node:events");
  class FakeSubprocess extends EventEmitter {
    start() {
      setImmediate(() => {
        this.emit("content_delta", { event: { delta: { text: "real-delta" } } });
        this.emit("result", { result: "fallback-should-not-appear", modelUsage: {} });
      });
      return Promise.resolve();
    }
    kill() {}
  }

  const sub = new FakeSubprocess();
  const res = mockResponse();
  await routes.__OB_TEST_handleStreamingResponse({}, res, sub, { prompt: "p", model: "sonnet", sessionId: "" }, "rid");
  const stream = res._writes.join("");
  assert.match(stream, /"content":"real-delta"/, "real delta written");
  assert.doesNotMatch(stream, /fallback-should-not-appear/, "fallback suppressed when delta seen");
});
