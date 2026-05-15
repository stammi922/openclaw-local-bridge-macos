#!/usr/bin/env node
// Idempotent installer-patcher: bounds the number of parallel claude
// subprocesses the proxy will run. Without this, an OpenClaw burst can
// spawn N parallel `claude` children (each ~150-300MB RSS, full Node +
// agent bootstrap) and pin the gateway's event loop at 100% CPU.
//
// Adds a module-level semaphore + wraps handleChatCompletions in
// `await __obAcquire(); try { ... } finally { __obRelease(); }`.
// Default cap 4; override via OPENCLAW_BRIDGE_MAX_CONCURRENT in the
// proxy launchd plist environment.
//
// Guarded by the sentinel `@openclaw-bridge:concurrency-cap v1`.
//
// Usage: node patch-routes-concurrency-cap.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:concurrency-cap v1";

const LAST_IMPORT_ANCHOR = `import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";`;

const MODULE_BLOCK = `
${SENTINEL}
const __OB_MAX = Math.max(1, parseInt(process.env.OPENCLAW_BRIDGE_MAX_CONCURRENT || "4", 10));
let __OB_active = 0;
const __OB_waiters = [];
function __obAcquire() {
  if (__OB_active < __OB_MAX) { __OB_active++; return Promise.resolve(); }
  return new Promise((resolve) => __OB_waiters.push(() => { __OB_active++; resolve(); }));
}
function __obRelease() {
  __OB_active--;
  const next = __OB_waiters.shift();
  if (next) next();
}
globalThis.__OB_TEST_acquire = __obAcquire;
globalThis.__OB_TEST_release = __obRelease;
globalThis.__OB_TEST_max = __OB_MAX;
`;

const FN_SIGNATURE = "export async function handleChatCompletions(req, res) {";

function die(msg, code = 1) {
  console.error(`patch-routes-concurrency-cap: ${msg}`);
  process.exit(code);
}

// Find the index of the `}` that closes a function whose opening `{` is at
// the last character of `signature` starting at index `sigStart`. Counts
// brace depth from there. Returns -1 if no match.
function findMatchingClose(src, sigStart, signature) {
  let depth = 0;
  for (let i = sigStart + signature.length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function patch(src) {
  if (src.includes(SENTINEL)) return src;

  // 1. Insert module-level block after the last import.
  const importIdx = src.indexOf(LAST_IMPORT_ANCHOR);
  if (importIdx === -1) die(`routes.js anchor not found: last import line`);
  const afterImport = importIdx + LAST_IMPORT_ANCHOR.length;
  let out = src.slice(0, afterImport) + "\n" + MODULE_BLOCK + src.slice(afterImport);

  // 2. Wrap handleChatCompletions body with acquire/try/finally release.
  const sigIdx = out.indexOf(FN_SIGNATURE);
  if (sigIdx === -1) die(`routes.js anchor not found: ${FN_SIGNATURE}`);
  const closeIdx = findMatchingClose(out, sigIdx, FN_SIGNATURE);
  if (closeIdx === -1) die(`could not find matching brace for handleChatCompletions`);

  const before = out.slice(0, sigIdx + FN_SIGNATURE.length);
  const body = out.slice(sigIdx + FN_SIGNATURE.length, closeIdx);
  const after = out.slice(closeIdx);
  out = before + "\n    await __obAcquire();\n    try {" + body + "    } finally { __obRelease(); }\n" + after;

  return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-routes-concurrency-cap.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const routesPath = path.join(proxyRoot, "dist", "server", "routes.js");
if (!fs.existsSync(routesPath)) die(`expected file not found: ${routesPath}`);

const orig = fs.readFileSync(routesPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);
const updated = alreadyPatched ? orig : patch(orig);

if (dryRun) {
  console.log(`patch-routes-concurrency-cap: dry-run against ${proxyRoot}`);
  console.log(`  routes.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(routesPath, updated);

console.log(`patch-routes-concurrency-cap:`);
console.log(`  routes.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
