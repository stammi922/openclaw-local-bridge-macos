import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, loadState, saveState, ensureAccountSlot, _resetCachesForTests } from "./pool.js";
import { pickMain, pickHeartbeat, markChecked, markReleased } from "./policy.js";
import { classifyOutcome, DEFAULT_PATTERNS } from "./detector.js";
import { classifyRequest } from "./classify.js";
import { log } from "./logger.js";

const CIRCUIT = {
  authWindowMs: 24 * 60 * 60 * 1000,
  firstProbeDelayMs: 60 * 60 * 1000,        // T+1h
  subsequentProbeIntervalMs: 24 * 60 * 60 * 1000,
  maxProbeAttempts: 7,
};

let _nowFn = () => Date.now();
export function _setNowForTests(fn) { _nowFn = fn; }

async function defaultProbeExecutor(label, configDir) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let stderrTail = "";
    const p = spawn("claude", ["-p", "pong", "--output-format", "json", "--max-turns", "1"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    p.on("close", (code) => {
      resolve(classifyOutcome(code, stderrTail));
    });
    p.on("error", () => resolve("other"));
  });
}

let _probeExecutor = defaultProbeExecutor;
export function _setProbeExecutorForTests(fn) { _probeExecutor = fn; }

const DEFAULT_COOLDOWNS = { rate_limit: 60, usage_limit: 5 * 60 * 60, auth: -1, other: 30 };
const DEFAULT_HEARTBEAT_MODELS = ["claude-haiku-4", "claude-haiku-4-20250514"];

