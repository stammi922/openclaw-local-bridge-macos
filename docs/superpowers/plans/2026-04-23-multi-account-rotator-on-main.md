# Multi-Account Rotator on `main` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring multi-account rotation (pool of Claude Max accounts, per-account OAuth isolation via `CLAUDE_CONFIG_DIR`, heartbeat cloaking, three-layer cooldown model with auto-recovering circuit breaker) into `stammi922/openclaw-local-bridge-macos` `main` without changing behavior for single-account users.

**Architecture:** Pure-ESM rotator modules copied into the installed proxy tree at install time via a third idempotent sentinel patch (`@openclaw-bridge:rotator v1`) applied AFTER the existing `idleTimeout` (baked into the vendored `proxy/dist/`) and `extractContent` (applied by `patch-adapter.mjs` at install). Operator CLI (`openclaw-bridge`) drives account lifecycle + circuit management. On-disk state (`~/.openclaw/bridge/{accounts,state,rotator.config}.json`) is the single source of truth; the proxy picks up changes via a 1-second read cache.

**Tech Stack:** Node 22 ESM, `node --test` (built-in), bash for install/smoke, macOS launchd for runtime, vendored claude-max-api-proxy.

**Spec reference:** `docs/superpowers/specs/2026-04-23-multi-account-rotator-on-main-design.md`

**Working directory for all commands:** `/Users/jonasjames/GitProjects/openclaw-local-bridge-macos` (the repo root).

---

## File Structure

**New files:**

```
rotator/classify.js            # Pure: body → "heartbeat" | "main"
rotator/detector.js            # Pure: (exitCode, stderrTail) → outcome
rotator/logger.js              # JSONL log with 10MB × 3 rotation
rotator/pool.js                # accounts.json + state.json I/O, atomic writes, 1s cache
rotator/policy.js              # pickMain / pickHeartbeat / markChecked / markReleased
rotator/index.js               # prepare(body) / complete(ctx) / snapshot() / refresh() / schedulePollProbe()
rotator/test/*.test.js         # node --test suites, colocated

scripts/patch-proxy-rotator.mjs              # Idempotent installer-patcher
scripts/patch-proxy-rotator.test.mjs         # Patcher fixtures + assertions

cli/openclaw-bridge                          # node shebang dispatcher
cli/commands/_common.mjs                     # shared helpers (paths, prompts, risk gate)
cli/commands/accounts.mjs
cli/commands/mode.mjs
cli/commands/status.mjs
cli/commands/tail.mjs
cli/commands/reload.mjs
cli/commands/rotate-now.mjs
cli/commands/circuit.mjs

templates/accounts.json.tmpl
templates/rotator.config.json.tmpl

test/rotator.smoke.sh                        # Extends existing smoke.sh with rotator assertions
test/fixtures/rotator/routes.pre.js          # Fixture: pre-patch routes.js
test/fixtures/rotator/manager.pre.js         # Fixture: pre-patch manager.js (already idleTimeout-patched)
test/fixtures/rotator/accounts.multi.json
test/fixtures/rotator/accounts.single.json

docs/MULTI_ACCOUNT.md                        # Risk-first operator docs
```

**Modified files:**

```
install.sh         # Call patch-proxy-rotator.mjs; --enable-multi-account flag; scaffold accounts.json; link cli/openclaw-bridge
uninstall.sh       # Remove rotator files + --purge-accounts flag
verify.sh          # Rotator post-install checks
test/smoke.sh      # Wire test/rotator.smoke.sh
README.md         # Risk block + pointer to docs/MULTI_ACCOUNT.md
package.json       # Add rotator/ to workspaces if needed (probably not — it's installed into proxy tree, not built separately)
.gitignore         # Ignore ~/.openclaw/bridge/accounts/* not needed (outside repo)
```

**Runtime state (NOT created by install — only by operator actions):**

```
~/.openclaw/bridge/accounts.json              # {mode, accounts:[{label,configDir}]}
~/.openclaw/bridge/state.json                 # {lastMainLabel, poolQuietUntil, circuitTrippedAt, nextProbeAt, probeAttempts, recentOutcomes, accounts:{}}
~/.openclaw/bridge/rotator.config.json        # optional overrides
~/.openclaw/bridge/accounts/<label>/config/   # per-account CLAUDE_CONFIG_DIR root (0700)
~/.openclaw/logs/rotator.log                  # JSONL decisions + circuit events
```

---

## Anchor strings (load-bearing — re-derived from current `proxy/dist/`)

**`proxy/dist/server/routes.js` — insertion anchor** (exact, current shape):

```js
        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();
```

**`proxy/dist/subprocess/manager.js` — env-merge anchor** (exact, current post-idleTimeout shape):

```js
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });
```

**`proxy/dist/subprocess/manager.js` — stderr anchor** (exact, current post-idleTimeout shape — note the `armIdleTimeout();` call that the idle-timer patch already inserted):

```js
                this.process.stderr?.on("data", (chunk) => {
                    armIdleTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
```

If the patcher fails to find any of these exact strings, it MUST exit non-zero with a loud "anchor changed — upstream proxy bumped, update patch-proxy-rotator.mjs" message.

---

## Task 1: Repo scaffold — create `rotator/` directory and test hook

**Files:**
- Create: `rotator/.gitkeep` (temporary placeholder — deleted when real files land)
- Create: `rotator/test/.gitkeep`
- Create: `test/fixtures/rotator/.gitkeep`
- Modify: `package.json` (add `test:rotator` script)

- [ ] **Step 1: Create directories + placeholders**

```bash
cd /Users/jonasjames/GitProjects/openclaw-local-bridge-macos
mkdir -p rotator/test test/fixtures/rotator
touch rotator/.gitkeep rotator/test/.gitkeep test/fixtures/rotator/.gitkeep
```

- [ ] **Step 2: Add `test:rotator` script to `package.json`**

Modify `package.json` scripts section. Full new `scripts` block:

```json
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:rotator": "node --test rotator/test/",
    "test:e2e": "E2E=1 bash test/e2e.sh",
    "lint": "npm run lint --workspaces --if-present"
  },
```

- [ ] **Step 3: Verify the test script resolves (even with no tests yet)**

Run: `npm run test:rotator`
Expected output includes `# tests 0` and exits 0. Having zero tests is fine; we just want the wiring to work.

- [ ] **Step 4: Commit**

```bash
git add rotator/.gitkeep rotator/test/.gitkeep test/fixtures/rotator/.gitkeep package.json
git commit -m "chore(rotator): scaffold rotator/ dir + test:rotator script"
```

---

## Task 2: `rotator/classify.js` — pure request classifier

**Purpose:** Given an OpenAI-shaped chat-completions request body, return `"heartbeat"` or `"main"` based on `heartbeatModels` configured list.

