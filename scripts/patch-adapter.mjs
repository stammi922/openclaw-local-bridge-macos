#!/usr/bin/env node
// Patches claude-max-api-proxy's openai-to-cli.js adapter so OpenClaw's
// array-typed `content` (e.g. [{type:"text",text:"..."}]) is unwrapped
// before being interpolated into the CLI prompt template.
//
// Idempotent: re-runs are no-ops thanks to a sentinel comment.
//
// Usage: node patch-adapter.mjs <path-to-openai-to-cli.js> [--dry-run]

import fs from "node:fs";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:extractContent v1";
const HELPER = `${SENTINEL}
function extractContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (p && p.type === "text" && typeof p.text === "string") ? p.text : "").filter(Boolean).join("\\n");
  return String(c == null ? "" : c);
}
`;

const REWRITES = [
  // Each entry: from (literal substring), to (literal substring).
  {
    from: "`<system>\\n${msg.content}\\n</system>\\n`",
    to:   "`<system>\\n${extractContent(msg.content)}\\n</system>\\n`",
  },
  {
    from: "parts.push(msg.content)",
    to:   "parts.push(extractContent(msg.content))",
  },
  {
    from: "`<previous_response>\\n${msg.content}\\n</previous_response>\\n`",
    to:   "`<previous_response>\\n${extractContent(msg.content)}\\n</previous_response>\\n`",
  },
];

const ANCHOR = "export function messagesToPrompt(";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!target) {
  console.error("usage: patch-adapter.mjs <path> [--dry-run]");
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`adapter file not found: ${target}`);
  process.exit(1);
}

const original = fs.readFileSync(target, "utf8");

if (original.includes(SENTINEL)) {
  console.log(`adapter: already patched (sentinel "${SENTINEL}" present) — no change`);
  process.exit(0);
}

if (!original.includes(ANCHOR)) {
  console.error(`adapter: anchor not found ("${ANCHOR}"). Upstream may have changed shape.`);
  process.exit(1);
}

let updated = original.replace(ANCHOR, HELPER + ANCHOR);

for (const { from, to } of REWRITES) {
  if (!updated.includes(from)) {
    console.error(`adapter: expected snippet not found: ${from}`);
    console.error("Upstream changed; refusing to patch a partial adapter.");
    process.exit(1);
  }
  updated = updated.replace(from, to);
}

if (dryRun) {
  console.log("adapter: dry-run — would write the following changes:");
  console.log(`  + helper inserted before "${ANCHOR}"`);
  for (const { from, to } of REWRITES) {
    console.log(`  - ${from}`);
    console.log(`  + ${to}`);
  }
  process.exit(0);
}

fs.writeFileSync(target, updated);
console.log(`adapter: patched ${target}`);
