#!/usr/bin/env node
// Patch the openclaw gateway plist so it plays nicely with this bridge:
//   1. EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT=cli
//   2. WorkingDirectory=$HOME — openclaw's `openclaw.json` uses a relative
//      `agentDir`, which resolves to `/agents/main` under launchd (cwd=/)
//      and explodes with ENOENT on every agent turn. openclaw's own
//      installer does not render this key, so the update that restarts
//      the daemon also breaks the bridge. Run this script after every
//      `openclaw update` to restore it.
// Both patches are idempotent: skips if already at the desired value.
//
// Usage: node patch-gateway-plist.mjs <plist path> [--dry-run]
// Reads HOME from the environment for the WorkingDirectory value.

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

const home = process.env.HOME;
if (!home) {
  console.error("patch-gateway-plist: HOME is unset; cannot set WorkingDirectory");
  process.exit(2);
}

function plutil(...argv) {
  return spawnSync("plutil", argv, { encoding: "utf8" });
}

function ensureString(keyPath, desired, label) {
  const extract = plutil("-extract", keyPath, "raw", target);
  let action;
  if (extract.status === 0) {
    const current = extract.stdout.trim();
    if (current === desired) {
      console.log(`gateway plist: ${label}=${desired} already set — no change`);
      return;
    }
    action = "replace";
  } else {
    action = "insert";
  }

  if (dryRun) {
    console.log(`gateway plist: dry-run — would ${action} ${label}=${desired} in ${target}`);
    return;
  }

  let mut = plutil(`-${action}`, keyPath, "-string", desired, target);
  if (mut.status !== 0 && action === "insert") {
    // Edge case: the parent dict may not exist yet — fall back to replace,
    // which creates the key at top level.
    mut = plutil("-replace", keyPath, "-string", desired, target);
  }
  if (mut.status !== 0) {
    console.error(`gateway plist: plutil failed for ${label}: ${mut.stderr.trim()}`);
    process.exit(1);
  }
  console.log(`gateway plist: set ${label}=${desired} in ${target}`);
}

ensureString("EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT", "cli", "EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT");
ensureString("WorkingDirectory", home, "WorkingDirectory");
