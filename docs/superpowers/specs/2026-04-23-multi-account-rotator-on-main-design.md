# Multi-Account Rotator on `main` — Design

**Status:** draft — brainstorming approved, plan pending
**Date:** 2026-04-23
**Target:** `stammi922/openclaw-local-bridge-macos` (v1.1.0)
**Context:** The `feat/multi-account-rotator` branch (PR #1, still open, 8 commits) was cut before the MCP bridge + idle-timer patches landed on `main`. Rather than merge the diverged branch, this spec describes a fresh integration of the rotator's core concepts into current `main`.

---

## Goal

Let a single OpenClaw-on-Max user pool several Claude Max accounts to avoid the 5-hour rolling usage cap, per-minute rate throttling, and heartbeat-cadence fingerprinting — **without changing behavior for anyone who does not opt in.**

## Non-goals

- Upstream contribution to `ulmeanuadrian/openclaw-local-bridge`. This lives on `stammi922` only.
- Weighted scheduling across accounts with different quotas.
- Duplicate-account detection (two labels logged into the same Anthropic account).
- Token extraction or plaintext bearer handling. The rotator never sees OAuth secrets; it only flips `CLAUDE_CONFIG_DIR` so the `claude` CLI does its own Keychain/file lookup in an isolated directory.
- Sharing accounts across users / machines.

## Prime constraint

**Never break single-account installs.** Every code path must degrade to today's behavior when `accounts.json.mode !== "multi"` or when any rotator module throws. Smoke-test asserts single-mode no-op.

---

## Architecture

New files land on `main` as:

```
rotator/                           # pure ESM, copied into <proxy>/dist/rotator/ at install
  index.js                         # prepare(body) / complete(ctx, result) / snapshot() / refresh()
  pool.js                          # accounts.json + state.json I/O, atomic tmp+rename, 1s read cache
  policy.js                        # pickMain (sticky-unless-concurrent), pickHeartbeat (uniform random)
  detector.js                      # (exitCode, stderrTail) → ok|rate_limit|usage_limit|auth|other
  classify.js                      # request body → "heartbeat" | "main"  (model-match)
  logger.js                        # JSONL, 10MB × 3 generations
cli/
  openclaw-bridge                  # node shebang, dispatches to commands/*.mjs
  commands/{accounts,mode,status,tail,reload,rotate-now,circuit,_common}.mjs
scripts/patch-proxy-rotator.mjs    # third sentinel: @openclaw-bridge:rotator v1
templates/{accounts.json,rotator.config.json}.tmpl
docs/MULTI_ACCOUNT.md              # risk-first operator docs (fresh rewrite)
test/rotator.smoke.sh              # extends existing smoke.sh with rotator assertions
test/fixtures/                     # accounts.json + state.json + plist fixtures
verify.sh                          # extended with rotator post-install checks
```

The installed runtime state lives under `~/.openclaw/bridge/`:

```
accounts.json                      # {mode: "single"|"multi", accounts: [{label, configDir}]}
state.json                         # {lastMainLabel, poolQuietUntil, circuitTrippedAt, nextProbeAt,
                                   #  probeAttempts, recentOutcomes:[...], accounts: {<label>: {...}}}
rotator.config.json                # optional user overrides (cooldowns, heartbeatModels, autoClearCircuit)
accounts/<label>/config/           # 0700, per-account CLAUDE_CONFIG_DIR root
~/.openclaw/logs/rotator.log       # JSONL decisions + outcomes + circuit events
```

**Install order in `install.sh`** (sequencing is load-bearing — rotator anchors match the post-idle-timer shape of `manager.js`):

```
patch-gateway-plist.mjs
  → existing proxy patches: idle-timer, extract-content
  → NEW: patch-proxy-rotator.mjs <proxy-root>     ← third sentinel, applied last
```

**Default state at fresh install:** `accounts.json` = `{mode:"single", accounts:[]}`. `prepare()` returns `{env:{}}`. Zero behavior delta vs. pre-rotator `main`.

**Opt-in path** (explicit, gated, reversible):

1. `./install.sh --enable-multi-account` prints the risk notice and requires the exact phrase `I accept the risk`. It does NOT flip mode — it just records intent.
2. `openclaw-bridge accounts add <label>` — risk prompt, creates per-account dir, wraps `claude login`, registers label.
3. `openclaw-bridge mode multi` — second risk prompt with `I accept the risk` phrase gate.
4. `openclaw-bridge reload` (optional) — kicks the proxy for immediate effect; otherwise the 1s cache picks it up naturally.

---

## Components

| Unit | Purpose | Interface | Depends on |
|------|---------|-----------|------------|
| `rotator/index.js` | Orchestrator; only thing the proxy imports | `prepare(body)`, `complete(ctx, {exitCode,stderrTail})`, `snapshot()`, `refresh()` | pool, policy, classify, detector, logger |
| `rotator/pool.js` | Registry + state I/O with atomic writes, 1s read cache | `loadRegistry()`, `loadState()`, `saveState(s)`, `ensureAccountSlot(s,label)` | `node:fs`, tmp+rename |
| `rotator/policy.js` | Pick strategies, health filtering, inflight bookkeeping | `pickMain`, `pickHeartbeat`, `markChecked`, `markReleased` | none (pure) |
| `rotator/classify.js` | Request → `"heartbeat"` \| `"main"` via model-match | `classifyRequest(body, cfg)` | none (pure) |
| `rotator/detector.js` | Subprocess outcome → `ok\|rate_limit\|usage_limit\|auth\|other` | `classifyOutcome(exitCode, stderrTail, patterns)` | none (pure) |
| `rotator/logger.js` | JSONL, 10MB × 3 rotation; never throws into caller | `log(obj)` | `node:fs` |
| `scripts/patch-proxy-rotator.mjs` | Idempotent install-time patcher; copies rotator/ into proxy tree + sentinels routes.js & manager.js | `patch-proxy-rotator.mjs <proxy-root> [--dry-run]` | requires prior sentinels present, refuses unknown shapes |
| `cli/openclaw-bridge` + `commands/*.mjs` | Operator UX, one file per verb | `accounts {add,list,rm,test}`, `mode <single\|multi>`, `status`, `tail`, `reload`, `rotate-now`, `circuit {status,probe,clear}` | `rotator/` read-only, `launchctl`, `claude login` |
| `install.sh` / `uninstall.sh` | Wire patcher + templates + risk-gate prompt (`--enable-multi-account`); uninstall `--purge-accounts` | shell | existing install scaffolding |
| `verify.sh` | Post-install sanity | shell | installed rotator |
| `test/rotator.smoke.sh` | Single-mode no-op + multi-mode env injection + patcher idempotency | shell + node harness | fixtures in `test/fixtures/` |

### Isolation properties (explicit invariants)

- Every `rotator/*.js` is pure-ESM and importable in isolation (unit tests import modules directly; no import-time side effects).
- CLI commands never reach into the proxy process — they operate on on-disk state + `launchctl kickstart`. The proxy picks up registry/config changes via `pool.js`'s 1s cache on the next request.
- The patcher never mutates `rotator/` source files — it only copies. After `install.sh` a `git diff` on the repo shows no changes to `rotator/`.
- `detector.js` and `classify.js` are pure functions — I/O-free, unit-testable, revisable if heuristics need tuning.

---

## Data flow

### (a) Install, one-time

```
./install.sh [--enable-multi-account]
  ├─ patch-gateway-plist.mjs                              (unchanged)
  ├─ existing proxy patches: idle-timer, extract-content  (unchanged)
  ├─ NEW: scripts/patch-proxy-rotator.mjs <proxy-root>
  │    ├─ assert prior sentinels present
  │    ├─ copy rotator/*.js → <proxy>/dist/rotator/
  │    └─ inject @openclaw-bridge:rotator v1 into routes.js + manager.js
  ├─ link cli/openclaw-bridge into $(npm prefix -g)/bin
  ├─ scaffold ~/.openclaw/bridge/accounts.json from template (mode:"single", accounts:[])
  └─ if --enable-multi-account: print risk notice, require "I accept the risk" phrase
                                (records intent only; does NOT flip mode)
```

Files mutated at install: `~/.openclaw/bridge/accounts.json` (if absent). **No proxy hot-path behavior change.**

### (b) Per-request, single mode (default)

```
POST /v1/chat/completions → routes.handleChatCompletions
  → rotator.prepare(body)
      ├─ loadRegistry() hits 1s cache
      ├─ registry.mode !== "multi" → return {env:{}, label:null, kind:"single"}
  → new ClaudeSubprocess(); subprocess.envOverrides = {}
  → manager.spawn("claude", args, { env: { ...process.env, ...{} } })   # identical to today
  → on close: rotator.complete(ctx, ...) → ctx.label===null → early return, no-op
```

Default-path cost: one cached `fs.readFileSync` + two early-return calls. Stderr is still accumulated into a 4KB ring buffer on `manager.stderrTail`, but nothing consumes it in single mode.

**Smoke-test assertion (non-negotiable):** single-mode round-trip writes zero bytes to `state.json` and `rotator.log`.

### (c) Per-request, multi mode — main request

```
rotator.prepare(body)
  ├─ loadRegistry() → mode:"multi"
  ├─ loadState()
  ├─ check state.poolQuietUntil and CIRCUIT_TRIPPED
  │    ├─ circuit tripped → return {env:{}, noHealthy:"circuit_tripped"}
  │    └─ poolQuietUntil > now → return {env:{}, noHealthy:"pool_quiet", quietUntil}
  ├─ classify.classifyRequest(body, cfg) → "main"    # body.model NOT in heartbeatModels
  ├─ policy.pickMain(registry, state)
  │    ├─ healthy = accounts where cooling_until <= now AND configDir exists
  │    ├─ if state.lastMainLabel is healthy AND inflight==0 → reuse (sticky)
  │    └─ else: pick healthy with lowest inflight, tiebreak LRU lastPickedAt
  ├─ if no healthy → return {env:{}, noHealthy:"all_cooling"}
  ├─ state.lastMainLabel = picked.label
  ├─ markChecked(state, label)                 # inflight++, lastCheckedAt=now
  ├─ saveState(state)                          # tmp+rename
  ├─ logger.log({event:"picked", label, kind:"main", model})
  └─ return {env: {CLAUDE_CONFIG_DIR: picked.configDir}, label, kind:"main", config}

routes.js:
  if (noHealthy) → 429 response (pool_quiet | circuit_tripped | all_cooling)
  else → manager spawns with merged env → claude CLI uses picked account's OAuth

on close:
rotator.complete(ctx, {exitCode, stderrTail})
  ├─ outcome = detector.classifyOutcome(exitCode, stderrTail)
  ├─ markReleased(state, label, outcome, cfg.cooldowns)   # see cooldown model below
  ├─ push to state.recentOutcomes (ring buffer, cap 20)
  ├─ check pool-quiet & auth-cascade triggers
  ├─ saveState(state)
  └─ logger.log({event:"completed", label, outcome, exitCode})
```

### (d) Per-request, multi mode — heartbeat

Identical to (c) except:
- `classifyRequest` returns `"heartbeat"` (body.model in `heartbeatModels`, default `["claude-haiku-4"]`).
- `pickHeartbeat` does **uniform random over healthy** — ignores stickiness.
- `state.lastMainLabel` is NOT updated (heartbeats don't anchor the sticky pointer).

### (e) Cooldown model — three layers

**Layer 1: Per-account exponential on repeated `rate_limit`**

Each account carries `rateLimitStreak` in `state.json`. On `rate_limit`:
- `cooldown = 60s × 2^(streak-1)`, capped at `3600s`
- Streak increments
- Streak resets to 0 after any `ok` on that account, OR after 30min of inactivity
- `usage_limit` stays at `18000s` (matches actual 5h refill window; no exponentiation — the real cap is the limit)
- `auth` stays at `-1` (wait cannot heal a revoked grant)
- `other` stays at `30s`

**Layer 2: Pool-wide quiet period on correlated failures**

Sliding window via `state.recentOutcomes` (ring, cap 20). Triggers:
- ≥2 **distinct accounts** → `rate_limit` within 120s ⇒ `poolQuietUntil = now + 300s`
- ≥2 **distinct accounts** → `usage_limit` within 600s ⇒ `poolQuietUntil = now + 3600s` (strong correlation signal)
- Re-trigger within 30min ⇒ next duration is 2× the last, cap 3600s

During pool quiet, `prepare()` returns `{env:{}, noHealthy:"pool_quiet"}`. Proxy short-circuits with HTTP 429. OpenClaw's configured cross-provider fallback (`google/gemini-2.5-pro` etc.) handles the request. No account touched during the quiet window.

**Layer 3: Auth-cascade circuit breaker**

If **≥2 accounts hit `auth` in any 24h window**: set `state.circuitTrippedAt = now`, stop rotating immediately. All subsequent `prepare()` returns `{noHealthy:"circuit_tripped"}` → 429. Circuit-tripped state is determined by `state.circuitTrippedAt !== null` — single source of truth, no redundant file sentinels.

**Layer 3 is the ban-cascade brake and cannot be disabled.** Auto-clear behavior (below) IS configurable.

### (f) Auto-clear via in-proxy scheduled probe

When the circuit trips:

```
T        — state.circuitTrippedAt = T
           state.nextProbeAt       = T + 1h        (never auto-clear in first hour)
           state.probeAttempts     = 0
T+1h     — probe fires:
           probe = for each auth-cooled account:
             CLAUDE_CONFIG_DIR=<dir> claude -p "pong" --output-format json --max-turns 1
             → classifyOutcome(exitCode, stderrTail)
           if ALL return "ok":
             → clear state.circuitTrippedAt = null and state.nextProbeAt = null,
               emit circuit_auto_cleared log event
           else:
             → state.nextProbeAt = now + 24h, state.probeAttempts++
T+25h    — probe #2, same logic
...
T+7d     — probe #7. If still failing:
             → loud escalation log event
             → circuit stays tripped
             → stop auto-probing (operator must run `circuit clear` or `circuit probe`)
```

**Scheduler: in-proxy `setTimeout`, persisted via `state.nextProbeAt`.** On proxy cold start, read `state.nextProbeAt`; if `now < nextProbeAt`, arm `setTimeout` for the delta; if `now >= nextProbeAt`, run probe immediately. No new launchd unit. Restart-safe because the "truth" is the on-disk `nextProbeAt`, not in-memory state.

**Opt-out** via `rotator.config.json.autoClearCircuit = false`: on trip, set `nextProbeAt = null` and never auto-probe. Default is `true`.

**New CLI: `openclaw-bridge circuit {status|probe|clear}`**
- `status` — tripped since / next probe / probe attempts
- `probe` — run probe now (skips the T+1h floor; still respects probe history counter). **Manual `probe` always runs regardless of `autoClearCircuit` setting** — that config only governs the automatic timer, not operator-initiated probes.
- `clear [--skip-probe]` — manual clear with risk prompt; `--skip-probe` forces clear without testing

**Audit-trail log events** (written to `rotator.log`):

```jsonl
{"event":"circuit_tripped","auth_cooled":["work","research"],"trippedAt":"..."}
{"event":"circuit_probe_scheduled","nextProbeAt":"...","probeAttempts":0}
{"event":"circuit_probe_ran","attempt":1,"results":{"work":"ok","research":"auth"}}
{"event":"circuit_probe_failed","attempt":1,"stillFailing":["research"]}
{"event":"circuit_auto_cleared","attempt":2,"clearedAt":"..."}
{"event":"circuit_probe_exhausted","attempts":7,"escalated":true}
```

### (g) Operator flows

- `accounts add <label>` — risk prompt → `mkdir -p ~/.openclaw/bridge/accounts/<label>/config` (0700) → `exec env CLAUDE_CONFIG_DIR=… claude login` → append to `accounts.json`. Idempotent on re-run (dir pre-exists ⇒ re-login).
- `accounts list` — table of label / configDir / inflight / cooling_until / rateLimitStreak / counters.
- `accounts rm <label> [--purge]` — unregister; `--purge` additionally deletes the configDir.
- `accounts test <label>` — sends a minimal `claude -p "pong"` via that account's configDir, classifies outcome. On `ok`, clears that account's `cooling_until`. On `auth`, sets `cooling_until = -1` (matches trip behavior).
- `mode <single|multi>` — risk prompt (`I accept the risk` required for multi) → rewrite `accounts.json.mode` atomically.
- `status` — mode + accounts + pool quiet state + circuit state + last 10 log entries.
- `tail` — `tail -f ~/.openclaw/logs/rotator.log`, pretty-printed.
- `reload` — `launchctl kickstart -k gui/<uid>/ai.claude-max-api-proxy`.
- `rotate-now` — clears `lastMainLabel` so next main request re-picks without sticky bias.

---

## Error handling & failure modes

**Prime directive:** the rotator NEVER breaks the request path. Any throw from rotator code is caught in `routes.js`, logged, and execution proceeds as single-mode (empty env merge). This is the last line of backward-compat defense.

| Failure | Detection | Handling |
|---|---|---|
| `accounts.json` missing or malformed | JSON parse error in `loadRegistry` | Treat as `mode:"single"`, log once, return `{env:{}}`. Never throw. |
| `state.json` missing or malformed | Same | Treat as empty state; first `saveState` repairs it. |
| Concurrent state writes | tmp+rename is atomic; readers don't block | Last-writer-wins. Counters may lag one write — decisions re-read before pick. Documented non-goal. |
| Picked account's `configDir` deleted | `loadRegistry` stats each dir; missing → excluded from healthy pool; flagged in `status` | Auto-quarantined (behaves like `auth` cooldown). No runtime failure. |
| `claude login` fails / user cancels | Non-zero exit from wrapped `claude login` | Dir may exist; `accounts.json` NOT updated until login succeeds. `accounts add <same-label>` re-run is idempotent. |
| Stderr regex matches rate-limit but `exitCode===0` | Detector logic | Exit code wins: outcome = `ok`. Prevents false-positive cooldowns from CLI warnings on successful turns. |
| Stderr empty + `exitCode !== 0` | Detector | Outcome = `other` (30s). Safe default; does not escalate streak. |
| `inflight` counter stuck (proxy crashed mid-request) | `lastCheckedAt > 5min` on pool evaluation | Decay stale inflight to 0. Self-healing. |
| Logger disk full / EIO | `log()` try/catches everything | Falls back to `console.error`; never throws into caller. |
| `rotator.config.json` malformed | JSON parse in `loadConfig` | Fall back to defaults; warn once to stderr. |
| Pool quiet period active | `prepare()` returns `{noHealthy:"pool_quiet"}` | Proxy → HTTP 429. OpenClaw cross-provider fallback takes over. |
| Circuit tripped | `state.circuitTrippedAt !== null` | Proxy → HTTP 429. Auto-probe (or manual `circuit clear`) eventually recovers. |
| Proxy restart mid-probe-interval | `state.nextProbeAt` persisted on disk | Cold start re-arms timer; probe runs at the right time regardless of restart. |
| Re-run of `install.sh` after `openclaw update` regenerates proxy `dist/` | Sentinels gone | `install.sh` reapplies all three patches; sentinel-guards make each idempotent. |
| Patcher finds unexpected `routes.js` / `manager.js` shape (upstream bump) | Anchor string not found | Patcher exits non-zero with "anchor changed — see patch script"; install fails loudly rather than silently half-applying. |
| Uninstall while proxy running | Existing `launchctl bootout` pattern | Rotator adds `--purge-accounts` flag to delete `~/.openclaw/bridge/accounts/` with confirmation. |
| Clock jumps backward | `cooling_until` uses `Date.now()` | Accounts may appear cooler than they should; bounded minor effect. Accepted. |

### Bounded-state guarantees

- `state.json.recentOutcomes`: ring buffer, max 20 entries.
- `state.json.accounts[label]`: O(n_accounts), constant-size per account.
- `rotator.log`: 10MB × 3 generations = 30MB hard cap.
- No unbounded collections.

### Explicit non-goals for error handling

- **Duplicate-account detection.** Surfaced in docs as a known limitation; `accounts test` exposes per-label drift an operator can watch.
- **Weighted scheduling.** Treat every healthy account as equal. Documented.
- **Rate-limit response body parsing.** Exit code + stderr tail only. `detector.js` is pure — easy to revise if Claude CLI emits structured rate-limit JSON later.

---

## Testing

Three layers. Each has a non-negotiable assertion.

### Unit tests (`node --test`, pure modules, no I/O — fast, CI-runnable)

| File | Critical assertions |
|---|---|
| `classify.test.js` | Each `heartbeatModels` entry → `"heartbeat"`; others → `"main"`; missing `.model` → `"main"` (conservative) |
| `detector.test.js` | `(0, any_stderr) → "ok"` (exit-code wins); `(1, rate-limit regex) → "rate_limit"`; `(1, usage-limit regex) → "usage_limit"`; `(1, auth regex) → "auth"`; `(1, empty) → "other"`; `(137, any) → "other"` |
| `policy.test.js` | Sticky reuse when last healthy + idle; rotates on inflight>0; filters `cooling_until > now`; tiebreak by LRU; heartbeat uniform over healthy (seeded RNG, chi-sq sanity) |
| `pool.test.js` | tmp+rename atomicity; 1s cache TTL; malformed JSON → default shape; missing file → default shape; counter lag bounded to one write |

### Behavioral tests (`node --test` with temp dirs + fixtures, exercising real `index.js`)

- **Single-mode round-trip writes zero bytes to `state.json` and `rotator.log`, emits one log entry with `kind:"single"`.** ← Backward-compat assertion. If it breaks, stop.
- Multi-mode happy path: healthy pool of 3, `prepare` returns expected `CLAUDE_CONFIG_DIR`, `complete(ctx, {exitCode:0})` records `outcome:"ok"`, inflight decrements.
- Rate-limit streak: three `rate_limit` within 10min → 60s/120s/240s; `ok` between resets streak.
- Pool quiet activation: 2 accounts hit `rate_limit` within 120s → `poolQuietUntil = now+300s`; during that window `prepare` returns `{noHealthy:"pool_quiet"}`.
- Pool quiet on usage_limit: 2 accounts hit `usage_limit` within 600s → `poolQuietUntil = now+3600s`.
- Pool quiet re-trigger within 30min: duration doubles, cap 3600s.
- Auth-cascade circuit: 2 `auth` in 24h → `CIRCUIT_TRIPPED` written, `nextProbeAt = now+1h`, `prepare` returns `{noHealthy:"circuit_tripped"}`.
- Circuit auto-probe (simulated time): probe `ok` for all cooled → circuit clears, sentinel removed. Probe failing → re-arm for T+24h. 7 failing probes → escalation log, stays tripped, no further auto-probes.
- Inflight self-heal: stale inflight (`lastCheckedAt > 5min`) decays to 0 on next pick evaluation.

### Shell smoke — `test/rotator.smoke.sh` against a CI-style fixture proxy tree

- Fresh install: the rotator sentinel is present at every expected injection site (1× in `routes.js`, 2× in `manager.js` — env merge + stderr tail); the prior `extractContent` (in `openai-to-cli.js`) and `idleTimeout` (in `manager.js`) sentinels still present; `rotator/*.js` staged under `<proxy>/dist/rotator/`; `accounts.json` scaffolded as `{mode:"single", accounts:[]}`; `openclaw-bridge` resolves on PATH.
- Idempotent re-install: re-run `install.sh`, then diff the patched files against a snapshot taken after the first install — must be byte-identical (no nesting / duplication).
- **Single-mode no-op** (extends existing `test/smoke.sh` assertion): `rotator.prepare({model:"claude-sonnet-4"})` → `{env:{}, label:null}`.
- Multi-mode flip: pipe `I accept the risk` into `openclaw-bridge mode multi`, register a fixture account with fake `configDir`, `prepare` returns `{CLAUDE_CONFIG_DIR:<fake>}`.
- Patcher guardrails: `patch-proxy-rotator.mjs --dry-run` against a fixture with the anchor removed → non-zero exit + "anchor changed" message. Fresh fixture → exit 0 with "WOULD patch" report.

### `verify.sh` additions (real-machine post-install sanity)

- All three patches applied: `extractContent` sentinel in `openai-to-cli.js`; `idleTimeout` sentinel in `manager.js`; `rotator` sentinel at every expected injection site (1× `routes.js`, 2× `manager.js`).
- `rotator/` populated under `<proxy>/dist/rotator/`.
- `accounts.json` parses.
- `openclaw-bridge status` exits 0.
- If `accounts.json.mode === "multi"`: ≥1 account registered, all `configDir`s exist and are 0700.

### Out of scope for v1.1.0

- Real E2E against actual Claude Max OAuth — requires real accounts, risky, not CI-safe.
- Load/concurrency fuzzing — bounded state + atomic writes + documented counter-lag tolerance make this unnecessary.
- Chaos testing of launchd restart mid-request — covered by inflight self-heal unit test.

---

## Risk acknowledgement (unchanged in spirit from rotator branch)

This feature materially raises the ToS-violation profile of the bridge:
- Anthropic may treat multi-account rotation as abuse of the Services — higher than single-account automation.
- Detection can trigger **simultaneous termination of every account in the pool**, not just one.
- Correlates multiple accounts via a single machine fingerprint.

The risk gates (install flag + `I accept the risk` phrase at mode flip and first `accounts add`) are user-protective friction and legal-insurance — they are NOT cosmetic.

---

## Open items (to be resolved in the plan phase, not here)

- Exact anchor strings for `routes.js` and `manager.js` need to be re-derived from current `main` (post-idle-timer shape). The rotator-branch anchors don't match.
- Exact regex set for `detector.js` — the branch had some, but Claude CLI stderr shapes may have drifted since. Plan phase should diff CLI output against known failure modes on the live machine.
