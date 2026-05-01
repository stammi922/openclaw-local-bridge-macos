#!/usr/bin/env node
// One-off vendor tool: copies a curated subset of obra/superpowers' skills
// from a local clone into skills/superpowers/ in this bridge repo, applying
// mechanical fix-ups for tool-name renames and dropping the four meta-skills
// that are tightly coupled to Claude Code's tool inventory.
//
// Maintainer flow:
//   git clone --depth 1 --branch main https://github.com/obra/superpowers.git /tmp/sp
//   node scripts/vendor-superpowers.mjs --upstream-clone /tmp/sp
//   git diff skills/superpowers/   # review the bump
//   git add skills/superpowers/ && git commit -m "vendor: bump superpowers to <sha>"
//
// Idempotent: re-running on already-vendored content produces byte-identical
// SKILL.md files (mechanical fix-ups have already been applied; second pass
// finds nothing new to replace).
//
// Usage:
//   node vendor-superpowers.mjs --upstream-clone <path> [--bridge-root <path>]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { spawnSync } from "node:child_process";

// 10 methodology skills we vendor. The 4 meta-skills (using-superpowers,
// dispatching-parallel-agents, subagent-driven-development, using-git-worktrees)
// are intentionally excluded — they reference Claude Code tools openclaw lacks.
const KEEP = [
  "brainstorming",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

// Mechanical fix-ups applied to skill bodies. Targeted patterns only — no
// structural rewrites. The script must remain idempotent: each replacement
// must produce a string that the same replacement would not match again.
const FIXUPS = [
  { from: /\bthe Skill tool\b/g, to: "the openclaw skill loader" },
  { from: / Skill tool /g, to: " openclaw skill loader " },
  { from: /\bsuperpowers:([a-z][a-z0-9-]+)\b/g, to: "$1" },
  { from: /\bBash tool\b/g, to: "exec tool" },
];

function die(msg, code = 1) {
  console.error(`vendor-superpowers: ${msg}`);
  process.exit(code);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const upstreamClone = arg("--upstream-clone");
const bridgeRoot = arg("--bridge-root", path.resolve(here, ".."));

if (!upstreamClone) die("usage: vendor-superpowers.mjs --upstream-clone <path> [--bridge-root <path>]", 2);
if (!fs.existsSync(upstreamClone)) die(`upstream clone not found: ${upstreamClone}`);

const upstreamSkillsDir = path.join(upstreamClone, "skills");
if (!fs.existsSync(upstreamSkillsDir)) die(`no skills/ dir in upstream clone: ${upstreamSkillsDir}`);

const upstreamLicense = path.join(upstreamClone, "LICENSE");
if (!fs.existsSync(upstreamLicense)) die(`no LICENSE in upstream clone: ${upstreamLicense}`);

// Read upstream commit SHA (the script doesn't try to be clever about dirty
// trees; the maintainer is expected to run from a clean clone).
const shaResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstreamClone, encoding: "utf8" });
if (shaResult.error || shaResult.status !== 0) {
  die(`git rev-parse failed in ${upstreamClone}: ${shaResult.error?.message ?? shaResult.stderr?.trim() ?? "unknown"}`);
}
const sha = (shaResult.stdout ?? "").trim();
if (!/^[0-9a-f]{40}$/.test(sha)) die(`failed to read upstream HEAD SHA from ${upstreamClone}`);

const dest = path.join(bridgeRoot, "skills", "superpowers");
fs.mkdirSync(dest, { recursive: true });

// Copy LICENSE verbatim.
fs.copyFileSync(upstreamLicense, path.join(dest, "LICENSE"));

// Copy each kept skill, applying fix-ups to SKILL.md only.
for (const skill of KEEP) {
  const src = path.join(upstreamSkillsDir, skill);
  if (!fs.existsSync(src)) {
    console.warn(`vendor-superpowers: WARNING upstream missing skill ${skill} — skipping`);
    continue;
  }
  const target = path.join(dest, skill);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcFile = path.join(src, entry.name);
    const destFile = path.join(target, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      let body = fs.readFileSync(srcFile, "utf8");
      for (const { from, to } of FIXUPS) body = body.replace(from, to);
      fs.writeFileSync(destFile, body);
    } else if (entry.isDirectory()) {
      // Recursively copy any subdirs (some skills have references/, fixtures/).
      fs.cpSync(srcFile, destFile, { recursive: true, dereference: false });
    } else if (entry.isFile()) {
      fs.copyFileSync(srcFile, destFile);
    }
  }
  console.log(`vendor-superpowers: ${skill} copied`);
}

// Write VENDOR.md (machine-readable: SHA on first non-comment line).
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(dest, "VENDOR.md"),
  `${sha}\n${today}\n\n# vendored from obra/superpowers @ ${sha} on ${today}\n`);

// Write README.md (attribution + sync recipe).
fs.writeFileSync(path.join(dest, "README.md"),
  `# Superpowers (vendored subset)\n\n` +
  `This directory is a curated, mechanically fix-upped vendor of skills from\n` +
  `https://github.com/obra/superpowers — pinned at the SHA in \`VENDOR.md\`.\n\n` +
  `## What is included\n\n` +
  `${KEEP.map(s => `- ${s}`).join("\n")}\n\n` +
  `## What is excluded\n\n` +
  `The four meta-skills that reference Claude Code's tool inventory directly\n` +
  `(\`using-superpowers\`, \`dispatching-parallel-agents\`,\n` +
  `\`subagent-driven-development\`, \`using-git-worktrees\`) are intentionally\n` +
  `not vendored. See \`docs/superpowers/specs/2026-05-01-openclaw-orchestration-control-design.md\`.\n\n` +
  `## Sync from upstream\n\n` +
  "```bash\n" +
  `# run from the openclaw-local-bridge-macos repo root\n` +
  `git clone --depth 1 --branch main https://github.com/obra/superpowers.git /tmp/sp\n` +
  `node scripts/vendor-superpowers.mjs --upstream-clone /tmp/sp\n` +
  `git diff skills/superpowers/\n` +
  "```\n");

console.log(`vendor-superpowers: done (sha=${sha.slice(0, 7)}, ${KEEP.length} skills vendored)`);