**Files:**
- Create: `rotator/classify.js`
- Create: `rotator/test/classify.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/classify.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRequest } from "../classify.js";

const cfg = { heartbeatModels: ["claude-haiku-4", "claude-haiku-4-20250514"] };

test("classifyRequest: model in heartbeatModels → 'heartbeat'", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, cfg), "heartbeat");
  assert.equal(classifyRequest({ model: "claude-haiku-4-20250514" }, cfg), "heartbeat");
});

test("classifyRequest: model NOT in heartbeatModels → 'main'", () => {
  assert.equal(classifyRequest({ model: "claude-sonnet-4" }, cfg), "main");
  assert.equal(classifyRequest({ model: "claude-opus-4" }, cfg), "main");
});

test("classifyRequest: missing .model → 'main' (conservative)", () => {
  assert.equal(classifyRequest({}, cfg), "main");
  assert.equal(classifyRequest(null, cfg), "main");
  assert.equal(classifyRequest(undefined, cfg), "main");
});

test("classifyRequest: empty heartbeatModels → always 'main'", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, { heartbeatModels: [] }), "main");
});

test("classifyRequest: non-array heartbeatModels → 'main' (defensive)", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, { heartbeatModels: null }), "main");
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, {}), "main");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL with "Cannot find module './classify.js'" or similar ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Write minimal implementation**

`rotator/classify.js`:

```js
// Pure function: no I/O, safe to unit-test in isolation.
export function classifyRequest(body, cfg) {
  const models = Array.isArray(cfg?.heartbeatModels) ? cfg.heartbeatModels : [];
  const model = body?.model;
  if (typeof model !== "string" || model.length === 0) return "main";
  return models.includes(model) ? "heartbeat" : "main";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Remove scaffolding placeholder + commit**

```bash
rm rotator/.gitkeep
git add rotator/classify.js rotator/test/classify.test.js
git rm rotator/.gitkeep
git commit -m "feat(rotator): add pure request classifier (heartbeat vs main)"
```

---

## Task 3: `rotator/detector.js` — pure outcome classifier

**Purpose:** Given `(exitCode, stderrTail)`, return `"ok" | "rate_limit" | "usage_limit" | "auth" | "other"`.

**Key rule from spec:** exit code wins. `exitCode === 0 → "ok"` regardless of stderr (prevents false-positive cooldowns from CLI warnings on successful turns).

**Files:**
- Create: `rotator/detector.js`
- Create: `rotator/test/detector.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/detector.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome, DEFAULT_PATTERNS } from "../detector.js";

test("classifyOutcome: exitCode 0 → 'ok' regardless of stderr content", () => {
  assert.equal(classifyOutcome(0, ""), "ok");
  assert.equal(classifyOutcome(0, "rate limit exceeded"), "ok");
  assert.equal(classifyOutcome(0, "anthropic auth failed"), "ok");
});

test("classifyOutcome: exitCode !== 0 + rate-limit regex → 'rate_limit'", () => {
  assert.equal(classifyOutcome(1, "Error: Rate limit exceeded, retry in 60s"), "rate_limit");
  assert.equal(classifyOutcome(1, "HTTP 429 rate_limit_error"), "rate_limit");
});

test("classifyOutcome: exitCode !== 0 + usage-limit regex → 'usage_limit'", () => {
  assert.equal(classifyOutcome(1, "Your usage limit has been reached. Reset at 14:00"), "usage_limit");
  assert.equal(classifyOutcome(1, "5-hour usage window exhausted"), "usage_limit");
});

test("classifyOutcome: exitCode !== 0 + auth regex → 'auth'", () => {
  assert.equal(classifyOutcome(1, "Error: Authentication failed. Please run 'claude login'"), "auth");
  assert.equal(classifyOutcome(1, "401 Unauthorized: OAuth token invalid"), "auth");
  assert.equal(classifyOutcome(1, "invalid_grant: refresh failed"), "auth");
});

test("classifyOutcome: exitCode !== 0 + unknown stderr → 'other'", () => {
  assert.equal(classifyOutcome(1, "Network timeout"), "other");
  assert.equal(classifyOutcome(1, ""), "other");
  assert.equal(classifyOutcome(137, "killed"), "other");
});

test("classifyOutcome: null/undefined exitCode treated as failure", () => {
  assert.equal(classifyOutcome(null, ""), "other");
  assert.equal(classifyOutcome(undefined, ""), "other");
});

test("classifyOutcome: custom patterns override defaults", () => {
  const custom = { rate_limit: /CUSTOM_RATE/i, usage_limit: /CUSTOM_USAGE/i, auth: /CUSTOM_AUTH/i };
  assert.equal(classifyOutcome(1, "CUSTOM_RATE triggered"), "rate_limit", "custom rate_limit");
  assert.equal(classifyOutcome(1, "rate limit exceeded"), "other", "default pattern ignored when custom provided");
}, { pattern: "custom patterns" });
```

Note: the last test currently uses positional `classifyOutcome(ec, stderr)` with default patterns. Adjust: the real signature is `classifyOutcome(exitCode, stderrTail, patterns)`. Revise the last test to pass `custom` as third arg:

```js
test("classifyOutcome: custom patterns override defaults", () => {
  const custom = { rate_limit: /CUSTOM_RATE/i, usage_limit: /CUSTOM_USAGE/i, auth: /CUSTOM_AUTH/i };
  assert.equal(classifyOutcome(1, "CUSTOM_RATE triggered", custom), "rate_limit");
  assert.equal(classifyOutcome(1, "rate limit exceeded", custom), "other");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL with ERR_MODULE_NOT_FOUND for `../detector.js`.

- [ ] **Step 3: Write minimal implementation**

`rotator/detector.js`:

```js
// Pure function. No I/O. Classifies subprocess outcome from exit code + tail of stderr.
//
// Exit code wins: successful CLI runs (exit 0) are ALWAYS "ok" even if stderr mentions
// rate-limit-ish strings (the CLI sometimes warns on successful turns).

export const DEFAULT_PATTERNS = {
  rate_limit: /\b(rate[_ ]limit|rate_limit_error|HTTP[:\s]*429|too many requests)\b/i,
  usage_limit: /\b(usage[_ ]limit|5[-\s]?hour usage|usage window (exhausted|reached)|quota exhausted)\b/i,
  auth: /\b(authentication failed|unauthori[sz]ed|invalid_grant|oauth token (invalid|expired)|401|please run ['"]?claude login)\b/i,
};

export function classifyOutcome(exitCode, stderrTail, patterns) {
  if (exitCode === 0) return "ok";
  if (exitCode === null || exitCode === undefined) return "other";
  const p = patterns || DEFAULT_PATTERNS;
  const s = typeof stderrTail === "string" ? stderrTail : "";
  if (p.rate_limit && p.rate_limit.test(s)) return "rate_limit";
  if (p.usage_limit && p.usage_limit.test(s)) return "usage_limit";
  if (p.auth && p.auth.test(s)) return "auth";
  return "other";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, all detector tests + existing classify tests.

- [ ] **Step 5: Commit**

```bash
git add rotator/detector.js rotator/test/detector.test.js
git commit -m "feat(rotator): add pure outcome classifier (exitCode + stderr → outcome)"
```

---

## Task 4: `rotator/logger.js` — JSONL log with size-based rotation

**Purpose:** Append one JSON object per line to `rotator.log`; rotate to `rotator.log.1`, `.2`, `.3` when > 10 MB. Must never throw into caller.

**Files:**
- Create: `rotator/logger.js`
- Create: `rotator/test/logger.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/logger.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, _setLogPathForTests } from "../logger.js";

function mkTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-log-"));
  const p = path.join(dir, "rotator.log");
  _setLogPathForTests(p);
  return { dir, p };
}

test("log: appends one JSON line per call", () => {
  const { p } = mkTempLog();
  log({ event: "a" });
  log({ event: "b", x: 1 });
  const content = fs.readFileSync(p, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { event: "a", ts: JSON.parse(lines[0]).ts });
  assert.equal(JSON.parse(lines[1]).x, 1);
  assert.match(JSON.parse(lines[0]).ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("log: rotates when file exceeds 10MB", () => {
  const { p } = mkTempLog();
  const big = "x".repeat(1024 * 1024);
  fs.writeFileSync(p, big.repeat(11));
  log({ event: "trigger" });
  assert.ok(fs.existsSync(p + ".1"), "should have created .1");
  const current = fs.readFileSync(p, "utf8");
  assert.ok(current.includes('"event":"trigger"'), "new log should have the trigger event");
  assert.ok(current.length < 2 * 1024 * 1024, "new log should be small");
});

test("log: keeps max 3 generations", () => {
  const { dir, p } = mkTempLog();
  fs.writeFileSync(p + ".1", "one");
  fs.writeFileSync(p + ".2", "two");
  fs.writeFileSync(p + ".3", "three");
  const big = "x".repeat(11 * 1024 * 1024);
  fs.writeFileSync(p, big);
  log({ event: "force-rotate" });
  assert.equal(fs.readFileSync(p + ".2", "utf8"), "one");
  assert.equal(fs.readFileSync(p + ".3", "utf8"), "two");
  assert.equal(fs.existsSync(p + ".4"), false, "no .4 generation");
});

test("log: never throws even if parent dir missing", () => {
  _setLogPathForTests("/definitely/does/not/exist/rotator.log");
  assert.doesNotThrow(() => log({ event: "should-not-throw" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL — `../logger.js` missing.

- [ ] **Step 3: Write minimal implementation**

`rotator/logger.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_GENERATIONS = 3;

let _logPath = null;

function resolveLogPath() {
  if (_logPath) return _logPath;
  return process.env.OPENCLAW_BRIDGE_ROTATOR_LOG
    || path.join(os.homedir(), ".openclaw", "logs", "rotator.log");
}

export function _setLogPathForTests(p) {
  _logPath = p;
}

function rotate(p) {
  // Shift: .2 → .3, .1 → .2, current → .1
  for (let i = MAX_GENERATIONS; i >= 1; i--) {
    const src = i === 1 ? p : `${p}.${i - 1}`;
    const dst = `${p}.${i}`;
    try {
      if (fs.existsSync(src)) {
        if (i === MAX_GENERATIONS && fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      }
    } catch {
      // best-effort; if rotation fails we continue and let append fail silently
    }
  }
}

export function log(obj) {
  const p = resolveLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_SIZE) rotate(p);
    } catch {
      // file doesn't exist yet — that's fine
    }
    const entry = { ts: new Date().toISOString(), ...obj };
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch (err) {
    try { console.error("[rotator.log] failed:", err?.message || err); } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, all logger tests + prior.

- [ ] **Step 5: Commit**

```bash
git add rotator/logger.js rotator/test/logger.test.js
git commit -m "feat(rotator): add JSONL logger with 10MB × 3 rotation"
```

---

## Task 5: `rotator/pool.js` — registry + state I/O with atomic writes and 1s cache

**Purpose:** Load/save `accounts.json` and `state.json`. Writes go tmp+rename. Reads of `accounts.json` are cached for 1 s (hot path optimization). Default shapes on missing/malformed files.

**Files:**
- Create: `rotator/pool.js`
- Create: `rotator/test/pool.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/pool.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRegistry, loadState, saveState, ensureAccountSlot,
  _setBridgeDirForTests, _resetCachesForTests,
} from "../pool.js";

function mkBridgeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-pool-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  return d;
}

test("loadRegistry: missing accounts.json → default {mode:'single',accounts:[]}", () => {
  mkBridgeDir();
  const r = loadRegistry();
  assert.equal(r.mode, "single");
  assert.deepEqual(r.accounts, []);
});

test("loadRegistry: malformed JSON → default", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), "{this is not json");
  const r = loadRegistry();
  assert.equal(r.mode, "single");
});

test("loadRegistry: valid multi mode with accounts", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({
    mode: "multi",
    accounts: [{ label: "a", configDir: "/tmp/a" }, { label: "b", configDir: "/tmp/b" }],
  }));
  const r = loadRegistry();
  assert.equal(r.mode, "multi");
  assert.equal(r.accounts.length, 2);
  assert.equal(r.accounts[0].label, "a");
});

test("loadRegistry: 1s cache — mutating the file within 1s does not reload", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "single", accounts: [] }));
  const r1 = loadRegistry();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts: [] }));
  const r2 = loadRegistry();
  assert.equal(r2.mode, "single", "cache should still see 'single'");
  // reset cache, then re-read:
  _resetCachesForTests();
  const r3 = loadRegistry();
  assert.equal(r3.mode, "multi");
});

test("loadState / saveState: round-trip", () => {
  mkBridgeDir();
  const s = loadState();
  assert.deepEqual(s.accounts, {});
  assert.equal(s.recentOutcomes.length, 0);
  s.lastMainLabel = "work";
  saveState(s);
  const s2 = loadState();
  assert.equal(s2.lastMainLabel, "work");
});

test("saveState: atomic via tmp+rename (no partial-read)", () => {
  const d = mkBridgeDir();
  const s = loadState();
  s.lastMainLabel = "a".repeat(100);
  saveState(s);
  const files = fs.readdirSync(d);
  assert.ok(files.includes("state.json"));
  assert.ok(!files.some(f => f.endsWith(".tmp")), "no leftover tmp files");
});

test("ensureAccountSlot: idempotent, initializes counters", () => {
  mkBridgeDir();
  const s = loadState();
  ensureAccountSlot(s, "work");
  assert.ok(s.accounts.work);
  assert.equal(s.accounts.work.inflight, 0);
  assert.equal(s.accounts.work.cooling_until, 0);
  assert.equal(s.accounts.work.rateLimitStreak, 0);
  ensureAccountSlot(s, "work"); // re-run
  assert.equal(s.accounts.work.inflight, 0, "idempotent — does not reset existing slot");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL — missing `../pool.js`.

- [ ] **Step 3: Write minimal implementation**

`rotator/pool.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, pool tests + all prior.

- [ ] **Step 5: Commit**

```bash
git add rotator/pool.js rotator/test/pool.test.js
git commit -m "feat(rotator): add pool I/O with atomic writes + 1s cache"
```

---

## Task 6: `rotator/policy.js` — pick strategies + inflight bookkeeping

**Purpose:** Implement the pick algorithm. `pickMain` is sticky-unless-concurrent; `pickHeartbeat` is uniform-random over healthy. Pure functions — operate on registry + state objects.

**Files:**
- Create: `rotator/policy.js`
- Create: `rotator/test/policy.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/policy.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMain, pickHeartbeat, markChecked, markReleased, _setRngForTests } from "../policy.js";
import { ensureAccountSlot } from "../pool.js";

function mkRegistry(labels) {
  return { mode: "multi", accounts: labels.map(l => ({ label: l, configDir: `/fake/${l}` })) };
}

function mkState(labels, overrides = {}) {
  const s = {
    lastMainLabel: null,
    poolQuietUntil: 0,
    recentOutcomes: [],
    accounts: {},
    ...overrides,
  };
  for (const l of labels) ensureAccountSlot(s, l);
  return s;
}

test("pickMain: sticky reuse when last-picked is healthy AND idle", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 0;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "a");
});

test("pickMain: rotates off sticky when last-picked has inflight > 0", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 1;
  const picked = pickMain(reg, state);
  assert.notEqual(picked.label, "a");
});

test("pickMain: filters cooling accounts", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  state.accounts.b.cooling_until = Date.now() + 60000;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "c");
});

test("pickMain: returns null when no healthy accounts", () => {
  const reg = mkRegistry(["a"]);
  const state = mkState(["a"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  assert.equal(pickMain(reg, state), null);
});

test("pickMain: tiebreak by LRU lastPickedAt (oldest first)", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  state.accounts.a.lastPickedAt = 3000;
  state.accounts.b.lastPickedAt = 1000; // oldest
  state.accounts.c.lastPickedAt = 2000;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "b");
});

test("pickHeartbeat: uniform over healthy (seeded)", () => {
  _setRngForTests(() => 0.0);
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  assert.equal(pickHeartbeat(reg, state).label, "a", "first when rng=0.0");
  _setRngForTests(() => 0.999);
  assert.equal(pickHeartbeat(reg, state).label, "c", "last when rng≈1");
  _setRngForTests(() => 0.5);
  assert.equal(pickHeartbeat(reg, state).label, "b", "middle when rng=0.5");
});

test("pickHeartbeat: filters cooling", () => {
  _setRngForTests(() => 0.0);
  const reg = mkRegistry(["a", "b"]);
  const state = mkState(["a", "b"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  assert.equal(pickHeartbeat(reg, state).label, "b");
});

test("pickMain: inflight self-heal — stale inflight decays to 0 after 5min", () => {
  const reg = mkRegistry(["a"]);
  const state = mkState(["a"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 5;
  state.accounts.a.lastCheckedAt = Date.now() - 6 * 60 * 1000; // 6min ago
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "a", "should pick despite stale inflight");
  assert.equal(state.accounts.a.inflight, 0, "stale inflight was reset");
});

test("markChecked: increments inflight + updates timestamps", () => {
  const state = mkState(["a"]);
  markChecked(state, "a");
  assert.equal(state.accounts.a.inflight, 1);
  assert.ok(state.accounts.a.lastCheckedAt > 0);
  assert.ok(state.accounts.a.lastPickedAt > 0);
});

test("markReleased: decrements inflight + sets cooldown on non-ok", () => {
  const state = mkState(["a"]);
  markChecked(state, "a");
  markReleased(state, "a", "rate_limit", { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 });
  assert.equal(state.accounts.a.inflight, 0);
  assert.ok(state.accounts.a.cooling_until > Date.now());
  assert.equal(state.accounts.a.rateLimitStreak, 1);
  assert.equal(state.accounts.a.counters.rate_limit, 1);
});

test("markReleased: rate-limit streak escalates exponentially with 3600s cap", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  // 5 successive rate_limit outcomes
  for (let i = 0; i < 8; i++) markReleased(state, "a", "rate_limit", cd);
  // expected durations: 60, 120, 240, 480, 960, 1920, 3600 (cap), 3600 (cap)
  assert.equal(state.accounts.a.rateLimitStreak, 8);
});

test("markReleased: ok outcome resets rate-limit streak", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  markReleased(state, "a", "rate_limit", cd);
  markReleased(state, "a", "rate_limit", cd);
  assert.equal(state.accounts.a.rateLimitStreak, 2);
  markReleased(state, "a", "ok", cd);
  assert.equal(state.accounts.a.rateLimitStreak, 0);
  assert.equal(state.accounts.a.cooling_until, 0, "ok clears cooling");
});

test("markReleased: auth outcome sets indefinite cooldown (-1 sentinel)", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  markReleased(state, "a", "auth", cd);
  assert.equal(state.accounts.a.cooling_until, Number.MAX_SAFE_INTEGER);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL — `../policy.js` missing.

- [ ] **Step 3: Write minimal implementation**

`rotator/policy.js`:

```js
const INFLIGHT_STALE_MS = 5 * 60 * 1000;
const RL_STREAK_RESET_MS = 30 * 60 * 1000;
const RL_MAX_COOLDOWN_S = 3600;

let _rng = Math.random;
export function _setRngForTests(fn) { _rng = fn; }

function now() { return Date.now(); }

function healAccount(state, label) {
  const a = state.accounts[label];
  if (!a) return;
  if (a.inflight > 0 && a.lastCheckedAt && (now() - a.lastCheckedAt) > INFLIGHT_STALE_MS) {
    a.inflight = 0;
  }
  if (a.rateLimitStreak > 0 && a.lastReleasedAt && (now() - a.lastReleasedAt) > RL_STREAK_RESET_MS) {
    a.rateLimitStreak = 0;
  }
}

function isHealthy(state, label) {
  healAccount(state, label);
  const a = state.accounts[label];
  if (!a) return false;
  return a.cooling_until <= now();
}

function healthyAccounts(registry, state) {
  const out = [];
  for (const acc of registry.accounts) {
    if (!state.accounts[acc.label]) continue;
    if (isHealthy(state, acc.label)) out.push(acc);
  }
  return out;
}

export function pickMain(registry, state) {
  const healthy = healthyAccounts(registry, state);
  if (healthy.length === 0) return null;

  const last = state.lastMainLabel;
  if (last && healthy.find(a => a.label === last)) {
    healAccount(state, last);
    if ((state.accounts[last].inflight || 0) === 0) {
      return healthy.find(a => a.label === last);
    }
  }

  // Pick lowest inflight; tiebreak by oldest lastPickedAt
  healthy.sort((a, b) => {
    const ai = state.accounts[a.label].inflight;
    const bi = state.accounts[b.label].inflight;
    if (ai !== bi) return ai - bi;
    return state.accounts[a.label].lastPickedAt - state.accounts[b.label].lastPickedAt;
  });
  return healthy[0];
}

export function pickHeartbeat(registry, state) {
  const healthy = healthyAccounts(registry, state);
  if (healthy.length === 0) return null;
  const i = Math.floor(_rng() * healthy.length);
  return healthy[Math.min(i, healthy.length - 1)];
}

export function markChecked(state, label) {
  const a = state.accounts[label];
  if (!a) return;
  a.inflight = (a.inflight || 0) + 1;
  const t = now();
  a.lastCheckedAt = t;
  a.lastPickedAt = t;
}

export function markReleased(state, label, outcome, cooldowns) {
  const a = state.accounts[label];
  if (!a) return;
  a.inflight = Math.max(0, (a.inflight || 0) - 1);
  a.lastReleasedAt = now();
  a.counters = a.counters || { ok: 0, rate_limit: 0, usage_limit: 0, auth: 0, other: 0 };
  a.counters[outcome] = (a.counters[outcome] || 0) + 1;

  if (outcome === "ok") {
    a.cooling_until = 0;
    a.rateLimitStreak = 0;
    return;
  }
  if (outcome === "rate_limit") {
    a.rateLimitStreak = (a.rateLimitStreak || 0) + 1;
    const secs = Math.min(RL_MAX_COOLDOWN_S, (cooldowns.rate_limit || 60) * Math.pow(2, a.rateLimitStreak - 1));
    a.cooling_until = now() + secs * 1000;
    return;
  }
  if (outcome === "auth") {
    a.cooling_until = (cooldowns.auth === -1) ? Number.MAX_SAFE_INTEGER : now() + cooldowns.auth * 1000;
    return;
  }
  // usage_limit | other
  const secs = cooldowns[outcome] ?? 30;
  a.cooling_until = secs === -1 ? Number.MAX_SAFE_INTEGER : now() + secs * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, policy tests + all prior.

- [ ] **Step 5: Commit**

```bash
git add rotator/policy.js rotator/test/policy.test.js
git commit -m "feat(rotator): add pick policy + inflight/cooldown bookkeeping"
```

---

## Task 7: `rotator/index.js` — orchestrator (prepare/complete) with single-mode no-op

**Purpose:** The public API the patched proxy imports. Single-mode path must be a true no-op (zero state writes, one cached registry read, returns `{env:{}, label:null}`).

**Files:**
- Create: `rotator/index.js`
- Create: `rotator/test/index.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/index.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, complete, snapshot, refresh } from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function mkEnv(mode, accounts = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-idx-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode, accounts }));
  // Pre-create configDirs so configDir existence check passes
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("prepare: single mode → {env:{}, label:null, kind:'single'}, no state writes", async () => {
  const d = mkEnv("single");
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.deepEqual(ctx.env, {});
  assert.equal(ctx.label, null);
  assert.equal(ctx.kind, "single");
  assert.equal(fs.existsSync(path.join(d, "state.json")), false, "no state.json written");
});

test("complete: single-mode ctx (label=null) → no-op, no state writes", async () => {
  const d = mkEnv("single");
  await complete({ label: null, kind: "single" }, { exitCode: 0, stderrTail: "" });
  assert.equal(fs.existsSync(path.join(d, "state.json")), false);
});

test("prepare: multi mode happy path → picks account + sets env + updates state", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.ok(ctx.env.CLAUDE_CONFIG_DIR);
  assert.ok(["a", "b"].includes(ctx.label));
  assert.equal(ctx.kind, "main");
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.accounts[ctx.label].inflight, 1);
  assert.equal(state.lastMainLabel, ctx.label);
});

test("prepare: multi mode heartbeat → pickHeartbeat path + does not update lastMainLabel", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctx = await prepare({ model: "claude-haiku-4" }); // default heartbeat model
  assert.equal(ctx.kind, "heartbeat");
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.lastMainLabel, null, "heartbeats do not anchor sticky pointer");
});

test("prepare → complete round-trip: ok outcome decrements inflight + clears cooling", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  const ctx = await prepare({ model: "claude-sonnet-4" });
  await complete(ctx, { exitCode: 0, stderrTail: "" });
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.accounts.a.inflight, 0);
  assert.equal(state.accounts.a.counters.ok, 1);
});

test("prepare: no healthy accounts → {env:{}, noHealthy:'all_cooling'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  // Force cooldown
  const ctx = await prepare({ model: "claude-sonnet-4" });
  await complete(ctx, { exitCode: 1, stderrTail: "Error: Authentication failed" });
  _resetCachesForTests();
  const ctx2 = await prepare({ model: "claude-sonnet-4" });
  assert.deepEqual(ctx2.env, {});
  assert.ok(["all_cooling", "circuit_tripped"].includes(ctx2.noHealthy));
});

test("snapshot: returns registry + state + config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  const snap = snapshot();
  assert.equal(snap.registry.mode, "multi");
  assert.ok(Array.isArray(snap.registry.accounts));
  assert.ok(snap.state && typeof snap.state === "object");
  assert.ok(snap.config);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL — `../index.js` missing.

- [ ] **Step 3: Write minimal implementation**

`rotator/index.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, index tests + all prior.

- [ ] **Step 5: Commit**

```bash
git add rotator/index.js rotator/test/index.test.js
git commit -m "feat(rotator): orchestrator prepare/complete with single-mode no-op"
```

---

## Task 8: Pool-quiet period (Layer 2 — correlated-failure detector)

**Purpose:** Add pool-wide quiet period logic: ≥2 distinct accounts hit `rate_limit` in 120s → quiet 300s; ≥2 distinct accounts hit `usage_limit` in 600s → quiet 3600s; re-trigger within 30min doubles duration (cap 3600s).

**Files:**
- Modify: `rotator/index.js` (extend `complete()` to evaluate triggers)
- Create: `rotator/test/pool-quiet.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/pool-quiet.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, complete } from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests, loadState } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function setup(accounts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts }));
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("pool-quiet: 2 distinct accounts → rate_limit within 120s → poolQuietUntil = now+300s", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctxA = await prepare({ model: "claude-sonnet-4" });
  await complete(ctxA, { exitCode: 1, stderrTail: "HTTP 429 rate_limit_error" });
  _resetCachesForTests();
  const ctxB = await prepare({ model: "claude-sonnet-4" });
  await complete(ctxB, { exitCode: 1, stderrTail: "HTTP 429 rate_limit_error" });
  const s = loadState();
  assert.ok(s.poolQuietUntil > Date.now(), "pool quiet should be set");
  assert.ok(s.poolQuietUntil <= Date.now() + 305 * 1000, "duration ~300s");
});

test("pool-quiet: during quiet period, prepare → {noHealthy:'pool_quiet'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const a = await prepare({ model: "claude-sonnet-4" });
  await complete(a, { exitCode: 1, stderrTail: "rate limit exceeded" });
  _resetCachesForTests();
  const b = await prepare({ model: "claude-sonnet-4" });
  await complete(b, { exitCode: 1, stderrTail: "rate limit exceeded" });
  _resetCachesForTests();
  const c = await prepare({ model: "claude-sonnet-4" });
  assert.equal(c.noHealthy, "pool_quiet");
  assert.equal(c.label, null);
});

test("pool-quiet: 2 distinct usage_limit within 600s → 3600s quiet", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const a = await prepare({ model: "claude-sonnet-4" });
  await complete(a, { exitCode: 1, stderrTail: "Your usage limit has been reached" });
  _resetCachesForTests();
  const b = await prepare({ model: "claude-sonnet-4" });
  await complete(b, { exitCode: 1, stderrTail: "5-hour usage window exhausted" });
  const s = loadState();
  assert.ok(s.poolQuietUntil - Date.now() > 3500 * 1000, "duration ~3600s");
  assert.ok(s.poolQuietUntil - Date.now() <= 3605 * 1000);
});

test("pool-quiet: re-trigger within 30min doubles duration (cap 3600s)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  // First trigger
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  let s = loadState();
  const d1 = s.poolQuietUntil - Date.now();
  assert.ok(d1 <= 305 * 1000, `first quiet ~300s (got ${d1}ms)`);

  // Simulate pool quiet expired + re-trigger within 30min
  s.poolQuietUntil = Date.now() - 1000;
  // Need to keep poolQuietLastTriggeredAt recent
  s.poolQuietLastTriggeredAt = Date.now() - 10 * 60 * 1000; // 10 min ago, within 30min
  const fs2 = await import("node:fs");
  fs2.writeFileSync(
    path.join(process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR || "", "state.json"),
    JSON.stringify(s, null, 2),
  );
  _resetCachesForTests();
  // Need to set OPENCLAW_BRIDGE_ACCOUNTS_DIR or use _setBridgeDirForTests
  // (the setup() above did that already)

  // Second trigger
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  s = loadState();
  const d2 = s.poolQuietUntil - Date.now();
  assert.ok(d2 > 550 * 1000, `second quiet should be ~600s, got ${d2}ms`);
});
```

NOTE: The last test writes state.json directly; because _setBridgeDirForTests was used, the temp dir is known. Cleaner rewrite: use `_setBridgeDirForTests`'s returned path. Adjust as needed during execution if import-cycle issues arise.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL (pool-quiet logic not implemented yet).

- [ ] **Step 3: Add pool-quiet trigger logic to `rotator/index.js`**

Insert this helper function in `rotator/index.js` (after `filterRegistryToValidDirs`, before `prepare`):

```js
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
```

In `complete()`, after `markReleased` + `recentOutcomes` update and BEFORE `saveState`, call `evaluatePoolQuiet(state)`:

Find this block in `complete()`:

```js
    state.recentOutcomes = [
      ...(state.recentOutcomes || []).slice(-19),
      { at: Date.now(), label: ctx.label, outcome },
    ];
    saveState(state);
```

Replace with:

```js
    state.recentOutcomes = [
      ...(state.recentOutcomes || []).slice(-19),
      { at: Date.now(), label: ctx.label, outcome },
    ];
    evaluatePoolQuiet(state);
    saveState(state);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, including pool-quiet tests.

- [ ] **Step 5: Commit**

```bash
git add rotator/index.js rotator/test/pool-quiet.test.js
git commit -m "feat(rotator): pool-wide quiet period on correlated rate/usage failures"
```

---

## Task 9: Auth-cascade circuit breaker + in-proxy auto-probe scheduler

**Purpose:** Implement Layer 3: 2+ `auth` outcomes in 24h trips the circuit. Circuit auto-clears via scheduled probe: T+1h first probe, then every 24h, up to 7 attempts. Persist `nextProbeAt` in state.json. Expose `schedulePollProbe(runProbeFn)` that the proxy calls at startup.

**Files:**
- Modify: `rotator/index.js` (add circuit detection, scheduler, `probeOnce`, `scheduleProbeTimer`)
- Create: `rotator/test/circuit.test.js`

- [ ] **Step 1: Write the failing test**

`rotator/test/circuit.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepare, complete, probeOnce, scheduleProbeTimer, _setNowForTests, _setProbeExecutorForTests,
} from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests, loadState, saveState } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function setup(accounts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts }));
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("circuit: 2 auth outcomes in 24h → circuitTrippedAt set, nextProbeAt = T+1h", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "401 Unauthorized" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "invalid_grant" });
  const s = loadState();
  assert.ok(s.circuitTrippedAt);
  assert.ok(s.nextProbeAt);
  const dt = s.nextProbeAt - s.circuitTrippedAt;
  assert.ok(dt >= 60 * 60 * 1000 - 100, "nextProbeAt ≥ T+1h");
  assert.ok(dt <= 60 * 60 * 1000 + 100);
});

