#!/usr/bin/env node
// Merge "permissions.allow": ["Bash(*)", "mcp__*"] into ~/.claude/settings.json.
// Opt-in only — caller must have user consent before invoking this.
//
// Idempotent. Preserves all other keys. Creates the file if missing.
//
// Usage: node patch-claude-settings.mjs [--dry-run]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const dryRun = process.argv.includes("--dry-run");
const target = path.join(os.homedir(), ".claude", "settings.json");
const REQUIRED = ["Bash(*)", "mcp__*"];

let settings;
let existed = fs.existsSync(target);
if (existed) {
  try {
    settings = JSON.parse(fs.readFileSync(target, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new Error("settings.json is not a JSON object");
    }
  } catch (e) {
    console.error(`claude settings: cannot parse ${target}: ${e.message}`);
    console.error("Refusing to overwrite — please fix or move it and re-run.");
    process.exit(1);
  }
} else {
  settings = {};
}

settings.permissions ??= {};
const existingAllow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];

// Union, preserving order: existing entries first, then any required entries
// that are missing.
const set = new Set(existingAllow);
const additions = REQUIRED.filter((r) => !set.has(r));
const merged = [...existingAllow, ...additions];

if (additions.length === 0) {
  console.log(`claude settings: already contains required entries (${REQUIRED.join(", ")}) — no change`);
  process.exit(0);
}

settings.permissions.allow = merged;

if (dryRun) {
  console.log(`claude settings: dry-run — would ${existed ? "update" : "create"} ${target}`);
  console.log(`  + permissions.allow += [${additions.map((a) => JSON.stringify(a)).join(", ")}]`);
  console.log(`  resulting allow list (${merged.length} entries): ${JSON.stringify(merged)}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");
console.log(
  `claude settings: ${existed ? "updated" : "created"} ${target} — allow list now has ${merged.length} entries (+${additions.length} added, ${existingAllow.length} preserved)`,
);
