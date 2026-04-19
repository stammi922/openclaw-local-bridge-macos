#!/usr/bin/env node
// Add CLAUDE_CODE_ENTRYPOINT=cli to the gateway plist's
// EnvironmentVariables dict, using plutil (no XML regex).
// Idempotent: skips if already present with the right value.
//
// Usage: node patch-gateway-plist.mjs <plist path> [--dry-run]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!target) {
  console.error("usage: patch-gateway-plist.mjs <path> [--dry-run]");
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.log(`gateway plist not found at ${target} — skipping (this is fine if you don't run openclaw as a launchd service).`);
  process.exit(0);
}

const KEY_PATH = "EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT";
const DESIRED = "cli";

function plutil(...argv) {
  return spawnSync("plutil", argv, { encoding: "utf8" });
}

// Read current value (if any).
const extract = plutil("-extract", KEY_PATH, "raw", target);
let action;
if (extract.status === 0) {
  const current = extract.stdout.trim();
  if (current === DESIRED) {
    console.log(`gateway plist: ${KEY_PATH}=${DESIRED} already set — no change`);
    process.exit(0);
  }
  action = "replace";
} else {
  // Either the key is missing (most common) or extract failed for another
  // reason. We try insert; if that also fails, surface the error.
  action = "insert";
}

if (dryRun) {
  console.log(`gateway plist: dry-run — would ${action} ${KEY_PATH}=${DESIRED} in ${target}`);
  process.exit(0);
}

let mut = plutil(`-${action}`, KEY_PATH, "-string", DESIRED, target);
if (mut.status !== 0 && action === "insert") {
  // Edge case: dict not yet present at all → insert nests automatically on
  // recent macOS, but if the parent dict is missing we may need to create it.
  // Try replace as a fallback.
  mut = plutil("-replace", KEY_PATH, "-string", DESIRED, target);
}
if (mut.status !== 0) {
  console.error(`gateway plist: plutil failed: ${mut.stderr.trim()}`);
  process.exit(1);
}

console.log(`gateway plist: set ${KEY_PATH}=${DESIRED} in ${target}`);