test("circuit: prepare during tripped circuit → {noHealthy:'circuit_tripped'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "401 Unauthorized" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "invalid_grant" });
  _resetCachesForTests();
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.equal(ctx.noHealthy, "circuit_tripped");
});

test("probeOnce: all cooled accounts return 'ok' → circuit clears", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  // Manually trip the circuit
  const s = loadState();
  s.circuitTrippedAt = Date.now();
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  s.accounts.b = { ...s.accounts.a };
  saveState(s);
  _setProbeExecutorForTests(async (_label, _configDir) => "ok");
  const result = await probeOnce();
  assert.equal(result.cleared, true);
  const s2 = loadState();
  assert.equal(s2.circuitTrippedAt, null);
  assert.equal(s2.nextProbeAt, null);
});

test("probeOnce: some cooled accounts still fail → re-arms for T+24h, increments probeAttempts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const s = loadState();
  s.circuitTrippedAt = Date.now();
  s.probeAttempts = 0;
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  s.accounts.b = { ...s.accounts.a };
  saveState(s);
  _setProbeExecutorForTests(async (label, _d) => label === "a" ? "ok" : "auth");
  const result = await probeOnce();
  assert.equal(result.cleared, false);
  const s2 = loadState();
  assert.ok(s2.circuitTrippedAt, "circuit still tripped");
  assert.equal(s2.probeAttempts, 1);
  assert.ok(s2.nextProbeAt - Date.now() > 23 * 60 * 60 * 1000, "re-armed for ~24h");
});

