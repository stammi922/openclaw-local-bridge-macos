// Smoke harness: imports the patched routes.js from a tempdir given as arg,
// asserts semaphore + session-lock + streaming behavior. Exits non-zero on fail.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeSubprocess } from "./fake-subprocess.mjs";

const tempDir = process.argv[2];
if (!tempDir) { console.error("usage: smoke.mjs <tempdir>"); process.exit(2); }

const routesUrl = pathToFileURL(path.join(tempDir, "dist/server/routes.js")).href;
const routes = await import(routesUrl);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); failures++; }
}

// --- 1. Semaphore exposes acquire/release helpers (introspection via global)
check("concurrency-cap symbols exported on globalThis",
  typeof globalThis.__OB_TEST_acquire === "function" &&
  typeof globalThis.__OB_TEST_release === "function" &&
  typeof globalThis.__OB_TEST_max === "number",
  `acquire=${typeof globalThis.__OB_TEST_acquire} max=${globalThis.__OB_TEST_max}`);

// --- 2. Default cap is 4 (or whatever OPENCLAW_BRIDGE_MAX_CONCURRENT was set to)
const expectedMax = parseInt(process.env.OPENCLAW_BRIDGE_MAX_CONCURRENT || "4", 10);
check("max equals env default", globalThis.__OB_TEST_max === expectedMax,
  `expected=${expectedMax} actual=${globalThis.__OB_TEST_max}`);

// --- 3. Semaphore queues requests beyond cap
{
  const max = globalThis.__OB_TEST_max;
  for (let i = 0; i < max; i++) await globalThis.__OB_TEST_acquire();
  let extraResolved = false;
  const extra = globalThis.__OB_TEST_acquire().then(() => { extraResolved = true; });
  await new Promise((r) => setImmediate(r));
  check("extra acquire blocks when cap reached", !extraResolved);
  globalThis.__OB_TEST_release();
  await extra;
  check("extra acquire resolves after release", extraResolved);
  // release the rest (we still hold max - 1 + 1 = max permits)
  for (let i = 0; i < max; i++) globalThis.__OB_TEST_release();
}

// --- 4. Session lock serializes same key, parallels different keys
{
  const lockA1 = globalThis.__OB_TEST_sessionLock("A");
  await lockA1.wait;
  const lockA2 = globalThis.__OB_TEST_sessionLock("A");
  let a2Done = false;
  const a2Wait = lockA2.wait.then(() => { a2Done = true; });
  await new Promise((r) => setImmediate(r));
  check("second lock on same session blocks", !a2Done);
  const lockB = globalThis.__OB_TEST_sessionLock("B");
  await lockB.wait; // should be immediate
  check("lock on different session does not block", true);
  lockA1.release();
  await a2Wait;
  check("second lock resolves after first releases", a2Done);
  lockA2.release();
  lockB.release();
}

// --- 5. Empty sessionId is a no-op lock
{
  const lock = globalThis.__OB_TEST_sessionLock("");
  await lock.wait;
  check("empty sessionId returns immediate lock", true);
  lock.release();
}

// --- 6. Streaming handler emits result.result when no content_delta seen
{
  const sub = new FakeSubprocess();
  sub.script([
    { type: "result", payload: { result: "hello world", modelUsage: { "claude-sonnet-4": {} } } },
  ]);
  const fakeReq = {};
  const writes = [];
  let ended = false;
  let closeCb = null;
  const fakeRes = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk) { writes.push(chunk); },
    end() { ended = true; this.writableEnded = true; },
    on(event, cb) { if (event === "close") closeCb = cb; },
  };
  await routes.__OB_TEST_handleStreamingResponse(fakeReq, fakeRes, sub, { prompt: "p", model: "sonnet", sessionId: "" }, "reqid");
  const data = writes.join("");
  check("emits a content chunk for empty-result fallback",
    data.includes('"content":"hello world"'),
    `writes=${JSON.stringify(writes)}`);
  check("emits [DONE]", data.includes("data: [DONE]"));
  check("calls res.end()", ended);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall smoke checks passed");
