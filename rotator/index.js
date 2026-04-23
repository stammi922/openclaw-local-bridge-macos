import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, loadState, saveState, ensureAccountSlot, _resetCachesForTests } from "./pool.js";
import { pickMain, pickHeartbeat, markChecked, markReleased } from "./policy.js";
import { classifyOutcome, DEFAULT_PATTERNS } from "./detector.js";
import { classifyRequest } from "./classify.js";
import { log } from "./logger.js";

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

export const _internals = { loadConfig };