test("probeOnce: 7th failing probe → no further re-arm, escalation log, stays tripped", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([{ label: "a", configDir: path.join(tmp, "a") }]);
  const s = loadState();
  s.circuitTrippedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
  s.probeAttempts = 6; // 7th will be the "final"
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  saveState(s);
  _setProbeExecutorForTests(async () => "auth");
  const result = await probeOnce();
  assert.equal(result.cleared, false);
  assert.equal(result.exhausted, true);
  const s2 = loadState();
  assert.equal(s2.nextProbeAt, null, "no further auto-probes");
  assert.ok(s2.circuitTrippedAt, "stays tripped");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rotator`
Expected: FAIL — new exports (`probeOnce`, `scheduleProbeTimer`, `_setProbeExecutorForTests`) not defined.

- [ ] **Step 3: Extend `rotator/index.js` with circuit + probe logic**

At the top of `rotator/index.js` after imports, add:

```js
const CIRCUIT = {
  authWindowMs: 24 * 60 * 60 * 1000,
  firstProbeDelayMs: 60 * 60 * 1000,        // T+1h
  subsequentProbeIntervalMs: 24 * 60 * 60 * 1000,
  maxProbeAttempts: 7,
};

let _nowFn = () => Date.now();
export function _setNowForTests(fn) { _nowFn = fn; }

let _probeExecutor = defaultProbeExecutor;
export function _setProbeExecutorForTests(fn) { _probeExecutor = fn; }

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
```

Then add this helper near `evaluatePoolQuiet`:

```js
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
```

In `complete()`, after `evaluatePoolQuiet(state)` and BEFORE `saveState(state)`, call `evaluateCircuitBreaker(state)`:

```js
    evaluatePoolQuiet(state);
    evaluateCircuitBreaker(state);
    saveState(state);
```

Now add the probe functions:

```js
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
```

Finally, change the `probeOnce`'s `classifyOutcome` import reference. Since `detector.js` already exports `classifyOutcome`, it's already imported; no additional change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rotator`
Expected: PASS, including circuit tests.

- [ ] **Step 5: Commit**

```bash
git add rotator/index.js rotator/test/circuit.test.js
git commit -m "feat(rotator): auth-cascade circuit breaker + in-proxy auto-probe scheduler"
```

---

## Task 10: `scripts/patch-proxy-rotator.mjs` — idempotent installer-patcher

**Purpose:** At install time, copy `rotator/*.js` into `<proxy>/dist/rotator/` and inject three sentinel-guarded patches into `routes.js` + `manager.js`.

**Files:**
- Create: `scripts/patch-proxy-rotator.mjs`
- Create: `scripts/patch-proxy-rotator.test.mjs`
- Create: `test/fixtures/rotator/routes.pre.js`
- Create: `test/fixtures/rotator/manager.pre.js`

- [ ] **Step 1: Create fixture files**

`test/fixtures/rotator/routes.pre.js` — a minimal current-shape stub containing the exact anchor:

```js
// Fixture: pre-patch routes.js (contains ONLY the anchor region for patch testing)
export async function handleChatCompletions(req, res) {
    try {
        const body = req.body;
        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();
        await subprocess.start(cliInput, {});
    } catch (err) {
        console.error(err);
    }
}
```

`test/fixtures/rotator/manager.pre.js` — a minimal current-shape stub containing both env and stderr anchors (post-idleTimeout shape):

```js
// Fixture: pre-patch manager.js (post-idleTimeout shape)
export class ClaudeSubprocess {
    async start(prompt, options) {
        return new Promise((resolve, reject) => {
            try {
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                const armIdleTimeout = () => {};
                armIdleTimeout();
                this.process.stderr?.on("data", (chunk) => {
                    armIdleTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
            } catch (err) { reject(err); }
        });
    }
}
```

- [ ] **Step 2: Write the failing test**

`scripts/patch-proxy-rotator.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-rotator.mjs");
const routesFixture = path.join(repoRoot, "test", "fixtures", "rotator", "routes.pre.js");
const managerFixture = path.join(repoRoot, "test", "fixtures", "rotator", "manager.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-rotator-"));
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.copyFileSync(routesFixture, path.join(d, "dist", "server", "routes.js"));
  fs.copyFileSync(managerFixture, path.join(d, "dist", "subprocess", "manager.js"));
  return d;
}

test("patch-proxy-rotator: fresh patch succeeds + sentinels present", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const routes = fs.readFileSync(path.join(d, "dist", "server", "routes.js"), "utf8");
  const manager = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"), "utf8");
  assert.ok(routes.includes("@openclaw-bridge:rotator v1"), "routes.js sentinel present");
  assert.ok(manager.includes("@openclaw-bridge:rotator v1"), "manager.js sentinel present");
  const rotatorDir = path.join(d, "dist", "rotator");
  assert.ok(fs.existsSync(path.join(rotatorDir, "index.js")));
  assert.ok(fs.existsSync(path.join(rotatorDir, "pool.js")));
});

test("patch-proxy-rotator: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const after1m = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const after2m = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  assert.ok(after1.equals(after2), "routes.js byte-identical on re-run");
  assert.ok(after1m.equals(after2m), "manager.js byte-identical on re-run");
});

test("patch-proxy-rotator: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.ok(/WOULD patch/.test(out));
  const after = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(before.equals(after), "no changes on dry-run");
});

test("patch-proxy-rotator: missing anchor → non-zero exit with 'anchor' in stderr", () => {
  const d = mkFakeProxy();
  // Mutate routes.js to remove anchor
  fs.writeFileSync(path.join(d, "dist", "server", "routes.js"), "// no anchor here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected patcher to exit non-zero");
  assert.match(err.stderr.toString(), /anchor/i);
});

test("patch-proxy-rotator: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
```

Add a `test:patcher` script to `package.json`:

```json
    "test:patcher": "node --test scripts/patch-proxy-rotator.test.mjs",
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:patcher`
Expected: FAIL — patcher file missing.

- [ ] **Step 4: Write the patcher**

`scripts/patch-proxy-rotator.mjs`:

```js
#!/usr/bin/env node
// Idempotent installer-patcher: injects the rotator into an installed
// claude-max-api-proxy tree. Guarded by the sentinel `@openclaw-bridge:rotator v1`.
//
// Usage: node patch-proxy-rotator.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:rotator v1";
const SENTINEL_END = "// @openclaw-bridge:rotator-end v1";

const ROUTES_ANCHOR = `        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();`;

const ROUTES_REPLACEMENT = `        const cliInput = openaiToCli(body);
        ${SENTINEL}
        const { prepare: __rotatorPrepare, complete: __rotatorComplete } = await import("../rotator/index.js");
        const __rotatorCtx = await __rotatorPrepare(body);
        if (__rotatorCtx && __rotatorCtx.noHealthy) {
            res.status(429).json({ error: { type: "rate_limit", message: "rotator_" + __rotatorCtx.noHealthy } });
            return;
        }
        const subprocess = new ClaudeSubprocess();
        subprocess.envOverrides = __rotatorCtx ? __rotatorCtx.env : {};
        subprocess.once("close", (__code) => {
            __rotatorComplete(__rotatorCtx, { exitCode: __code, stderrTail: subprocess.stderrTail });
        });
        ${SENTINEL_END}`;

const MANAGER_ENV_FROM = `                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });`;

const MANAGER_ENV_TO = `                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    ${SENTINEL}
                    env: { ...process.env, ...(this.envOverrides || {}) },
                    stdio: ["pipe", "pipe", "pipe"],
                });`;

const MANAGER_STDERR_FROM = `                this.process.stderr?.on("data", (chunk) => {
                    armIdleTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });`;

const MANAGER_STDERR_TO = `                this.process.stderr?.on("data", (chunk) => {
                    armIdleTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        ${SENTINEL}
                        this.stderrTail = ((this.stderrTail || "") + errorText + "\\n").slice(-4096);
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });`;

const ROTATOR_FILES = ["index.js", "pool.js", "policy.js", "detector.js", "classify.js", "logger.js"];

function die(msg, code = 1) {
  console.error(`patch-proxy-rotator: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-rotator.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const distDir = path.join(proxyRoot, "dist");
