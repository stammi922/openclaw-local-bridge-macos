#!/usr/bin/env node
// Idempotent installer-patcher: serializes requests sharing the same
// OpenAI `user` field. The upstream proxy passes `body.user` straight
// through to `claude --session-id`, so two concurrent calls with the
// same `user` value spawn two `claude` children competing on the same
// session id — undefined CLI behavior, possible context mixing.
//
// This patch installs a per-sessionId mutex and acquires it inside the
// concurrency-cap wrapper (which must be applied first). Empty/missing
// sessionId is a no-op lock, preserving today's behavior for callers
// that don't set `user`.
//
// Guarded by the sentinel `@openclaw-bridge:session-serialize v1`.
// Requires `@openclaw-bridge:concurrency-cap v1` to be installed first.
//
// Usage: node patch-routes-session-serialize.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:session-serialize v1";
const CAP_SENTINEL = "// @openclaw-bridge:concurrency-cap v1";

const MODULE_ANCHOR = "globalThis.__OB_TEST_max = __OB_MAX;\n";

const MODULE_BLOCK = `
${SENTINEL}
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
`;

// concurrency-cap leaves this exact opening shape; we replace it with one
// that takes the session lock between cap acquire and the rest of the body.
const CAP_OPEN_ANCHOR = "await __obAcquire();\n    try {";

const CAP_OPEN_REPLACEMENT =
  `await __obAcquire();
    let __obLock = { release: () => {} };
    try {
        const __obCli = openaiToCli(req.body || {});
        __obLock = __obSessionLock(__obCli && __obCli.sessionId);
        await __obLock.wait;
        try {`;

const CAP_CLOSE_ANCHOR = "    } finally { __obRelease(); }";

const CAP_CLOSE_REPLACEMENT =
  `    } finally { __obLock.release(); }\n    } finally { __obRelease(); }`;

function die(msg, code = 1) {
  console.error(`patch-routes-session-serialize: ${msg}`);
  process.exit(code);
}

function patch(src) {
  if (src.includes(SENTINEL)) return src;
  if (!src.includes(CAP_SENTINEL)) {
    die("concurrency-cap patch is required before session-serialize (anchor depends on it). Run patch-routes-concurrency-cap.mjs first.");
  }

  // 1. Insert module-level block right after concurrency-cap's last line.
  const modIdx = src.indexOf(MODULE_ANCHOR);
  if (modIdx === -1) die("module anchor not found (expected concurrency-cap module-block tail)");
  let out = src.slice(0, modIdx + MODULE_ANCHOR.length) + MODULE_BLOCK + src.slice(modIdx + MODULE_ANCHOR.length);

  // 2. Inject session lock acquisition inside the try block of handleChatCompletions.
  if (!out.includes(CAP_OPEN_ANCHOR)) die("anchor not found: cap acquire+try (concurrency-cap not in expected shape)");
  out = out.replace(CAP_OPEN_ANCHOR, CAP_OPEN_REPLACEMENT);

  // 3. Close the inner try with its own finally before the outer finally.
  if (!out.includes(CAP_CLOSE_ANCHOR)) die("anchor not found: cap finally (concurrency-cap not in expected shape)");
  out = out.replace(CAP_CLOSE_ANCHOR, CAP_CLOSE_REPLACEMENT);

  return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-routes-session-serialize.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const routesPath = path.join(proxyRoot, "dist", "server", "routes.js");
if (!fs.existsSync(routesPath)) die(`expected file not found: ${routesPath}`);

const orig = fs.readFileSync(routesPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);
const updated = alreadyPatched ? orig : patch(orig);

if (dryRun) {
  console.log(`patch-routes-session-serialize: dry-run against ${proxyRoot}`);
  console.log(`  routes.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(routesPath, updated);

console.log(`patch-routes-session-serialize:`);
console.log(`  routes.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
