#!/usr/bin/env node
// Idempotent installer-patcher: scrubs embedded NUL (U+0000) characters
// from prompt + options.systemPrompt at the entry of the proxy subprocess
// manager's buildArgsImpl. Some plugin-supplied system prompts contain
// embedded NULs which crash spawn() with
//   ERR_INVALID_ARG_VALUE: "must be a string without null bytes".
//
// Guarded by the sentinel `@openclaw-bridge:strip-null-bytes v1`
// injected as the first line of the buildArgsImpl body.
//
// Usage: node patch-manager-strip-null-bytes.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:strip-null-bytes v1";

const ANCHOR = "function buildArgsImpl(prompt, options) {\n";

const INJECT =
  `    ${SENTINEL}\n` +
  `    if (typeof prompt === "string" && prompt.indexOf("\\u0000") !== -1) prompt = prompt.replace(/\\u0000/g, "");\n` +
  `    if (options && typeof options.systemPrompt === "string" && options.systemPrompt.indexOf("\\u0000") !== -1) options = { ...options, systemPrompt: options.systemPrompt.replace(/\\u0000/g, "") };\n`;

const REPLACEMENT = ANCHOR + INJECT;

function die(msg, code = 1) {
  console.error(`patch-manager-strip-null-bytes: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-manager-strip-null-bytes.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const managerPath = path.join(proxyRoot, "dist", "subprocess", "manager.js");
if (!fs.existsSync(managerPath)) die(`expected file not found: ${managerPath}`);

const orig = fs.readFileSync(managerPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);

let updated = orig;
if (!alreadyPatched) {
  if (!orig.includes(ANCHOR)) die("manager.js buildArgsImpl anchor changed — upstream renamed/reformatted");
  updated = orig.replace(ANCHOR, REPLACEMENT);
}

if (dryRun) {
  console.log(`patch-manager-strip-null-bytes: dry-run against ${proxyRoot}`);
  console.log(`  manager.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(managerPath, updated);

console.log(`patch-manager-strip-null-bytes:`);
console.log(`  manager.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