const routesPath = path.join(distDir, "server", "routes.js");
const managerPath = path.join(distDir, "subprocess", "manager.js");
const rotatorDestDir = path.join(distDir, "rotator");

for (const p of [routesPath, managerPath]) {
  if (!fs.existsSync(p)) die(`expected file not found: ${p}`);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const rotatorSrc = path.join(repoRoot, "rotator");
if (!fs.existsSync(rotatorSrc)) die(`rotator source not found: ${rotatorSrc}`);

const copyPlan = ROTATOR_FILES.map(f => {
  const src = path.join(rotatorSrc, f);
  const dest = path.join(rotatorDestDir, f);
  if (!fs.existsSync(src)) die(`missing rotator source: ${src}`);
  return { src, dest };
});

const routesOrig = fs.readFileSync(routesPath, "utf8");
const managerOrig = fs.readFileSync(managerPath, "utf8");
const routesAlreadyPatched = routesOrig.includes(SENTINEL);
const managerAlreadyPatched = managerOrig.includes(SENTINEL);

let routesUpdated = routesOrig;
let managerUpdated = managerOrig;

if (!routesAlreadyPatched) {
  if (!routesOrig.includes(ROUTES_ANCHOR)) die("routes.js anchor changed — upstream bumped; update patch-proxy-rotator.mjs");
  routesUpdated = routesOrig.replace(ROUTES_ANCHOR, ROUTES_REPLACEMENT);
}
if (!managerAlreadyPatched) {
  if (!managerOrig.includes(MANAGER_ENV_FROM)) die("manager.js env anchor changed — upstream bumped");
  if (!managerOrig.includes(MANAGER_STDERR_FROM)) die("manager.js stderr anchor changed — upstream bumped");
  managerUpdated = managerOrig.replace(MANAGER_ENV_FROM, MANAGER_ENV_TO).replace(MANAGER_STDERR_FROM, MANAGER_STDERR_TO);
}

if (dryRun) {
  console.log(`patch-proxy-rotator: dry-run against ${proxyRoot}`);
  console.log(`  routes.js : ${routesAlreadyPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  manager.js: ${managerAlreadyPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  rotator/  : WOULD copy ${copyPlan.length} files → ${rotatorDestDir}`);
  process.exit(0);
}

fs.mkdirSync(rotatorDestDir, { recursive: true });
for (const { src, dest } of copyPlan) fs.copyFileSync(src, dest);
if (!routesAlreadyPatched) fs.writeFileSync(routesPath, routesUpdated);
if (!managerAlreadyPatched) fs.writeFileSync(managerPath, managerUpdated);

console.log(`patch-proxy-rotator: installed at ${rotatorDestDir}`);
console.log(`  routes.js : ${routesAlreadyPatched ? "unchanged (already patched)" : "patched"}`);
console.log(`  manager.js: ${managerAlreadyPatched ? "unchanged (already patched)" : "patched"}`);
```

- [ ] **Step 5: Make executable + run test**

```bash
chmod +x scripts/patch-proxy-rotator.mjs
npm run test:patcher
```
Expected: PASS, all 5 patcher tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/patch-proxy-rotator.mjs scripts/patch-proxy-rotator.test.mjs test/fixtures/rotator/routes.pre.js test/fixtures/rotator/manager.pre.js package.json
git commit -m "feat(install): add idempotent patch-proxy-rotator.mjs with fixture tests"
```

---

## Task 11: Install-time wiring — `install.sh` + templates + `--enable-multi-account`

**Purpose:** Run the new patcher after the existing adapter patch. Scaffold `accounts.json`. Link `cli/openclaw-bridge` onto PATH. Add `--enable-multi-account` risk-acknowledgement flag.

**Files:**
- Modify: `install.sh`
- Create: `templates/accounts.json.tmpl`
- Create: `templates/rotator.config.json.tmpl`

- [ ] **Step 1: Create template files**

`templates/accounts.json.tmpl`:

```json
{
  "mode": "single",
  "accounts": []
}
```

`templates/rotator.config.json.tmpl`:

```json
{
  "cooldowns": {
    "rate_limit": 60,
    "usage_limit": 18000,
    "auth": -1,
    "other": 30
  },
  "heartbeatModels": ["claude-haiku-4", "claude-haiku-4-20250514"],
  "autoClearCircuit": true
}
```

- [ ] **Step 2: Read current end of `install.sh` to find safe insertion points**

Run: `grep -n "patch-adapter\|log_info.*installer\|verify.sh" install.sh`
Use the output to locate exactly where the adapter patch runs (line 163 per earlier inspection) and the end of the install.

- [ ] **Step 3: Add `--enable-multi-account` flag parsing to `install.sh`**

At the top of `install.sh`, in the flag-parsing block (near `WITH_CLAUDE_PERMS="prompt"`), add:

```bash
ENABLE_MULTI_ACCOUNT=0
```

In the `while [[ $# -gt 0 ]]; do case "$1" in` block, add before the `-h|--help)` line:

```bash
    --enable-multi-account)     ENABLE_MULTI_ACCOUNT=1; shift ;;
```

In the `usage()` function, add to the flags list:

```
  --enable-multi-account         Print risk notice for multi-account rotator (heavy-user opt-in)
```

- [ ] **Step 4: Add rotator patcher invocation to `install.sh`**

Immediately after the existing `patch-adapter.mjs` invocation (line 163 area), add:

```bash
log_info "Running patch-proxy-rotator.mjs to install the rotator into the proxy tree…"
node "$REPO_ROOT/scripts/patch-proxy-rotator.mjs" "$PROXY_HOME" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run)
```

- [ ] **Step 5: Scaffold `accounts.json` + link CLI**

Add a new step after the rotator patch:

```bash
log_info "Scaffolding rotator bridge state…"
BRIDGE_DIR="$HOME/.openclaw/bridge"
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$BRIDGE_DIR"
  if [[ ! -f "$BRIDGE_DIR/accounts.json" ]]; then
    cp "$REPO_ROOT/templates/accounts.json.tmpl" "$BRIDGE_DIR/accounts.json"
    log_info "Created $BRIDGE_DIR/accounts.json (mode=single)"
  else
    log_info "Kept existing $BRIDGE_DIR/accounts.json"
  fi
fi

log_info "Linking openclaw-bridge CLI onto PATH…"
NPM_BIN="$(npm prefix -g)/bin"
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$NPM_BIN"
  ln -sf "$REPO_ROOT/cli/openclaw-bridge" "$NPM_BIN/openclaw-bridge"
fi
```

- [ ] **Step 6: Add risk-gate prompt for `--enable-multi-account`**

After the above, add:

```bash
if [[ $ENABLE_MULTI_ACCOUNT -eq 1 ]]; then
  cat <<'RISK'

╔════════════════════════════════════════════════════════════════════╗
║                    MULTI-ACCOUNT ROTATOR — RISK                    ║
╠════════════════════════════════════════════════════════════════════╣
║ Pooling multiple Claude Max accounts to avoid rate/usage limits    ║
║ may be treated by Anthropic as abuse of the Services.              ║
║ Detection can cause SIMULTANEOUS TERMINATION of every account.     ║
║ See docs/MULTI_ACCOUNT.md for the full risk breakdown.             ║
║ Use at your own risk.                                              ║
╚════════════════════════════════════════════════════════════════════╝

To continue, type exactly:  I accept the risk
RISK
  read -r ACK
  if [[ "$ACK" != "I accept the risk" ]]; then
    log_warn "Multi-account risk not acknowledged — rotator code is installed but mode stays 'single'."
  else
    log_info "Risk acknowledged. Rotator code installed. Next: openclaw-bridge accounts add <label>"
  fi
fi
```

- [ ] **Step 7: Run a dry-run install to verify ordering**

```bash
./install.sh --dry-run
```
Expected: output shows adapter patch + rotator patch invocation order, no errors.

- [ ] **Step 8: Run the real install (on a throwaway environment or the live machine if OK)**

```bash
./install.sh
```
Then verify:

```bash
ls ~/.openclaw/bridge/accounts.json
which openclaw-bridge
grep "openclaw-bridge:rotator v1" ~/.openclaw/bridge/claude-max-api-proxy/dist/server/routes.js
grep "openclaw-bridge:rotator v1" ~/.openclaw/bridge/claude-max-api-proxy/dist/subprocess/manager.js
```
Expected: all checks show expected state.

- [ ] **Step 9: Commit**

```bash
git add install.sh templates/accounts.json.tmpl templates/rotator.config.json.tmpl
git commit -m "feat(install): wire rotator patcher + CLI symlink + --enable-multi-account risk gate"
```

---

## Task 12: CLI entry point + `_common.mjs` helpers

**Purpose:** `cli/openclaw-bridge` routes subcommands; `_common.mjs` gives sub-commands shared helpers (path resolution, risk-prompt phrase check, atomic JSON writes).

**Files:**
- Create: `cli/openclaw-bridge`
- Create: `cli/commands/_common.mjs`

- [ ] **Step 1: Write the dispatcher**

`cli/openclaw-bridge`:

```bash
#!/usr/bin/env node
import url from "node:url";
import path from "node:path";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const commands = {
  accounts:    "./commands/accounts.mjs",
  mode:        "./commands/mode.mjs",
  status:      "./commands/status.mjs",
  tail:        "./commands/tail.mjs",
  reload:      "./commands/reload.mjs",
  "rotate-now": "./commands/rotate-now.mjs",
  circuit:     "./commands/circuit.mjs",
};

const [sub, ...rest] = process.argv.slice(2);
if (!sub || sub === "-h" || sub === "--help") {
  console.log(`openclaw-bridge <command> [args]

Commands:
  accounts {add|list|rm|test} [label]    manage pooled accounts
  mode {single|multi}                    flip rotator mode
  status                                 mode + health + recent decisions
  tail                                   live rotator.log
  reload                                 restart proxy via launchctl
  rotate-now                             clear sticky lastMainLabel
  circuit {status|probe|clear}           auth-cascade circuit breaker
`);
  process.exit(sub ? 0 : 1);
}

const rel = commands[sub];
if (!rel) {
  console.error(`openclaw-bridge: unknown command "${sub}"`);
  process.exit(2);
}
const mod = await import(path.join(here, rel));
await mod.default(rest);
```

- [ ] **Step 2: Write `_common.mjs`**

`cli/commands/_common.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const RISK_PHRASE = "I accept the risk";

export function bridgeDir() {
  return process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR
    || path.join(os.homedir(), ".openclaw", "bridge");
}

export function logPath() {
  return process.env.OPENCLAW_BRIDGE_ROTATOR_LOG
    || path.join(os.homedir(), ".openclaw", "logs", "rotator.log");
}

export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return fallback; }
}

export function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function printRiskBanner() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                    MULTI-ACCOUNT ROTATOR — RISK                    ║
╠════════════════════════════════════════════════════════════════════╣
║ Pooling multiple Claude Max accounts may be treated by Anthropic   ║
║ as abuse of the Services. Detection can cause SIMULTANEOUS         ║
║ TERMINATION of every account in the pool.                          ║
║ See docs/MULTI_ACCOUNT.md for the full risk breakdown.             ║
╚════════════════════════════════════════════════════════════════════╝
`);
}

