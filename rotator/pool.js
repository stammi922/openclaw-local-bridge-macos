// Load/save accounts.json (registry) and state.json (runtime health).
// Atomic writes via tmp+rename. Intended to be hot-path tolerant: reads
// are cached for 1s so a burst of requests doesn't re-stat the disk N times.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "bridge", "accounts");
const REGISTRY = "accounts.json";
const STATE = "state.json";
const READ_CACHE_MS = 1000;

let _root = process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR || DEFAULT_ROOT;
let _registryCache = { at: 0, value: null };
let _stateCache = { at: 0, value: null };

export function setRoot(root) {
  _root = root;
  _registryCache = { at: 0, value: null };
  _stateCache = { at: 0, value: null };
}
export function getRoot() { return _root; }

function registryPath() { return path.join(_root, REGISTRY); }
function statePath()    { return path.join(_root, STATE); }

export function loadRegistry() {
  const now = Date.now();
  if (_registryCache.value && now - _registryCache.at < READ_CACHE_MS) {
    return _registryCache.value;
  }
  const p = registryPath();
  if (!fs.existsSync(p)) {
    _registryCache = { at: now, value: { mode: "single", accounts: [] } };
    return _registryCache.value;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed.mode) parsed.mode = "single";
    if (!Array.isArray(parsed.accounts)) parsed.accounts = [];
    _registryCache = { at: now, value: parsed };
    return parsed;
  } catch {
    _registryCache = { at: now, value: { mode: "single", accounts: [] } };
    return _registryCache.value;
  }
}

export function saveRegistry(registry) {
  ensureRoot();
  atomicWriteJson(registryPath(), registry);
  _registryCache = { at: Date.now(), value: registry };
}

export function loadState() {
  const now = Date.now();
  if (_stateCache.value && now - _stateCache.at < READ_CACHE_MS) {
    return _stateCache.value;
  }
  const p = statePath();
  if (!fs.existsSync(p)) {
    _stateCache = { at: now, value: { lastMainLabel: null, accounts: {} } };
    return _stateCache.value;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed.accounts || typeof parsed.accounts !== "object") parsed.accounts = {};
    _stateCache = { at: now, value: parsed };
    return parsed;
  } catch {
    _stateCache = { at: now, value: { lastMainLabel: null, accounts: {} } };
    return _stateCache.value;
  }
}

export function saveState(state) {
  ensureRoot();
  atomicWriteJson(statePath(), state);
  _stateCache = { at: Date.now(), value: state };
}

export function ensureAccountSlot(state, label) {
  if (!state.accounts[label]) {
    state.accounts[label] = {
      cooling_until: null,
      last_outcome: null,
      in_flight: 0,
      counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 0, other: 0 },
      last_used: null,
    };
  }
  return state.accounts[label];
}

function ensureRoot() {
  fs.mkdirSync(_root, { recursive: true, mode: 0o700 });
}

function atomicWriteJson(target, obj) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function _resetCachesForTests() {
  _registryCache = { at: 0, value: null };
  _stateCache = { at: 0, value: null };
}
