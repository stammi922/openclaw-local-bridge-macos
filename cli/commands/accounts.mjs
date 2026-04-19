#!/usr/bin/env node
// openclaw-bridge accounts {list|add|rm|test} <label>

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import {
  ROOT, loadRegistry, saveRegistry, loadState, saveState,
  die, healthOf,
} from "./_common.mjs";

const sub = process.argv[2];
const label = process.argv[3];

if (!sub) die("usage: openclaw-bridge accounts <list|add|rm|test> [label]", 2);

switch (sub) {
  case "list": await cmdList(); break;
  case "add":  await cmdAdd(label); break;
  case "rm":   await cmdRm(label); break;
  case "test": await cmdTest(label); break;
  default: die(`unknown accounts subcommand: ${sub}`, 2);
}

async function cmdList() {
  const reg = loadRegistry();
  const state = loadState();
  if (reg.accounts.length === 0) {
    console.log("(no accounts registered)");
    console.log(`mode: ${reg.mode}`);
    return;
  }
  console.log(`mode: ${reg.mode}`);
  console.log("");
  const rows = [["LABEL", "HEALTH", "IN_FLIGHT", "OK", "RATE", "USAGE", "AUTH", "OTHER", "LAST_USED"]];
  for (const a of reg.accounts) {
    const s = state.accounts?.[a.label] ?? {};
    const c = s.counters ?? {};
    rows.push([
      a.label,
      healthOf(state, a.label),
      String(s.in_flight ?? 0),
      String(c.ok ?? 0),
      String(c.rate_limit ?? 0),
      String(c.usage_limit ?? 0),
      String(c.auth ?? 0),
      String(c.other ?? 0),
      s.last_used ?? "-",
    ]);
  }
  printTable(rows);
}

async function cmdAdd(lbl) {
  if (!lbl) die("usage: openclaw-bridge accounts add <label>", 2);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(lbl)) {
    die(`invalid label: ${lbl} (must match [a-z0-9][a-z0-9_-]{0,31})`);
  }
  const reg = loadRegistry();
  if (reg.accounts.some((a) => a.label === lbl)) {
    die(`label already registered: ${lbl}`);
  }
  const configDir = path.join(ROOT, lbl, "config");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  console.log(`\n→ Logging into Claude with CLAUDE_CONFIG_DIR=${configDir}`);
  console.log(`  Complete the browser OAuth flow; this command returns when 'claude login' exits.\n`);

  const child = spawn("claude", ["login"], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) die(`'claude login' exited with code ${code} — account not added.`);

  const credsFile = path.join(configDir, ".credentials.json");
  if (!fs.existsSync(credsFile)) {
    console.warn(`warning: ${credsFile} not found. On macOS the CLI may store tokens in the Keychain
         under a service keyed by this config dir — that's OK; ignore this warning if subsequent
         'accounts test ${lbl}' succeeds.`);
  }

  reg.accounts.push({ label: lbl, configDir });
  saveRegistry(reg);
  console.log(`✓ Account '${lbl}' registered.`);
  console.log(`  Next: openclaw-bridge accounts test ${lbl}`);
  if (reg.mode !== "multi") {
    console.log(`  Note: mode is currently '${reg.mode}'. Flip it with: openclaw-bridge mode set multi`);
  }
}

async function cmdRm(lbl) {
  if (!lbl) die("usage: openclaw-bridge accounts rm <label>", 2);
  const purge = process.argv.includes("--purge");
  const reg = loadRegistry();
  const idx = reg.accounts.findIndex((a) => a.label === lbl);
  if (idx < 0) die(`no such label: ${lbl}`);
  const acct = reg.accounts[idx];

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const extra = purge ? ` AND delete ${acct.configDir} (credentials will be lost)` : "";
    const ans = await new Promise((r) => rl.question(`Remove '${lbl}' from registry${extra}? [y/N] `, r));
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) die("aborted.");
  }

  reg.accounts.splice(idx, 1);
  saveRegistry(reg);

  const state = loadState();
  if (state.accounts?.[lbl]) {
    delete state.accounts[lbl];
    if (state.lastMainLabel === lbl) state.lastMainLabel = null;
    saveState(state);
  }

  if (purge && acct.configDir && fs.existsSync(acct.configDir)) {
    fs.rmSync(acct.configDir, { recursive: true, force: true });
    console.log(`✓ removed registry entry and purged ${acct.configDir}`);
  } else {
    console.log(`✓ removed registry entry for '${lbl}' (config dir kept; pass --purge to delete it)`);
  }
}

async function cmdTest(lbl) {
  if (!lbl) die("usage: openclaw-bridge accounts test <label>", 2);
  const reg = loadRegistry();
  const acct = reg.accounts.find((a) => a.label === lbl);
  if (!acct) die(`no such label: ${lbl}`);

  console.log(`→ Running a 1-token probe via ${lbl} (CLAUDE_CONFIG_DIR=${acct.configDir}) ...`);
  const r = spawnSync("claude", ["--print", "--model", "claude-haiku-4", "--no-session-persistence", "say hi in one word"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: acct.configDir },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  const stdout = (r.stdout ?? "").toString().trim();
  const stderr = (r.stderr ?? "").toString().trim();
  if (r.status === 0) {
    console.log(`✓ ${lbl}: ok`);
    if (stdout) console.log(`  reply: ${stdout.slice(0, 120)}`);
    // Clear stale cooling state since the probe succeeded.
    const state = loadState();
    if (state.accounts?.[lbl]) {
      state.accounts[lbl].cooling_until = null;
      state.accounts[lbl].last_outcome = "ok";
      saveState(state);
      console.log(`  cleared cooling_until on '${lbl}'.`);
    }
  } else {
    console.error(`✗ ${lbl}: exit=${r.status}`);
    if (stderr) console.error(`  stderr: ${stderr.slice(0, 400)}`);
    process.exit(1);
  }
}

function printTable(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
  for (const r of rows) {
    console.log(r.map((v, i) => String(v).padEnd(widths[i])).join("  "));
  }
}
