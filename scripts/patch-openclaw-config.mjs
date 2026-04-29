#!/usr/bin/env node
// Idempotent patch of ~/.openclaw/openclaw.json:
// - Adds/updates models.providers.openai pointing at the local proxy.
// - Defaults models.providers.openai.timeoutSeconds to 7200 (2h), the
//   gateway-side LLM idle/request cap. Paired with patch-proxy-timeout.mjs
//   which sets the proxy subprocess wall-clock timeout to the same 2h.
//   The two values must be coordinated; without this key the gateway falls
//   back to a 120s default cap (per docs/concepts/agent-loop.md) and long
//   agent turns hit "FailoverError: LLM request timed out" at ~5 min.
//   Uses ??= to respect any pre-existing user override.
// - Adds aliases for openai/claude-opus-4 and openai/claude-sonnet-4.
// - Preserves every other key, including other providers.
//
// Usage: node patch-openclaw-config.mjs <openclaw.json path> <port> [--dry-run]

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

const target = positional[0];
const port = positional[1];

if (!target || !port) {
  console.error("usage: patch-openclaw-config.mjs <path> <port> [--dry-run]");
  process.exit(2);
}
if (!/^\d+$/.test(port)) {
  console.error(`invalid port: ${port}`);
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`openclaw config not found: ${target}`);
  process.exit(1);
}

const DESIRED_MODELS = [
  { id: "claude-opus-4",   name: "claude-opus-4",   input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
  { id: "claude-sonnet-4", name: "claude-sonnet-4", input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
  { id: "claude-haiku-4",  name: "claude-haiku-4",  input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
];

const cfg = JSON.parse(fs.readFileSync(target, "utf8"));
const before = JSON.stringify(cfg);

cfg.models ??= {};
cfg.models.providers ??= {};
const openai = (cfg.models.providers.openai ??= {});

const desiredBaseUrl = `http://localhost:${port}/v1`;
openai.baseUrl = desiredBaseUrl;
openai.api = "openai-completions";
if (!openai.apiKey) openai.apiKey = "claude-code-local";
openai.timeoutSeconds ??= 7200;

// Union by id: our three are authoritative; preserve any user-added models.
const byId = new Map();
for (const m of DESIRED_MODELS) byId.set(m.id, { ...m });
for (const m of openai.models ?? []) {
  if (m && m.id && !byId.has(m.id)) byId.set(m.id, m);
}
// Place desired first (in order), then any user extras.
const ordered = [
  ...DESIRED_MODELS.map((d) => byId.get(d.id)),
  ...[...byId.values()].filter((m) => !DESIRED_MODELS.some((d) => d.id === m.id)),
];
openai.models = ordered;

cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.models ??= {};
(cfg.agents.defaults.models["openai/claude-opus-4"]   ??= {}).alias = "Opus";
(cfg.agents.defaults.models["openai/claude-sonnet-4"] ??= {}).alias = "Sonnet";

const after = JSON.stringify(cfg);

if (before === after) {
  console.log(`openclaw.json: already up to date — no change`);
  process.exit(0);
}

if (dryRun) {
  console.log("openclaw.json: dry-run — would update:");
  console.log(`  models.providers.openai.baseUrl = ${desiredBaseUrl}`);
  console.log(`  models.providers.openai.api = openai-completions`);
  console.log(`  models.providers.openai.timeoutSeconds = 7200 (only if unset)`);
  console.log(`  models.providers.openai.models = [3 desired + N preserved]`);
  console.log(`  agents.defaults.models.openai/claude-{opus,sonnet}-4.alias = Opus/Sonnet`);
  process.exit(0);
}

fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
console.log(`openclaw.json: patched ${target}`);
