import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_TTL_MS = 1000;

let _bridgeDirOverride = null;
let _registryCache = null; // { loadedAt, value }

function bridgeDir() {
  if (_bridgeDirOverride) return _bridgeDirOverride;
  return process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR
    || path.join(os.homedir(), ".openclaw", "bridge");
}

export function _setBridgeDirForTests(d) {
  _bridgeDirOverride = d;
  fs.mkdirSync(d, { recursive: true });
}

export function _resetCachesForTests() {
  _registryCache = null;
}

const DEFAULT_REGISTRY = Object.freeze({ mode: "single", accounts: [] });
const DEFAULT_STATE = Object.freeze({
  lastMainLabel: null,
  poolQuietUntil: 0,
  poolQuietLastTriggeredAt: 0,
  poolQuietConsecutive: 0,
  circuitTrippedAt: null,
  nextProbeAt: null,
  probeAttempts: 0,
  recentOutcomes: [],
  accounts: {},
});

function cloneDefault(def) {
  return JSON.parse(JSON.stringify(def));
}

export function loadRegistry() {
  const now = Date.now();
  if (_registryCache && (now - _registryCache.loadedAt) < CACHE_TTL_MS) {
    return _registryCache.value;
  }
  const p = path.join(bridgeDir(), "accounts.json");
  let value = cloneDefault(DEFAULT_REGISTRY);
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") {
        value = {
          mode: parsed.mode === "multi" ? "multi" : "single",
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        };
      }
    }
  } catch {
    // malformed — stay on default
  }
  _registryCache = { loadedAt: now, value };
  return value;
}

export function loadState() {
  const p = path.join(bridgeDir(), "state.json");
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") {
        return { ...cloneDefault(DEFAULT_STATE), ...parsed, accounts: { ...(parsed.accounts || {}) } };
      }
    }
  } catch {}
  return cloneDefault(DEFAULT_STATE);
}

export function saveState(state) {
  const d = bridgeDir();
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, "state.json");
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function ensureAccountSlot(state, label) {
  if (!state.accounts[label]) {
    state.accounts[label] = {
      inflight: 0,
      cooling_until: 0,
      rateLimitStreak: 0,
      lastPickedAt: 0,
      lastCheckedAt: 0,
      lastReleasedAt: 0,
      counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 0, other: 0 },
    };
  }
}
