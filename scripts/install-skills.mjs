#!/usr/bin/env node
// Install vendored superpowers skills from skills/superpowers/<name>/
// into ~/.openclaw/skills/<name>/ on this machine.
//
// Idempotent: copies files only if the destination differs from the source.
// Skips top-level non-skill files (LICENSE, README.md, VENDOR.md).
//
// Honors --dry-run.
//
// Usage:
//   node install-skills.mjs [--bridge-root <path>] [--openclaw-home <path>] [--dry-run]
//
// Defaults:
//   --bridge-root: parent dir of this script's dir
//   --openclaw-home: $HOME/.openclaw

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const dryRun = process.argv.includes("--dry-run");
const here = path.dirname(url.fileURLToPath(import.meta.url));
const bridgeRoot = arg("--bridge-root", path.resolve(here, ".."));
const ocHome = arg("--openclaw-home", path.join(process.env.HOME || "", ".openclaw"));

const src = path.join(bridgeRoot, "skills", "superpowers");
if (!fs.existsSync(src)) {
  console.error(`install-skills: source not found: ${src}`);
  process.exit(1);
}

const destBase = path.join(ocHome, "skills");

let installed = 0, updated = 0, skipped = 0;

for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue; // skip LICENSE, README.md, VENDOR.md
  const skillDir = path.join(src, entry.name);
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMd)) continue; // not a skill folder
  const destDir = path.join(destBase, entry.name);
  const destSkillMd = path.join(destDir, "SKILL.md");

  let action = "install";
  if (fs.existsSync(destSkillMd)) {
    if (fs.readFileSync(skillMd).equals(fs.readFileSync(destSkillMd))) {
      action = "skip";
    } else {
      action = "update";
    }
  }

  if (dryRun) {
    console.log(`install-skills: WOULD install ${entry.name} (${action})`);
    if (action !== "skip") (action === "update" ? updated++ : installed++);
    else skipped++;
    continue;
  }

  if (action !== "skip") {
    fs.mkdirSync(destDir, { recursive: true });
    // Copy whole skill dir tree (skill might have references/, etc.).
    fs.cpSync(skillDir, destDir, { recursive: true, force: true });
    console.log(`install-skills: ${action === "update" ? "updated" : "installed"} ${entry.name}`);
    if (action === "update") updated++;
    else installed++;
  } else {
    skipped++;
  }
}

console.log(`install-skills: ${installed} installed, ${updated} updated, ${skipped} unchanged`);