export async function requireRiskPhrase(prompt = `Type exactly:  ${RISK_PHRASE}\n> `) {
  printRiskBanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(prompt, resolve));
  rl.close();
  if (answer.trim() !== RISK_PHRASE) {
    console.error(`Aborted: phrase did not match "${RISK_PHRASE}".`);
    process.exit(1);
  }
}

export function validateLabel(label) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(label)) {
    console.error(`Invalid label "${label}" — must match [a-z0-9][a-z0-9_-]{0,31}`);
    process.exit(2);
  }
}
```

- [ ] **Step 3: Make dispatcher executable**

```bash
chmod +x cli/openclaw-bridge
```

- [ ] **Step 4: Test the dispatcher (no-op since subcommands don't exist yet)**

Run: `node cli/openclaw-bridge --help`
Expected: usage text printed, exit 0.

Run: `node cli/openclaw-bridge accounts`
Expected: fails cleanly because commands/accounts.mjs doesn't exist yet — that's fine, we're wiring the dispatcher in this task only.

- [ ] **Step 5: Commit**

```bash
git add cli/openclaw-bridge cli/commands/_common.mjs
git commit -m "feat(cli): openclaw-bridge dispatcher + shared helpers"
```

---

## Task 13: CLI `accounts` subcommand (add / list / rm / test)

**Purpose:** Manage the pool.

**Files:**
- Create: `cli/commands/accounts.mjs`

- [ ] **Step 1: Implement all four verbs**

`cli/commands/accounts.mjs`:

```js
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
```

- [ ] **Step 2: Smoke-test `list` with no accounts**

```bash
# With OPENCLAW_BRIDGE_ACCOUNTS_DIR set to a temp dir for safety:
export OPENCLAW_BRIDGE_ACCOUNTS_DIR=$(mktemp -d)
mkdir -p "$OPENCLAW_BRIDGE_ACCOUNTS_DIR"
node cli/openclaw-bridge accounts list
```
Expected: "No accounts registered..." message, exit 0.

- [ ] **Step 3: Commit**

```bash
git add cli/commands/accounts.mjs
git commit -m "feat(cli): openclaw-bridge accounts {add|list|rm|test}"
```

---

## Task 14: CLI `mode` subcommand

**Files:**
- Create: `cli/commands/mode.mjs`

- [ ] **Step 1: Implement**

`cli/commands/mode.mjs`:

```js
import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic, requireRiskPhrase } from "./_common.mjs";

export default async function modeCmd(args) {
  const target = args[0];
  if (!target || !["single", "multi"].includes(target)) {
    console.error("usage: openclaw-bridge mode {single|multi}");
    process.exit(2);
  }
  const p = path.join(bridgeDir(), "accounts.json");
  const reg = readJson(p, { mode: "single", accounts: [] });
  if (reg.mode === target) {
    console.log(`Mode already ${target}. No change.`);
    return;
  }
  if (target === "multi") {
    if ((reg.accounts || []).length < 2) {
      console.error("Refusing to flip to multi: register at least 2 accounts first.");
      console.error("  openclaw-bridge accounts add <label>");
      process.exit(1);
    }
    await requireRiskPhrase();
  }
  reg.mode = target;
  writeJsonAtomic(p, reg);
  console.log(`Mode set to ${target}.`);
  console.log("Run: openclaw-bridge reload (optional, takes effect within 1s anyway)");
}
```

- [ ] **Step 2: Smoke-test refusal path (no accounts)**

```bash
export OPENCLAW_BRIDGE_ACCOUNTS_DIR=$(mktemp -d)
echo '{"mode":"single","accounts":[]}' > "$OPENCLAW_BRIDGE_ACCOUNTS_DIR/accounts.json"
node cli/openclaw-bridge mode multi
```
Expected: exits 1 with "Refusing to flip" message.

- [ ] **Step 3: Commit**

```bash
git add cli/commands/mode.mjs
git commit -m "feat(cli): openclaw-bridge mode {single|multi} with risk gate"
```

---

## Task 15: CLI `status` + `tail` subcommands

**Files:**
- Create: `cli/commands/status.mjs`
- Create: `cli/commands/tail.mjs`

- [ ] **Step 1: Implement `status`**

`cli/commands/status.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { bridgeDir, readJson, logPath } from "./_common.mjs";

export default async function statusCmd() {
  const reg = readJson(path.join(bridgeDir(), "accounts.json"), { mode: "single", accounts: [] });
  const state = readJson(path.join(bridgeDir(), "state.json"), { accounts: {}, recentOutcomes: [] });
  console.log(`mode:                 ${reg.mode}`);
  console.log(`accounts:             ${reg.accounts.length}`);
  if (state.circuitTrippedAt) {
    console.log(`CIRCUIT:              TRIPPED since ${new Date(state.circuitTrippedAt).toISOString()}`);
    if (state.nextProbeAt) {
      console.log(`next probe:           ${new Date(state.nextProbeAt).toISOString()}`);
    } else {
      console.log(`next probe:           (auto-probe disabled / exhausted)`);
    }
    console.log(`probe attempts:       ${state.probeAttempts || 0}`);
  } else {
    console.log(`CIRCUIT:              clean`);
  }
  if (state.poolQuietUntil && state.poolQuietUntil > Date.now()) {
    console.log(`pool quiet until:     ${new Date(state.poolQuietUntil).toISOString()}`);
  } else {
    console.log(`pool quiet:           no`);
  }
  console.log("");
  console.log("accounts:");
  for (const a of reg.accounts) {
    const s = state.accounts?.[a.label] || {};
    const cu = !s.cooling_until || s.cooling_until === 0 ? "-" :
               s.cooling_until === Number.MAX_SAFE_INTEGER ? "∞ (auth)" :
               new Date(s.cooling_until).toISOString().slice(0, 19);
    console.log(`  ${a.label.padEnd(10)} inflight=${s.inflight || 0} cooling=${cu} rlStreak=${s.rateLimitStreak || 0}`);
  }
  console.log("");
  console.log("last 10 decisions:");
  try {
    const lines = fs.readFileSync(logPath(), "utf8").trim().split("\n");
    for (const ln of lines.slice(-10)) {
      try { const e = JSON.parse(ln); console.log(`  ${e.ts || ""} ${e.event} ${e.label || ""} ${e.outcome || e.reason || ""}`); }
      catch { console.log(`  ${ln}`); }
    }
  } catch { console.log("  (no rotator.log yet)"); }
}
```

- [ ] **Step 2: Implement `tail`**

`cli/commands/tail.mjs`:

```js
import { spawn } from "node:child_process";
import { logPath } from "./_common.mjs";

export default async function tailCmd() {
  const p = logPath();
  const t = spawn("tail", ["-F", p], { stdio: ["ignore", "pipe", "inherit"] });
  t.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        console.log(`${e.ts || ""}  ${e.event.padEnd(22)}  ${e.label || ""}  ${e.outcome || e.reason || ""}`);
      } catch { console.log(line); }
    }
  });
  process.on("SIGINT", () => { t.kill("SIGTERM"); process.exit(0); });
}
```

- [ ] **Step 3: Smoke-test status**

```bash
export OPENCLAW_BRIDGE_ACCOUNTS_DIR=$(mktemp -d)
echo '{"mode":"single","accounts":[]}' > "$OPENCLAW_BRIDGE_ACCOUNTS_DIR/accounts.json"
node cli/openclaw-bridge status
```
Expected: prints "mode: single", "CIRCUIT: clean", "pool quiet: no", "(no rotator.log yet)".

- [ ] **Step 4: Commit**

```bash
git add cli/commands/status.mjs cli/commands/tail.mjs
git commit -m "feat(cli): openclaw-bridge status + tail"
```

---

## Task 16: CLI `reload` + `rotate-now` subcommands

**Files:**
- Create: `cli/commands/reload.mjs`
- Create: `cli/commands/rotate-now.mjs`

- [ ] **Step 1: Implement `reload`**

`cli/commands/reload.mjs`:

```js
import { spawnSync } from "node:child_process";

export default async function reloadCmd() {
  const uid = process.getuid ? process.getuid() : 501;
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/ai.claude-max-api-proxy`], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`launchctl kickstart failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
  console.log("Proxy restarted.");
}
```

- [ ] **Step 2: Implement `rotate-now`**

`cli/commands/rotate-now.mjs`:

```js
import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic } from "./_common.mjs";

export default async function rotateNowCmd() {
  const p = path.join(bridgeDir(), "state.json");
  const state = readJson(p, null);
  if (!state) {
    console.log("No state.json yet — nothing to rotate.");
    return;
  }
  state.lastMainLabel = null;
  writeJsonAtomic(p, state);
  console.log("Cleared lastMainLabel. Next main request will re-pick without sticky bias.");
}
```

- [ ] **Step 3: Smoke-test `rotate-now` on empty state**

```bash
export OPENCLAW_BRIDGE_ACCOUNTS_DIR=$(mktemp -d)
node cli/openclaw-bridge rotate-now
```
Expected: "No state.json yet..." message.

- [ ] **Step 4: Commit**

```bash
git add cli/commands/reload.mjs cli/commands/rotate-now.mjs
git commit -m "feat(cli): openclaw-bridge reload + rotate-now"
```

---

## Task 17: CLI `circuit` subcommand (status / probe / clear)

**Files:**
- Create: `cli/commands/circuit.mjs`

- [ ] **Step 1: Implement**

`cli/commands/circuit.mjs`:

```js
import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic, requireRiskPhrase } from "./_common.mjs";

function statePath() { return path.join(bridgeDir(), "state.json"); }

function cmdStatus() {
  const state = readJson(statePath(), null);
  if (!state || !state.circuitTrippedAt) {
    console.log("Circuit: clean (not tripped)");
    return;
  }
  console.log(`Circuit:         TRIPPED`);
  console.log(`Tripped at:      ${new Date(state.circuitTrippedAt).toISOString()}`);
  console.log(`Probe attempts:  ${state.probeAttempts || 0}`);
  if (state.nextProbeAt) {
    console.log(`Next probe:      ${new Date(state.nextProbeAt).toISOString()}`);
  } else {
    console.log(`Next probe:      (none — auto-probe disabled or exhausted)`);
  }
}

async function cmdProbe() {
  const { probeOnce, scheduleProbeTimer } = await import("../../rotator/index.js");
  const result = await probeOnce();
  console.log(JSON.stringify(result, null, 2));
  // Re-arm in case state.nextProbeAt changed
  try { scheduleProbeTimer(); } catch {}
}

async function cmdClear(...flags) {
  const skipProbe = flags.includes("--skip-probe");
  await requireRiskPhrase(`Manually clearing the circuit breaker — type:  I accept the risk\n> `);
  if (!skipProbe) {
    console.log("Running probe before clearing…");
    await cmdProbe();
    // If probe cleared, we're done
    const state = readJson(statePath(), {});
    if (!state.circuitTrippedAt) return;
    console.log("Probe did not succeed — clearing manually anyway.");
  }
  const state = readJson(statePath(), {});
  state.circuitTrippedAt = null;
  state.nextProbeAt = null;
  state.probeAttempts = 0;
  // Clear indefinite cooldowns on auth-cooled accounts
  for (const [label, a] of Object.entries(state.accounts || {})) {
    if (a.cooling_until === Number.MAX_SAFE_INTEGER) a.cooling_until = 0;
  }
  writeJsonAtomic(statePath(), state);
  console.log("Circuit cleared.");
}

