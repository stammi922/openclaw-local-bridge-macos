// Shared helpers for openclaw-bridge CLI commands.
// Kept tiny so every subcommand loads fast.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR
  || path.join(os.homedir(), ".openclaw", "bridge", "accounts");
export const REGISTRY_PATH = path.join(ROOT, "accounts.json");
export const STATE_PATH = path.join(ROOT, "state.json");
export const CONFIG_PATH = process.env.OPENCLAW_BRIDGE_ROTATOR_CONFIG
  || path.join(os.homedir(), ".openclaw", "bridge", "rotator.config.json");
export const LOG_PATH = process.env.OPENCLAW_BRIDGE_ROTATOR_LOG
  || path.join(os.homedir(), ".openclaw", "logs", "rotator.log");

export function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}

export function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { mode: "single", accounts: [] };
  try {
    const v = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    if (!v.mode) v.mode = "single";
    if (!Array.isArray(v.accounts)) v.accounts = [];
    return v;
  } catch {
    return { mode: "single", accounts: [] };
  }
}

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastMainLabel: null, accounts: {} };
  try {
    const v = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!v.accounts) v.accounts = {};
    return v;
  } catch {
    return { lastMainLabel: null, accounts: {} };
  }
}

export function saveRegistry(registry) {
  ensureRoot();
  atomicWriteJson(REGISTRY_PATH, registry);
}

export function saveState(state) {
  ensureRoot();
  atomicWriteJson(STATE_PATH, state);
}

function atomicWriteJson(target, obj) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function die(msg, code = 1) {
  console.error(`openclaw-bridge: ${msg}`);
  process.exit(code);
}

export function healthOf(state, label, now = Date.now()) {
  const slot = state.accounts?.[label];
  if (!slot || !slot.cooling_until) return "healthy";
  if (new Date(slot.cooling_until).getTime() <= now) return "healthy";
  if (slot.cooling_until === "9999-12-31T23:59:59Z") return "auth-blocked";
  return `cooling until ${slot.cooling_until}`;
}