function loadConfig() {
  const p = process.env.OPENCLAW_BRIDGE_ROTATOR_CONFIG
    || path.join(os.homedir(), ".openclaw", "bridge", "rotator.config.json");
  let user = {};
  try {
    if (fs.existsSync(p)) user = JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch {}
  return {
    cooldowns: { ...DEFAULT_COOLDOWNS, ...(user.cooldowns || {}) },
    heartbeatModels: Array.isArray(user.heartbeatModels) ? user.heartbeatModels : DEFAULT_HEARTBEAT_MODELS,
    outcomePatterns: user.outcomePatterns || DEFAULT_PATTERNS,
    configDirEnvVar: user.configDirEnvVar || "CLAUDE_CONFIG_DIR",
    autoClearCircuit: user.autoClearCircuit !== false,
  };
}

function configDirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function filterRegistryToValidDirs(registry) {
  return {
    ...registry,
    accounts: registry.accounts.filter(a => a.configDir && configDirExists(a.configDir)),
  };
}

const POOL_QUIET = {
  rate_limit: { windowMs: 120 * 1000, baseDurationMs: 300 * 1000 },
  usage_limit: { windowMs: 600 * 1000, baseDurationMs: 3600 * 1000 },
  retriggerWithinMs: 30 * 60 * 1000,
  maxDurationMs: 3600 * 1000,
};

function evaluatePoolQuiet(state) {
  const now = Date.now();
  const recent = state.recentOutcomes || [];

  for (const outcome of ["rate_limit", "usage_limit"]) {
    const { windowMs, baseDurationMs } = POOL_QUIET[outcome];
    const inWindow = recent.filter(e => e.outcome === outcome && (now - e.at) <= windowMs);
    const distinct = new Set(inWindow.map(e => e.label));
    if (distinct.size >= 2) {
      const last = state.poolQuietLastTriggeredAt || 0;
      let duration = baseDurationMs;
      if (last && (now - last) <= POOL_QUIET.retriggerWithinMs) {
        // double last duration, cap
        const lastDuration = (state.poolQuietUntil && state.poolQuietUntil > last)
          ? (state.poolQuietUntil - last)
          : baseDurationMs;
        duration = Math.min(POOL_QUIET.maxDurationMs, lastDuration * 2);
      }
      state.poolQuietUntil = now + duration;
      state.poolQuietLastTriggeredAt = now;
      log({ event: "pool_quiet_activated", trigger: outcome, durationMs: duration, distinctAccounts: [...distinct] });
      return;
    }
  }
}

function evaluateCircuitBreaker(state) {
  const now = _nowFn();
  const recent = state.recentOutcomes || [];
  const inWindow = recent.filter(e => e.outcome === "auth" && (now - e.at) <= CIRCUIT.authWindowMs);
  const distinct = new Set(inWindow.map(e => e.label));
  if (distinct.size >= 2 && !state.circuitTrippedAt) {
    state.circuitTrippedAt = now;
    state.nextProbeAt = now + CIRCUIT.firstProbeDelayMs;
    state.probeAttempts = 0;
    log({
      event: "circuit_tripped",
      auth_cooled: [...distinct],
      trippedAt: new Date(now).toISOString(),
    });
  }
}

export async function prepare(body) {
  let registry, state, cfg;
  try {
    registry = loadRegistry();
    cfg = loadConfig();

    if (registry.mode !== "multi") {
      return { env: {}, label: null, kind: "single", config: cfg };
    }

    state = loadState();

    if (state.circuitTrippedAt) {
      log({ event: "picked_blocked", reason: "circuit_tripped" });
      return { env: {}, label: null, kind: "main", config: cfg, noHealthy: "circuit_tripped" };
    }
    if (state.poolQuietUntil && state.poolQuietUntil > Date.now()) {
      log({ event: "picked_blocked", reason: "pool_quiet", quietUntil: state.poolQuietUntil });
      return { env: {}, label: null, kind: "main", config: cfg, noHealthy: "pool_quiet", quietUntil: state.poolQuietUntil };
    }

    const effectiveRegistry = filterRegistryToValidDirs(registry);
    for (const a of effectiveRegistry.accounts) ensureAccountSlot(state, a.label);

    const kind = classifyRequest(body, cfg);
    const account = kind === "heartbeat" ? pickHeartbeat(effectiveRegistry, state) : pickMain(effectiveRegistry, state);

    if (!account) {
      log({ event: "picked_blocked", reason: "all_cooling", kind });
      return { env: {}, label: null, kind, config: cfg, noHealthy: "all_cooling" };
    }

    if (kind === "main") state.lastMainLabel = account.label;
    markChecked(state, account.label);
    saveState(state);

    log({ event: "picked", label: account.label, kind, model: body?.model ?? null });

    return {
      env: { [cfg.configDirEnvVar]: account.configDir },
      label: account.label,
      kind,
      config: cfg,
    };
  } catch (err) {
    log({ event: "prepare_error", error: String(err?.message || err) });
    return { env: {}, label: null, kind: "single", config: null };
  }
}

export async function complete(ctx, { exitCode, stderrTail } = {}) {
  if (!ctx || !ctx.label) return;
  try {
    const cfg = ctx.config || loadConfig();
    const outcome = classifyOutcome(exitCode, stderrTail, cfg.outcomePatterns);
    const state = loadState();
    ensureAccountSlot(state, ctx.label);
    markReleased(state, ctx.label, outcome, cfg.cooldowns);

    // Append to recentOutcomes ring buffer (bounded)
    state.recentOutcomes = [
      ...(state.recentOutcomes || []).slice(-19),
      { at: Date.now(), label: ctx.label, outcome },
    ];
    evaluatePoolQuiet(state);
    evaluateCircuitBreaker(state);
    saveState(state);
    log({ event: "completed", label: ctx.label, kind: ctx.kind, outcome, exitCode: exitCode ?? null });
    return outcome;
  } catch (err) {
    log({ event: "complete_error", error: String(err?.message || err) });
  }
}

export function snapshot() {
  return { registry: loadRegistry(), state: loadState(), config: loadConfig() };
}

export function refresh() {
  _resetCachesForTests();
}

export async function probeOnce() {
  const state = loadState();
  if (!state.circuitTrippedAt) {
    return { cleared: false, reason: "not_tripped" };
  }
  const cfg = loadConfig();
  const registry = loadRegistry();

  const coolLabels = Object.entries(state.accounts)
    .filter(([_, a]) => a.cooling_until === Number.MAX_SAFE_INTEGER)
    .map(([label]) => label);

  const results = {};
  for (const label of coolLabels) {
    const acc = registry.accounts.find(a => a.label === label);
    if (!acc) { results[label] = "other"; continue; }
    try {
      results[label] = await _probeExecutor(label, acc.configDir);
    } catch {
      results[label] = "other";
    }
  }

  log({ event: "circuit_probe_ran", attempt: (state.probeAttempts || 0) + 1, results });

  const allOk = coolLabels.length > 0 && coolLabels.every(l => results[l] === "ok");
  if (allOk) {
    const s2 = loadState();
    s2.circuitTrippedAt = null;
    s2.nextProbeAt = null;
    s2.probeAttempts = 0;
    // Clear indefinite cooldown on previously-auth-cooled accounts
    for (const label of coolLabels) {
      if (s2.accounts[label]) s2.accounts[label].cooling_until = 0;
    }
    saveState(s2);
    log({ event: "circuit_auto_cleared", attempt: (state.probeAttempts || 0) + 1, clearedAt: new Date().toISOString() });
    return { cleared: true, attempts: state.probeAttempts + 1 };
  }

  // Re-arm or exhaust
  const s2 = loadState();
  s2.probeAttempts = (s2.probeAttempts || 0) + 1;
  if (s2.probeAttempts >= CIRCUIT.maxProbeAttempts) {
    s2.nextProbeAt = null;
    saveState(s2);
    log({ event: "circuit_probe_exhausted", attempts: s2.probeAttempts, escalated: true });
    return { cleared: false, exhausted: true, attempts: s2.probeAttempts };
  }
  s2.nextProbeAt = _nowFn() + CIRCUIT.subsequentProbeIntervalMs;
  saveState(s2);
  log({
    event: "circuit_probe_failed",
    attempt: s2.probeAttempts,
    stillFailing: coolLabels.filter(l => results[l] !== "ok"),
    nextProbeAt: new Date(s2.nextProbeAt).toISOString(),
  });
  return { cleared: false, attempts: s2.probeAttempts };
}

let _probeTimer = null;
export function scheduleProbeTimer() {
  if (_probeTimer) { clearTimeout(_probeTimer); _probeTimer = null; }
  const cfg = loadConfig();
  if (!cfg.autoClearCircuit) return; // operator opted out
  const state = loadState();
  if (!state.circuitTrippedAt || !state.nextProbeAt) return;

  const delay = Math.max(0, state.nextProbeAt - _nowFn());
  const MAX_TIMER = 2 ** 31 - 1; // setTimeout max
  const armed = Math.min(delay, MAX_TIMER);
  _probeTimer = setTimeout(async () => {
    try { await probeOnce(); } catch {}
    scheduleProbeTimer();
  }, armed);
  log({ event: "circuit_probe_scheduled", nextProbeAt: new Date(state.nextProbeAt).toISOString(), probeAttempts: state.probeAttempts || 0 });
}

export const _internals = { loadConfig };
