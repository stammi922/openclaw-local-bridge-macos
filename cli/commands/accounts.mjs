import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { bridgeDir, readJson, writeJsonAtomic, requireRiskPhrase, validateLabel } from "./_common.mjs";

const REGISTRY_DEFAULT = { mode: "single", accounts: [] };

function loadRegistry() {
  return readJson(path.join(bridgeDir(), "accounts.json"), REGISTRY_DEFAULT);
}
function saveRegistry(r) {
  writeJsonAtomic(path.join(bridgeDir(), "accounts.json"), r);
}

async function cmdAdd(label) {
  validateLabel(label);
  const reg = loadRegistry();
  if (reg.accounts.find(a => a.label === label)) {
    console.log(`Account "${label}" already registered. To re-login, run:`);
    console.log(`  CLAUDE_CONFIG_DIR=${path.join(bridgeDir(), "accounts", label, "config")} claude login`);
    process.exit(0);
  }
  if (reg.accounts.length === 0) {
    await requireRiskPhrase(`First account — type exactly:  I accept the risk\n> `);
  }
  const configDir = path.join(bridgeDir(), "accounts", label, "config");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  console.log(`\nRunning: CLAUDE_CONFIG_DIR=${configDir} claude login`);
  console.log(`Complete the browser OAuth for the Claude Max account you want to assign to "${label}".\n`);
  const r = spawnSync("claude", ["login"], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`claude login failed (exit ${r.status}). Account NOT registered.`);
    process.exit(r.status || 1);
  }
  reg.accounts.push({ label, configDir });
  saveRegistry(reg);
  console.log(`\nRegistered "${label}" → ${configDir}`);
  console.log(`Next: openclaw-bridge accounts test ${label}`);
}

function cmdList() {
  const reg = loadRegistry();
  const state = readJson(path.join(bridgeDir(), "state.json"), { accounts: {} });
  if (reg.accounts.length === 0) {
    console.log("No accounts registered. Run: openclaw-bridge accounts add <label>");
    return;
  }
  console.log(`mode: ${reg.mode}`);
  console.log("");
  console.log("label      inflight cooling_until        rl_streak  counters");
  console.log("---------- -------- -------------------- ---------  --------");
  for (const a of reg.accounts) {
    const s = state.accounts?.[a.label] || { inflight: 0, cooling_until: 0, rateLimitStreak: 0, counters: {} };
    const cu = s.cooling_until === 0 ? "-" :
               s.cooling_until === Number.MAX_SAFE_INTEGER ? "∞ (auth)" :
               new Date(s.cooling_until).toISOString().slice(0, 19);
    const ctrs = Object.entries(s.counters || {}).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(`${a.label.padEnd(10)} ${String(s.inflight).padEnd(8)} ${cu.padEnd(20)} ${String(s.rateLimitStreak).padEnd(9)}  ${ctrs}`);
  }
}

async function cmdRm(label, ...flags) {
  validateLabel(label);
  const purge = flags.includes("--purge");
  const reg = loadRegistry();
  const idx = reg.accounts.findIndex(a => a.label === label);
  if (idx < 0) {
    console.error(`No such account: ${label}`);
    process.exit(1);
  }
  const [removed] = reg.accounts.splice(idx, 1);
  saveRegistry(reg);
  console.log(`Unregistered "${label}"`);
  if (purge) {
    fs.rmSync(removed.configDir, { recursive: true, force: true });
    console.log(`Purged ${removed.configDir}`);
  }
}

async function cmdTest(label) {
  validateLabel(label);
  const reg = loadRegistry();
  const acc = reg.accounts.find(a => a.label === label);
  if (!acc) {
    console.error(`No such account: ${label}`);
    process.exit(1);
  }
  console.log(`Testing "${label}" against ${acc.configDir}…`);
  let stderrTail = "";
  const p = spawn("claude", ["-p", "pong", "--output-format", "json", "--max-turns", "1"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: acc.configDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout?.on("data", (c) => process.stdout.write(c));
  p.stderr?.on("data", (c) => { stderrTail = (stderrTail + c.toString()).slice(-4096); process.stderr.write(c); });
  const code = await new Promise((resolve) => p.on("close", resolve));
  const { classifyOutcome } = await import("../../rotator/detector.js");
  const outcome = classifyOutcome(code, stderrTail);
  console.log(`\nOutcome: ${outcome} (exitCode ${code})`);
  if (outcome === "ok") {
    // Clear any cooling_until for this label
    const statePath = path.join(bridgeDir(), "state.json");
    const state = readJson(statePath, { accounts: {} });
    if (state.accounts?.[label]) {
      state.accounts[label].cooling_until = 0;
      state.accounts[label].rateLimitStreak = 0;
      writeJsonAtomic(statePath, state);
      console.log(`Cleared cooling_until for "${label}".`);
    }
  }
  process.exit(outcome === "ok" ? 0 : 1);
}

export default async function accountsCmd(args) {
  const [verb, ...rest] = args;
  switch (verb) {
    case "add":  return cmdAdd(rest[0]);
    case "list": return cmdList();
    case "rm":   return cmdRm(rest[0], ...rest.slice(1));
    case "test": return cmdTest(rest[0]);
    default:
      console.error("usage: openclaw-bridge accounts {add|list|rm|test} [label]");
      process.exit(2);
  }
}