export default async function circuitCmd(args) {
  const [verb, ...rest] = args;
  switch (verb) {
    case "status": return cmdStatus();
    case "probe":  return cmdProbe();
    case "clear":  return cmdClear(...rest);
    default:
      console.error("usage: openclaw-bridge circuit {status|probe|clear [--skip-probe]}");
      process.exit(2);
  }
}
```

- [ ] **Step 2: Smoke-test `circuit status` on clean state**

```bash
export OPENCLAW_BRIDGE_ACCOUNTS_DIR=$(mktemp -d)
node cli/openclaw-bridge circuit status
```
Expected: "Circuit: clean (not tripped)"

- [ ] **Step 3: Commit**

```bash
git add cli/commands/circuit.mjs
git commit -m "feat(cli): openclaw-bridge circuit {status|probe|clear}"
```

---

## Task 18: Shell smoke tests — `test/rotator.smoke.sh`

**Purpose:** End-to-end assertions that don't require real Claude OAuth. Verify:
- Sentinels present at expected injection sites in patched proxy files.
- Byte-identical re-install.
- Single-mode no-op via rotator.prepare.
- Multi-mode env injection via rotator.prepare with fixture configDir.
- Patcher guardrails.

**Files:**
- Create: `test/rotator.smoke.sh`
- Modify: `test/smoke.sh` (call rotator.smoke.sh if present)

- [ ] **Step 1: Write `test/rotator.smoke.sh`**

```bash
#!/usr/bin/env bash
# Rotator smoke test — does NOT require real Claude OAuth.
# Run from repo root: bash test/rotator.smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
PATCHER="$REPO_ROOT/scripts/patch-proxy-rotator.mjs"
FIXTURES="$REPO_ROOT/test/fixtures/rotator"

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "[rotator smoke] building fake proxy tree…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/dist/server" "$TMP/dist/subprocess"
cp "$FIXTURES/routes.pre.js" "$TMP/dist/server/routes.js"
cp "$FIXTURES/manager.pre.js" "$TMP/dist/subprocess/manager.js"

echo "[rotator smoke] dry-run…"
OUT="$(node "$PATCHER" "$TMP" --dry-run)"
[[ "$OUT" == *"WOULD patch"* ]] && pass "dry-run reports plan" || fail "dry-run did not report plan"

echo "[rotator smoke] fresh patch…"
node "$PATCHER" "$TMP" > /dev/null
grep -q "@openclaw-bridge:rotator v1" "$TMP/dist/server/routes.js" && pass "routes.js sentinel present" || fail "routes.js sentinel missing"
grep -q "@openclaw-bridge:rotator v1" "$TMP/dist/subprocess/manager.js" && pass "manager.js sentinel present" || fail "manager.js sentinel missing"
[[ -f "$TMP/dist/rotator/index.js" ]] && pass "rotator/index.js staged" || fail "rotator/index.js missing"

echo "[rotator smoke] byte-identical re-patch…"
SHA1=$(shasum "$TMP/dist/server/routes.js" | awk '{print $1}')
SHA1M=$(shasum "$TMP/dist/subprocess/manager.js" | awk '{print $1}')
node "$PATCHER" "$TMP" > /dev/null
SHA2=$(shasum "$TMP/dist/server/routes.js" | awk '{print $1}')
SHA2M=$(shasum "$TMP/dist/subprocess/manager.js" | awk '{print $1}')
[[ "$SHA1" == "$SHA2" ]] && pass "routes.js byte-identical on re-run" || fail "routes.js changed on re-run"
[[ "$SHA1M" == "$SHA2M" ]] && pass "manager.js byte-identical on re-run" || fail "manager.js changed on re-run"

echo "[rotator smoke] single-mode no-op (in-process)…"
SINGLE_DIR="$(mktemp -d)"
echo '{"mode":"single","accounts":[]}' > "$SINGLE_DIR/accounts.json"
OPENCLAW_BRIDGE_ACCOUNTS_DIR="$SINGLE_DIR" OPENCLAW_BRIDGE_ROTATOR_LOG="$SINGLE_DIR/rotator.log" node -e "
import('$REPO_ROOT/rotator/index.js').then(async (m) => {
  const ctx = await m.prepare({ model: 'claude-sonnet-4' });
  if (Object.keys(ctx.env).length !== 0) { console.error('env not empty'); process.exit(1); }
  if (ctx.label !== null) { console.error('label not null'); process.exit(1); }
  const fs = await import('node:fs');
  if (fs.existsSync('$SINGLE_DIR/state.json')) { console.error('state.json written in single mode'); process.exit(1); }
  process.exit(0);
});
" && pass "single-mode prepare is no-op" || fail "single-mode prepare wrote state or env"

echo "[rotator smoke] multi-mode env injection…"
MULTI_DIR="$(mktemp -d)"
mkdir -p "$MULTI_DIR/accounts/a/config" "$MULTI_DIR/accounts/b/config"
cat >"$MULTI_DIR/accounts.json" <<JSON
{"mode":"multi","accounts":[{"label":"a","configDir":"$MULTI_DIR/accounts/a/config"},{"label":"b","configDir":"$MULTI_DIR/accounts/b/config"}]}
JSON
OPENCLAW_BRIDGE_ACCOUNTS_DIR="$MULTI_DIR" OPENCLAW_BRIDGE_ROTATOR_LOG="$MULTI_DIR/rotator.log" node -e "
import('$REPO_ROOT/rotator/index.js').then(async (m) => {
  const ctx = await m.prepare({ model: 'claude-sonnet-4' });
  if (!ctx.env.CLAUDE_CONFIG_DIR) { console.error('no CLAUDE_CONFIG_DIR'); process.exit(1); }
  if (!ctx.env.CLAUDE_CONFIG_DIR.includes('$MULTI_DIR')) { console.error('wrong dir: ' + ctx.env.CLAUDE_CONFIG_DIR); process.exit(1); }
  process.exit(0);
});
" && pass "multi-mode prepare sets CLAUDE_CONFIG_DIR" || fail "multi-mode env missing"

echo "[rotator smoke] patcher refuses when anchor missing…"
BAD="$(mktemp -d)"
mkdir -p "$BAD/dist/server" "$BAD/dist/subprocess"
echo '// missing anchor' > "$BAD/dist/server/routes.js"
cp "$FIXTURES/manager.pre.js" "$BAD/dist/subprocess/manager.js"
if node "$PATCHER" "$BAD" 2>&1 | grep -q "anchor"; then pass "patcher rejects missing anchor"
else fail "patcher should have rejected missing anchor"; fi

echo ""
echo "[rotator smoke] $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
```

- [ ] **Step 2: Make executable + wire into `test/smoke.sh`**

```bash
chmod +x test/rotator.smoke.sh
```

At the end of `test/smoke.sh` (before its final exit), append:

```bash
if [[ -x "$(dirname "${BASH_SOURCE[0]}")/rotator.smoke.sh" ]]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/rotator.smoke.sh"
fi
```

(Inspect `test/smoke.sh` first — if it uses a different final-line convention, adapt accordingly.)

- [ ] **Step 3: Run smoke**

```bash
bash test/rotator.smoke.sh
```
Expected: all ✓, no ✗, final line "X passed, 0 failed", exit 0.

- [ ] **Step 4: Commit**

```bash
git add test/rotator.smoke.sh test/smoke.sh
git commit -m "test(rotator): shell smoke for patcher + single/multi-mode + anchor guard"
```

---

## Task 19: `verify.sh` additions

**Purpose:** Post-install sanity checks on the real machine.

**Files:**
- Modify: `verify.sh`

- [ ] **Step 1: Inspect current `verify.sh` to find a safe append point**

```bash
cat verify.sh
```

- [ ] **Step 2: Append rotator checks**

Add this block near the end of `verify.sh`, before its exit:

```bash
echo ""
echo "── rotator checks ───────────────────────────────────────────"

PROXY_DIR="$HOME/.openclaw/bridge/claude-max-api-proxy"
ROUTES="$PROXY_DIR/dist/server/routes.js"
MANAGER="$PROXY_DIR/dist/subprocess/manager.js"
ADAPTER="$PROXY_DIR/dist/adapter/openai-to-cli.js"

check_sentinel() {
  local file="$1" sentinel="$2" label="$3"
  if [[ -f "$file" ]] && grep -q "$sentinel" "$file"; then
    echo "  ✓ $label sentinel present"
  else
    echo "  ✗ $label sentinel missing in $file"
  fi
}

check_sentinel "$ADAPTER" "@openclaw-bridge:extractContent v1" "extractContent"
check_sentinel "$MANAGER" "@openclaw-bridge:idleTimeout v1"     "idleTimeout"
check_sentinel "$ROUTES"  "@openclaw-bridge:rotator v1"         "rotator (routes.js)"
check_sentinel "$MANAGER" "@openclaw-bridge:rotator v1"         "rotator (manager.js)"

if [[ -f "$PROXY_DIR/dist/rotator/index.js" ]]; then
  echo "  ✓ rotator modules staged in proxy tree"
else
  echo "  ✗ rotator modules missing at $PROXY_DIR/dist/rotator/"
fi

ACCOUNTS_JSON="$HOME/.openclaw/bridge/accounts.json"
if [[ -f "$ACCOUNTS_JSON" ]]; then
  if python3 -c "import json; json.load(open('$ACCOUNTS_JSON'))" >/dev/null 2>&1 \
     || node -e "JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8'))" 2>/dev/null; then
    echo "  ✓ accounts.json parses"
  else
    echo "  ✗ accounts.json malformed"
  fi
  MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8')).mode)" 2>/dev/null || echo "unknown")
  echo "  ℹ mode: $MODE"
  if [[ "$MODE" == "multi" ]]; then
    N=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8')).accounts||[]).length)")
    if [[ "$N" -ge 1 ]]; then
      echo "  ✓ $N account(s) registered"
    else
      echo "  ✗ mode=multi but no accounts registered"
    fi
  fi
else
  echo "  ℹ accounts.json absent (clean install — OK)"
fi

if command -v openclaw-bridge >/dev/null 2>&1; then
  openclaw-bridge status >/dev/null 2>&1 && echo "  ✓ openclaw-bridge status runs" || echo "  ✗ openclaw-bridge status failed"
else
  echo "  ✗ openclaw-bridge CLI not on PATH"
fi
```

- [ ] **Step 3: Run verify**

```bash
./verify.sh
```
Expected: rotator checks appended, all present.

- [ ] **Step 4: Commit**

```bash
git add verify.sh
git commit -m "test(verify): rotator post-install sanity checks"
```

---

## Task 20: `docs/MULTI_ACCOUNT.md` — risk-first operator docs

**Purpose:** Write the user-facing guide. Risk block first. Setup steps. Ops recipes. Known limitations.

**Files:**
- Create: `docs/MULTI_ACCOUNT.md`

- [ ] **Step 1: Write the doc**

`docs/MULTI_ACCOUNT.md`:

```markdown
# Multi-account rotator

> **⚠  This feature is materially higher-risk than single-account use.**
> Pooling multiple Claude Max accounts to avoid rate/usage limits may be
> treated by Anthropic as abuse of the Services. Detection can cause the
> **simultaneous termination of every account** you rotate through, not
> just one. Use at your own risk.

## What it does

The rotator hooks the proxy's subprocess spawn to set `CLAUDE_CONFIG_DIR`
per request, routing each turn through a different Claude Max account's
OAuth credentials (kept in isolated per-account directories).

- **Main requests** (model not in `heartbeatModels`) use a
  **sticky-unless-concurrent** strategy — the same account as last turn if
  it's idle and healthy; otherwise the healthy account with lowest inflight.
- **Heartbeats** (model in `heartbeatModels`, default `claude-haiku-4`) use
  **uniform random** over healthy accounts — cloaks the systematic cadence
  across the pool.
