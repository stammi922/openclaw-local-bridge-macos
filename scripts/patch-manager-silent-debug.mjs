#!/usr/bin/env node
// Idempotent installer-patcher: gates the proxy subprocess manager's
// chunk-level debug logging behind OPENCLAW_BRIDGE_DEBUG=1. Upstream
// logs `[Subprocess] Received N bytes of stdout` for every chunk
// streamed back from the claude CLI, which on a busy host dominates
// the err log (millions of lines, tens of MB). The spawn/close debug
// lines are gated the same way for consistency.
//
// Guarded by the sentinel `@openclaw-bridge:silent-debug v1` prepended
// to manager.js.
//
// Usage: node patch-manager-silent-debug.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:silent-debug v1";

const GUARD = `if (process.env.OPENCLAW_BRIDGE_DEBUG === "1") `;

const REWRITES = [
  {
    from: "console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);",
    to:   `${GUARD}console.error(\`[Subprocess] Process spawned with PID: \${this.process.pid}\`);`,
  },
  {
    from: "console.error(`[Subprocess] Received ${data.length} bytes of stdout`);",
    to:   `${GUARD}console.error(\`[Subprocess] Received \${data.length} bytes of stdout\`);`,
  },
  {
    from: "console.error(`[Subprocess] Process closed with code: ${code}`);",
    to:   `${GUARD}console.error(\`[Subprocess] Process closed with code: \${code}\`);`,
  },
];

function die(msg, code = 1) {
  console.error(`patch-manager-silent-debug: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-manager-silent-debug.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const managerPath = path.join(proxyRoot, "dist", "subprocess", "manager.js");
if (!fs.existsSync(managerPath)) die(`expected file not found: ${managerPath}`);

const orig = fs.readFileSync(managerPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);

let updated = orig;
if (!alreadyPatched) {
  for (const { from, to } of REWRITES) {
    if (!updated.includes(from)) die(`manager.js anchor not found: ${from.slice(0, 80)}…`);
    updated = updated.replace(from, to);
  }
  updated = `${SENTINEL}\n${updated}`;
}

if (dryRun) {
  console.log(`patch-manager-silent-debug: dry-run against ${proxyRoot}`);
  console.log(`  manager.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(managerPath, updated);

console.log(`patch-manager-silent-debug:`);
console.log(`  manager.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
