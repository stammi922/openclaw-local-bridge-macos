#!/usr/bin/env node
// Idempotent installer-patcher: bumps the claude-max-api-proxy subprocess
// timeout from upstream's 5-minute wall-clock cap to 2 hours. Long Claude
// turns (extended thinking, plan generation, multi-tool workflows) routinely
// exceed 5 min and were getting SIGTERM'd mid-stream — see
// project_openclaw_bridge memory and gateway.err.log incident 2026-04-24.
// Guarded by the sentinel `@openclaw-bridge:timeout v1`.
//
// Usage: node patch-proxy-timeout.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:timeout v1";

const ANCHOR = `const DEFAULT_TIMEOUT = 300000; // 5 minutes`;
const REPLACEMENT = `${SENTINEL}
const DEFAULT_TIMEOUT = 7200000; // 2 hours — long-running plans/tool turns can exceed 30 min`;

function die(msg, code = 1) {
  console.error(`patch-proxy-timeout: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-timeout.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const managerPath = path.join(proxyRoot, "dist", "subprocess", "manager.js");
if (!fs.existsSync(managerPath)) die(`expected file not found: ${managerPath}`);

const managerOrig = fs.readFileSync(managerPath, "utf8");
const alreadyPatched = managerOrig.includes(SENTINEL);

let managerUpdated = managerOrig;
if (!alreadyPatched) {
  if (!managerOrig.includes(ANCHOR)) die("manager.js DEFAULT_TIMEOUT anchor changed — upstream bumped; update patch-proxy-timeout.mjs");
  managerUpdated = managerOrig.replace(ANCHOR, REPLACEMENT);
}

if (dryRun) {
  console.log(`patch-proxy-timeout: dry-run against ${proxyRoot}`);
  console.log(`  manager.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(managerPath, managerUpdated);

console.log(`patch-proxy-timeout:`);
console.log(`  manager.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