- On subprocess close, the outcome is classified (`ok`, `rate_limit`,
  `usage_limit`, `auth`, `other`) and the account is cooled if needed.

## Three-layer cooldown model

1. **Per-account exponential on repeated `rate_limit`.** Each account tracks
   a streak counter. Cooldown = `60s × 2^(streak-1)` capped at 3600s.
   Streak resets on `ok` or 30min of inactivity. `usage_limit` is 18000s
   (matches actual refill). `auth` is indefinite until manually cleared.

2. **Pool-wide quiet period on correlated failures.**
   - ≥2 distinct accounts → `rate_limit` within 120s ⇒ pool quiet 300s
   - ≥2 distinct accounts → `usage_limit` within 600s ⇒ pool quiet 3600s
   - Re-trigger within 30min ⇒ next duration is 2× the last, cap 3600s

   During a quiet period, **the proxy returns HTTP 429**. OpenClaw's
   cross-provider fallback (e.g., Gemini) handles the request.

3. **Auth-cascade circuit breaker (ban-cascade brake).** If ≥2 accounts
   hit `auth` in any 24h window, the circuit trips. `prepare` returns
   `{noHealthy:"circuit_tripped"}` until cleared.

   **Auto-clear** via in-proxy scheduled probe: at T+1h and every 24h
   thereafter (up to 7 attempts), probe sends a minimal request through
   each auth-cooled account's configDir. If all succeed, circuit clears.
   After 7 failing probes, the circuit stays tripped — operator must run
   `openclaw-bridge circuit clear`.

## Setup

### 1. Install

```
./install.sh --enable-multi-account
```

The installer always installs the rotator code. `--enable-multi-account`
prints the risk notice and requires the phrase `I accept the risk`. Mode
is NOT flipped — that's a separate step.

### 2. Register accounts

```
openclaw-bridge accounts add work
openclaw-bridge accounts add personal
openclaw-bridge accounts add research
```

Each invocation creates `~/.openclaw/bridge/accounts/<label>/config/`
(0700) and runs `claude login` against it. Complete the browser OAuth
for the Claude Max account you want to assign to each label.

Labels must match `[a-z0-9][a-z0-9_-]{0,31}`.

Smoke-test each:

```
openclaw-bridge accounts test work
```

### 3. Flip mode

```
openclaw-bridge mode multi
```

Requires ≥2 accounts registered. Prompts for the risk phrase.

```
openclaw-bridge reload    # optional — takes effect within 1s anyway
```

### 4. Observe

```
openclaw-bridge status        # mode + health + circuit + last 10 decisions
openclaw-bridge accounts list # counters per account
openclaw-bridge tail          # live rotator.log
```

## Operations

### Check the circuit

```
openclaw-bridge circuit status
```

### Manually run the probe (e.g., after you re-logged in)

```
openclaw-bridge circuit probe
```

Manual probe ignores the T+1h first-probe floor and the `autoClearCircuit`
config — it always runs.

### Manually clear the circuit

```
openclaw-bridge circuit clear            # runs probe first, then clears
openclaw-bridge circuit clear --skip-probe
```

Both forms require the risk phrase.

### Re-login after `auth` cooldown

```
openclaw-bridge accounts rm <label> --purge
openclaw-bridge accounts add <label>
openclaw-bridge accounts test <label>     # clears cooldown on success
```

### Force a re-pick (clear sticky lastMainLabel)

```
openclaw-bridge rotate-now
```

### Disable without uninstalling

```
openclaw-bridge mode single
openclaw-bridge reload
```

Rotator code stays installed but the single-mode no-op path makes it inert.

### Full removal

```
./uninstall.sh                    # keeps ~/.openclaw/bridge/accounts/
./uninstall.sh --purge-accounts   # deletes per-account credentials too
```

## Configuration

`~/.openclaw/bridge/rotator.config.json` (optional):

```json
{
  "cooldowns": {
    "rate_limit": 60,
    "usage_limit": 18000,
    "auth": -1,
    "other": 30
  },
  "heartbeatModels": ["claude-haiku-4"],
  "autoClearCircuit": true
}
```

- `autoClearCircuit: false` disables the automatic probe timer. Circuit
  only clears via `openclaw-bridge circuit clear`.
- `heartbeatModels: []` routes every request through `pickMain`.

## Known limitations

- **Duplicate-account detection.** The rotator can't tell if you logged
  two labels into the same Anthropic account. Watch per-label counters in
  `accounts list` — they should drift apart.
- **OAuth refresh races.** Two concurrent spawns against the same account
  may both trigger a refresh. The CLI serializes via file lock.
- **Approximate counters under concurrency.** `state.json` uses tmp+rename
  atomicity but readers don't block writers — counters may lag by one
  write.
- **Log growth bounded.** `~/.openclaw/logs/rotator.log` rotates at
  10 MB × 3 generations.
- **No weighted scheduling.** Every healthy account is treated equally.

## Risk summary

Using this feature:

- Doubles-down on automation that Anthropic's ToS may not contemplate.
- Correlates multiple accounts via a single machine fingerprint.
- Can trigger ban cascades if any one of the pooled accounts is flagged.
- Requires separate Claude Max subscriptions — no sharing.

**You are fully responsible for deciding whether this risk is acceptable.**
The maintainer provides this feature AS IS and disclaims all warranties to
the maximum extent permitted by law. See the "Legal notice / Haftungsausschluss"
section in README.
```

- [ ] **Step 2: Commit**

```bash
git add docs/MULTI_ACCOUNT.md
git commit -m "docs(rotator): operator guide with risk-first framing"
```

---

## Task 21: README risk block + pointer

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Inspect current README for the right insertion point**

```bash
grep -n "^#\{1,3\} " README.md | head -20
```

Pick a location near the top (after the intro but before install instructions).

- [ ] **Step 2: Insert risk block**

Add near the top of README.md (after the initial description):

```markdown
## ⚠ Optional: multi-account rotator (higher-risk)

This installer includes an OPTIONAL pool-multiple-Claude-Max-accounts rotator.
It is OFF by default — a fresh install behaves exactly like single-account.

Enabling it is ToS-risky: Anthropic may treat pooled rotation as abuse and can
**simultaneously terminate every account** in the pool if one is flagged.

See [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md) for setup, operations,
risk details, and the auto-recovering auth-cascade circuit breaker.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): pointer + risk block for multi-account rotator"
```

---

## Task 22: `uninstall.sh` rotator awareness + `--purge-accounts`

**Files:**
- Modify: `uninstall.sh`

- [ ] **Step 1: Inspect current uninstall.sh**

```bash
cat uninstall.sh
```

- [ ] **Step 2: Add flag parsing for `--purge-accounts`**

Near the top of `uninstall.sh` in the flag parser, add:

```bash
PURGE_ACCOUNTS=0
```

In the arg loop:

```bash
    --purge-accounts) PURGE_ACCOUNTS=1; shift ;;
```

And in the usage text:

```
  --purge-accounts               Also delete ~/.openclaw/bridge/accounts/* (destroys OAuth creds)
```

- [ ] **Step 3: Add rotator-uninstall steps**

In the main body of `uninstall.sh`, add (near the other unlink steps):

```bash
log_info "Removing openclaw-bridge CLI symlink…"
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
[[ -L "$NPM_BIN/openclaw-bridge" ]] && rm -f "$NPM_BIN/openclaw-bridge"

if [[ $PURGE_ACCOUNTS -eq 1 ]]; then
  log_warn "Purging per-account OAuth credentials at ~/.openclaw/bridge/accounts/"
  read -r -p "Type 'purge' to confirm: " ANS
  if [[ "$ANS" == "purge" ]]; then
    rm -rf "$HOME/.openclaw/bridge/accounts"
    rm -f "$HOME/.openclaw/bridge/accounts.json" "$HOME/.openclaw/bridge/state.json" "$HOME/.openclaw/bridge/rotator.config.json"
    log_info "Purged."
  else
    log_warn "Not purging."
  fi
else
  log_info "Kept ~/.openclaw/bridge/accounts/ (use --purge-accounts to delete)"
fi
```

- [ ] **Step 4: Dry-run**

```bash
./uninstall.sh --help 2>&1 | head -30
```
Expected: `--purge-accounts` shows in usage.

- [ ] **Step 5: Commit**

```bash
git add uninstall.sh
git commit -m "feat(uninstall): remove openclaw-bridge CLI symlink + --purge-accounts"
```

---

## Task 23: Final verification runthrough + tag

**Purpose:** Prove single-mode users have zero regressions; prove multi-mode happy path; tag v1.1.0.

- [ ] **Step 1: Run full unit + patcher tests**

```bash
npm run test:rotator
npm run test:patcher
bash test/rotator.smoke.sh
```
Expected: all green.

- [ ] **Step 2: Full install on the live machine**

```bash
./install.sh
./verify.sh
```
Expected:
- install completes without errors
- verify prints all 3 sentinel checks ✓
- `accounts.json` parses, mode `single`

- [ ] **Step 3: Regression test — existing single-mode behavior unchanged**

With mode=single, trigger a normal agent run through OpenClaw. Example:

```bash
openclaw agent --agent main --message "ping" --local
```
Expected: works exactly like before v1.1.0. No 429s. No changes in latency.

Then:

```bash
cat ~/.openclaw/bridge/state.json 2>/dev/null || echo "(no state.json — correct for single mode)"
```
Expected: "(no state.json — correct for single mode)".

- [ ] **Step 4: Tag v1.1.0**

Only after all the above pass:

```bash
git tag -a v1.1.0 -m "Multi-account rotator (opt-in, risk-gated)"
git push origin v1.1.0 --dry-run   # confirm before real push
```

- [ ] **Step 5: Create the release PR/merge commit (if on a branch)**

If you did this work on a branch (recommended), open a PR via `gh pr create`. Otherwise merge.

---

## Self-review

**Spec coverage check:**

- Architecture (§ spec Architecture) → Tasks 1, 10, 11
- `rotator/index.js` (§ spec Components) → Task 7 + Tasks 8, 9 (extensions)
- `pool.js` → Task 5
- `policy.js` → Task 6
- `classify.js` → Task 2
- `detector.js` → Task 3
- `logger.js` → Task 4
- `patch-proxy-rotator.mjs` → Task 10
- Operator CLI → Tasks 12-17
- install.sh / uninstall.sh → Tasks 11, 22
- verify.sh → Task 19
- Docs (MULTI_ACCOUNT.md) → Task 20
- README risk block → Task 21
- Smoke tests → Task 18
- Single-mode no-op assertion → covered in Task 7 unit test, Task 18 smoke test, Task 23 live regression
- Three-layer cooldown model → Tasks 6 (layer 1), 8 (layer 2), 9 (layer 3 + auto-probe)
- Risk gates (install flag + mode-flip phrase + circuit-clear phrase) → Tasks 11, 14, 17
- Log event audit trail → rotator/index.js + rotator/logger.js + circuit events in Task 9

All spec sections mapped. No gaps found.

**Placeholder scan:** No `TBD`, no "similar to Task N", all code steps have full code.

**Type consistency spot-checks:**

- `prepare(body)` returns `{env, label, kind, config, noHealthy?}` — consistent in all tests and patcher-injected caller.
- `complete(ctx, {exitCode, stderrTail})` — consistent in all callers.
- State shape: `{lastMainLabel, poolQuietUntil, poolQuietLastTriggeredAt, circuitTrippedAt, nextProbeAt, probeAttempts, recentOutcomes, accounts:{}}` — defined in `pool.js` DEFAULT_STATE, referenced consistently in tests.
- Account slot shape: `{inflight, cooling_until, rateLimitStreak, lastPickedAt, lastCheckedAt, lastReleasedAt, counters}` — defined in `pool.ensureAccountSlot`, referenced consistently.
- Outcome enum: `ok | rate_limit | usage_limit | auth | other` — consistent.

Looks internally consistent.
