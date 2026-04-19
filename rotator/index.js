// Public API consumed by the proxy patch point.
//
// prepare(body): decide which account will handle this request (if multi mode)
//                and return { env, label, kind } — `env` is merged into the
//                claude subprocess's env.
// complete(ctx, { exitCode, stderrTail }): classify the outcome, update
//                health/counters, persist state.
// snapshot(): read-only view of registry + state (for `openclaw-bridge status`).
// refresh(): invalidate the in-module cache so a freshly-edited accounts.json
//            takes effect without a proxy restart.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadRegistry, loadState, saveState, ensureAccountSlot, _resetCachesForTests } from "./pool.js";
import { pickMain, pickHeartbeat, markChecked, markReleased } from "./policy.js";
import { classifyOutcome } from "./detector.js";
import { classifyRequest } from "./classify.js";
import { log } from "./logger.js";

const DEFAULT_COOLDOWNS = { rate_limit: 60, usage_limit: 5 * 60 * 60, auth: -1, other: 30 };
const DEFAULT_HEARTBEAT_MODELS = ["claude-haiku-4"];

function loadConfig() {
  const p = process.env.OPENCLAW_BRIDGE_ROTATOR_CONFIG
    || path.join(os.homedir(), ".openclaw", "bridge", "rotator.config.json");
  let user = {};
  try {
    if (fs.existsSync(p)) user = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {
    cooldowns: { ...DEFAULT_COOLDOWNS, ...(user.cooldowns || {}) },
    heartbeatModels: Array.isArray(user.heartbeatModels) ? user.heartbeatModels : DEFAULT_HEARTBEAT_MODELS,
    outcomePatterns: user.outcomePatterns || null,
    configDirEnvVar: user.configDirEnvVar || "CLAUDE_CONFIG_DIR",
  };
}

export async function prepare(body) {
  const registry = loadRegistry();
  if (registry.mode !== "multi") {
    return { env: {}, label: null, kind: "single", config: null };
  }
  const cfg = loadConfig();
  const state = loadState();
  const kind = classifyRequest(body, cfg);

  const account = kind === "heartbeat" ? pickHeartbeat(registry, state) : pickMain(registry, state);
  if (!account) {
    log({ event: "no_healthy_account", kind, mode: registry.mode });
    return { env: {}, label: null, kind, config: cfg, noHealthy: true };
  }
  if (kind === "main") state.lastMainLabel = account.label;
  markChecked(state, account.label);
  saveState(state);

  log({ event: "picked", label: account.label, kind, model: body?.model ?? null });

  const env = {};
  env[cfg.configDirEnvVar] = account.configDir;
  return { env, label: account.label, kind, config: cfg };
}

export async function complete(ctx, { exitCode, stderrTail } = {}) {
  if (!ctx || !ctx.label) return;
  const cfg = ctx.config || loadConfig();
  const outcome = classifyOutcome(exitCode, stderrTail, cfg.outcomePatterns);
  const state = loadState();
  ensureAccountSlot(state, ctx.label);
  markReleased(state, ctx.label, outcome, cfg.cooldowns);
  saveState(state);
  log({ event: "completed", label: ctx.label, kind: ctx.kind, outcome, exitCode: exitCode ?? null });
  return outcome;
}

export function snapshot() {
  return { registry: loadRegistry(), state: loadState(), config: loadConfig() };
}

export function refresh() {
  _resetCachesForTests();
}

export const _internals = { loadConfig };
