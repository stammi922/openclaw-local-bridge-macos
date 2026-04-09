#!/usr/bin/env node
/*
 * patch-openclaw-config.js
 *
 * Idempotent JSON patcher for ~/.openclaw/openclaw.json.
 *
 * Changes applied:
 *   - models.providers.openai: merged with local bridge defaults
 *     (baseUrl http://localhost:3457/v1, openai-completions api,
 *      claude-opus-4 / claude-sonnet-4 / claude-haiku-4 models).
 *   - agents.defaults.model.primary    -> "openai/claude-opus-4"    (if unset / non-custom)
 *   - agents.defaults.model.fallbacks  -> ["openai/claude-sonnet-4"] (if unset / non-custom)
 *   - agents.defaults.models.openai/claude-opus-4.alias   -> "Opus"
 *   - agents.defaults.models.openai/claude-sonnet-4.alias -> "Sonnet"
 *   - agents.defaults.cliBackends: removed if present.
 *
 * Running it twice changes nothing. JSON is validated before and after.
 *
 * Usage:
 *   node patch-openclaw-config.js <path-to-openclaw.json>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg)   { process.stdout.write(msg + '\n'); }
function info(msg)  { log(DIM + '  ' + msg + RESET); }
function ok(msg)    { log(GREEN + '  ok ' + RESET + msg); }
function warn(msg)  { log(YELLOW + '  !  ' + RESET + msg); }
function fail(msg)  { log(RED + '  x  ' + RESET + msg); }

const DESIRED_MODELS = [
  {
    id: 'claude-opus-4',
    name: 'claude-opus-4',
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: 'claude-sonnet-4',
    name: 'claude-sonnet-4',
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: 'claude-haiku-4',
    name: 'claude-haiku-4',
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16384,
  },
];

const DESIRED_BASE_URL = 'http://localhost:3457/v1';
const DESIRED_API = 'openai-completions';

const CANONICAL_PRIMARY = 'openai/claude-opus-4';
const CANONICAL_FALLBACKS = ['openai/claude-sonnet-4'];
const CUSTOM_PRIMARIES_ALLOWED_PREFIXES = ['openai/']; // only rewrite if unset or non-openai default

function usage(code) {
  log('Usage: node patch-openclaw-config.js <path-to-openclaw.json>');
  process.exit(code);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i += 1) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function ensureObject(parent, key) {
  if (parent[key] == null || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function mergeModelsArray(existing, desired) {
  // Merge by id: keep any extra entries already present, but make sure desired ones exist
  // with exact values (overwrite matching ids).
  const out = [];
  const byId = new Map();
  if (Array.isArray(existing)) {
    for (const m of existing) {
      if (m && typeof m === 'object' && typeof m.id === 'string') {
        byId.set(m.id, m);
      }
    }
  }
  for (const m of desired) {
    byId.set(m.id, { ...m });
  }
  // Preserve the ordering: desired first, then leftovers.
  const seen = new Set();
  for (const m of desired) {
    out.push(byId.get(m.id));
    seen.add(m.id);
  }
  if (Array.isArray(existing)) {
    for (const m of existing) {
      if (m && typeof m === 'object' && typeof m.id === 'string' && !seen.has(m.id)) {
        out.push(m);
      }
    }
  }
  return out;
}

function patchConfig(cfg, changes) {
  // models
  const models = ensureObject(cfg, 'models');
  const providers = ensureObject(models, 'providers');

  const existingOpenai = providers.openai && typeof providers.openai === 'object' ? providers.openai : {};
  const mergedOpenai = {
    ...existingOpenai,
    baseUrl: DESIRED_BASE_URL,
    api: DESIRED_API,
    models: mergeModelsArray(existingOpenai.models, DESIRED_MODELS),
  };

  if (!deepEqual(existingOpenai, mergedOpenai)) {
    providers.openai = mergedOpenai;
    changes.push('models.providers.openai updated (baseUrl=' + DESIRED_BASE_URL + ', api=' + DESIRED_API + ', 3 models ensured)');
  }

  // agents
  const agents = ensureObject(cfg, 'agents');
  const defaults = ensureObject(agents, 'defaults');
  const modelDefaults = ensureObject(defaults, 'model');

  const currentPrimary = modelDefaults.primary;
  const isEmptyPrimary = currentPrimary == null || currentPrimary === '';
  const primaryIsOpenaiBridge = typeof currentPrimary === 'string'
    && CUSTOM_PRIMARIES_ALLOWED_PREFIXES.some((p) => currentPrimary.startsWith(p));

  if (isEmptyPrimary || !primaryIsOpenaiBridge) {
    if (modelDefaults.primary !== CANONICAL_PRIMARY) {
      modelDefaults.primary = CANONICAL_PRIMARY;
      changes.push('agents.defaults.model.primary set to ' + CANONICAL_PRIMARY);
    }
    if (!deepEqual(modelDefaults.fallbacks, CANONICAL_FALLBACKS)) {
      modelDefaults.fallbacks = [...CANONICAL_FALLBACKS];
      changes.push('agents.defaults.model.fallbacks set to ' + JSON.stringify(CANONICAL_FALLBACKS));
    }
  }

  // aliases
  const modelsMap = ensureObject(defaults, 'models');
  const opusKey = 'openai/claude-opus-4';
  const sonnetKey = 'openai/claude-sonnet-4';

  const opusEntry = ensureObject(modelsMap, opusKey);
  if (opusEntry.alias !== 'Opus') {
    opusEntry.alias = 'Opus';
    changes.push('agents.defaults.models["' + opusKey + '"].alias set to "Opus"');
  }

  const sonnetEntry = ensureObject(modelsMap, sonnetKey);
  if (sonnetEntry.alias !== 'Sonnet') {
    sonnetEntry.alias = 'Sonnet';
    changes.push('agents.defaults.models["' + sonnetKey + '"].alias set to "Sonnet"');
  }

  // delete legacy cliBackends
  if (Object.prototype.hasOwnProperty.call(defaults, 'cliBackends')) {
    delete defaults.cliBackends;
    changes.push('agents.defaults.cliBackends removed (legacy key)');
  }

  return cfg;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] === '-h' || argv[0] === '--help') {
    usage(argv.length === 0 ? 2 : 0);
  }

  const target = path.resolve(argv[0]);
  if (!fs.existsSync(target)) {
    fail('File not found: ' + target);
    process.exit(2);
  }

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    fail('Cannot read file: ' + err.message);
    process.exit(2);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    fail('Invalid JSON in ' + target + ': ' + err.message);
    process.exit(3);
  }

  if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    fail('Root of config must be a JSON object');
    process.exit(3);
  }

  log('Patching OpenClaw config: ' + target);

  const changes = [];
  patchConfig(cfg, changes);

  // Validate by re-serializing.
  let out;
  try {
    out = JSON.stringify(cfg, null, 2) + '\n';
    JSON.parse(out);
  } catch (err) {
    fail('Post-patch JSON validation failed: ' + err.message);
    process.exit(4);
  }

  if (changes.length === 0) {
    ok('Config already up to date, no changes written.');
    return;
  }

  try {
    fs.writeFileSync(target, out, 'utf8');
  } catch (err) {
    fail('Cannot write file: ' + err.message);
    process.exit(5);
  }

  for (const c of changes) {
    ok(c);
  }
  log('');
  log('Wrote ' + changes.length + ' change(s) to ' + target);
}

main();
