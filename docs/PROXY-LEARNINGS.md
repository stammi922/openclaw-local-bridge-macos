# Proxy Learnings & Patch Ledger

A running trace of every modification this installer makes to the vendored
`claude-max-api-proxy` (`vendor/claude-max-api-proxy` → installed at
`~/.openclaw/bridge/claude-max-api-proxy`), **why** it exists, and **how it is
guarded**. Read this before adding a proxy patch so you don't duplicate an
existing one or re-investigate a problem that's already solved.

## Why the proxy is patched at all

The proxy is upstream MIT code (Atal Ashutosh) wrapping the `claude` CLI as an
OpenAI-compatible API. We do **not** fork it — we vendor a pristine copy and
reapply a small set of **idempotent, sentinel-guarded** patches on every
`install.sh` run. `openclaw update` never touches the proxy `dist/` (it's a
separate launchd service), so patches survive openclaw upgrades but are
**reapplied from scratch whenever the bridge `./install.sh` refreshes the
vendor copy** (install.sh step 4 does `rm -rf $PROXY_HOME && cp -a vendor/...`).

### The sentinel contract

Each patch:
1. Defines a unique sentinel comment `// @openclaw-bridge:<name> vN`.
2. Is idempotent — if the sentinel is already present it makes **no change**
   (re-runs are byte-identical; covered by a `.test.mjs`).
3. Matches an exact upstream **anchor**; if the anchor is gone (upstream
   refactor) it **dies loudly** rather than silently mispatching — so a future
   proxy version bump surfaces as a failed install, not a broken runtime.
4. Is checked by `verify.sh` so a missing sentinel is reported post-install.

## Patch ledger

| Step | Script | Target file(s) | Sentinel | Purpose |
|------|--------|----------------|----------|---------|
| 6 | `patch-adapter.mjs` | `dist/adapter/openai-to-cli.js` | `@openclaw-bridge:extractContent v1` | Adapter content extraction (CLI ⇄ OpenAI shape). |
| 7 | `patch-proxy-rotator.mjs` | `dist/server/routes.js`, `dist/subprocess/manager.js` | `@openclaw-bridge:rotator v1` | Multi-account rotator (v1.1.0). |
| 8 | `patch-proxy-timeout.mjs` | `dist/subprocess/manager.js` | `@openclaw-bridge:timeout v1` | Bump subprocess wall-clock cap `DEFAULT_TIMEOUT` 300000ms → 7200000ms (2h) so long Claude turns aren't SIGTERM'd. |
| 9 | `patch-manager-silent-debug.mjs` | `dist/subprocess/manager.js` | `@openclaw-bridge:silent-debug v1` | Silence per-chunk debug logging in the subprocess manager. |
| 10 | `patch-manager-strip-null-bytes.mjs` | `dist/subprocess/manager.js` | `@openclaw-bridge:strip-null-bytes v1` | Strip embedded NUL bytes from prompts before they reach the CLI. |
| 11 | `patch-proxy-system-prompt.mjs` | adapter + routes + manager | `@openclaw-bridge:systemPrompt v1` | System-prompt isolation. |
| 12 | `patch-routes-concurrency-cap.mjs` | `dist/server/routes.js` | `@openclaw-bridge:concurrency-cap v1` | Bound concurrent in-flight CLI subprocesses. |
| 13 | `patch-routes-session-serialize.mjs` | `dist/server/routes.js` | `@openclaw-bridge:session-serialize v1` | Serialize requests per `sessionId`; preserve 400 `invalid_messages` on malformed bodies. |
| 14 | `patch-routes-stream-safety.mjs` | `dist/server/routes.js` | `@openclaw-bridge:stream-safety v1` | Keep SSE streams alive + empty-result fallback. |
| 15 | `patch-proxy-eaddrinuse.mjs` | `dist/server/index.js` | `@openclaw-bridge:eaddrinuse-retry v1` | **(2026-05-31)** Retry the port bind with backoff instead of exiting on first `EADDRINUSE`. See incident below. |
| 16 | `patch-proxy-rate-resilience.mjs` | `dist/subprocess/manager.js`, `dist/server/routes.js`, copies `dist/rate-resilience/*` | `@openclaw-bridge:rate-resilience v1` | Detect CLI usage/burst rate limits → differentiated 429+Retry-After; rate-aware concurrency cap; restore subprocess event emitter (regressed by reinstall). |
| 17 | `patch-proxy-idle-timeout.mjs` | `dist/subprocess/manager.js` | `@openclaw-bridge:idle-timeout v1` | Idle timer resets on each stdout/stderr chunk (~40min default, env `OPENCLAW_BRIDGE_IDLE_TIMEOUT_MS`); absolute 2h wall cap remains non-resetting ceiling; both cleared in `clearTimeout()`; supersedes abandoned af1b6a6 (which patched an orphan path). |

(Step numbers track `install.sh`; adding a patch means inserting a step,
renumbering the rest, and bumping `TOTAL`.)

## Incident: EADDRINUSE restart-loop (2026-05-31)

**Symptom.** `claude-max-api-proxy.log` held ~6888 startup banners but only 146
`Server ready` lines; `claude-max-api-proxy.err.log` was a wall of
`Failed to start server: Error: Port 3460 is already in use` (stack →
`dist/server/index.js:76`).

**Root cause.** Upstream `startServer()` rejects immediately on `EADDRINUSE`;
`standalone.js` catches → `process.exit(1)`; launchd `KeepAlive` relaunches.
On a restart the *previous* proxy instance can still hold `:3460` for a beat
(slow listener release), so the new process loses the race, exits, and launchd
relaunches into the same race — a crash-loop until the port frees.

**Fix.** `patch-proxy-eaddrinuse.mjs` rewrites the bind in `startServer()` to
retry **10× with 1s backoff** before throwing (and only then throws, so launchd
restart remains the last-resort backstop). Also keeps a post-startup `error`
handler attached so later socket errors don't crash the process as an unhandled
event. Verified: clean single-banner start, `stderr` 0 bytes, `/v1/models` →
HTTP 200.

**Note.** This edits vendored `dist/` like the other sentinels. It is NOT
guarded against a bridge `./install.sh` reinstall in the sense of being
permanent in upstream — it's reapplied by the patcher each install. If upstream
ever moves the bind logic, the patcher's anchor check will fail the install
loudly (by design).

## Not a proxy patch: operator.read scope drift (2026-05-31)

Recorded here only so it isn't conflated with the proxy work. The repeating
`[ws] ✗ missing scope: operator.read` errors in the **gateway** log were a
device-auth issue, not a proxy issue: paired device `f3b9ed…` (in
`~/.openclaw/devices/paired.json`) had `operator.admin/approvals/pairing` but
neither `operator.read` nor `operator.write`. `method-scopes` treats `read` as
satisfied by `read` OR `write`, so that device was the only one that could emit
the error. Fix = add `operator.read` to its `scopes`+`approvedScopes` and reload
the gateway (see the SIGUSR1 gotcha below — use `launchctl kickstart -k`, not a
bare `kill -USR1`). This lives in host-local state, **not** in this installer,
so there's nothing to patch here — but a future installer could optionally
backfill `operator.read` onto any `role=operator` device missing both read and write.

## Gateway gotcha: `kill -USR1` defers the restart silently until idle

Also gateway-side, not a proxy concern — recorded here because it bit us while
reloading the proxy/gateway during this work, and the symptom ("the restart did
nothing") is easy to misdiagnose.

A bare external `kill -USR1 <gateway-pid>` is **accepted** (not ignored) when
`commands.restart=true` (the default; the SIGUSR1 policy is set at gateway
startup from `isRestartEnabled(config)`). But the handler routes an accepted
external signal into a **defer-until-idle** path: it waits until
`queueSize + pendingReplies + activeEmbeddedRuns + activeTasks == 0` before
actually restarting. In the bare-signal path that wait has **no timeout and logs
nothing per poll** — the gateway log shows only `signal SIGUSR1 received` and
then silence. So while any cron job or agent turn is in flight, the restart just
sits pending indefinitely and looks like a no-op.

Observed 2026-05-31: `SIGUSR1` sent while a cron session was assembling → no
restart; the process was killed ~85s later before the work drained.

The internal restart paths don't have this problem because they log and cap:
- **control-UI / gateway restart tool / `openclaw` restart** → drains with a
  logged `draining N active task(s)… timeout 300000ms` and a 5-min cap.
- **`install.sh` reload** → writes a restart-intent file; the handler's intent
  branch restarts immediately.

**Guidance:**
- Force an immediate restart: `launchctl kickstart -k gui/$UID/ai.openclaw.gateway`
  (hard launchd kill — bypasses the drain).
- Want graceful: use the gateway restart tool / control-UI / `openclaw` restart,
  **not** `kill -USR1`.
- Debugging a "silent" restart: the full structured gateway log (all levels) is
  at `/tmp/openclaw/openclaw-<date>.log`. `~/Library/Logs/openclaw/gateway.log`
  is stdout-only (info); stderr → `/dev/null` per the plist, so warns/errors can
  be missing there.

**Gateway `ExitTimeOut` (2026-05-31):** the gateway plist sets `ExitTimeOut=330`
(intent: let the 300s graceful drain finish before launchd SIGKILLs on a
launchd-initiated stop). **Caveat — macOS launchd clamps it:** with `ExitTimeOut`
=330 in the plist, `launchctl print … | grep 'exit timeout'` still reports
`exit timeout = 60`, i.e. launchd honors at most ~60s. So a launchd-initiated stop
(`bootout`/KeepAlive) still SIGKILLs at ~60s — better than the ~20s default and
enough for a typical fast drain, but NOT the full 300s. The only path that
guarantees a full drain remains the gateway's own restart (SIGUSR1/restart tool),
per the gotcha above. Also: `bootout` triggers the drain, so an immediately
following `bootstrap` can fail with `Bootstrap failed: 5: Input/output error`
while the old process is still tearing down — wait for the old pid to exit, then
bootstrap (or just use `launchctl kickstart -k`).

## How to add a new proxy patch

1. Copy `scripts/patch-proxy-timeout.mjs` (simplest template) or
   `patch-proxy-eaddrinuse.mjs` (multi-line anchor template).
2. Pick a fresh sentinel `@openclaw-bridge:<name> v1`. Bump `vN` only on a
   breaking change to the patch's own output.
3. Capture the **exact** upstream anchor (whitespace-exact, from a pristine
   `vendor/` copy) and a single `String.replace(ANCHOR, SENTINEL + REPLACEMENT)`.
4. Add a fixture under `test/fixtures/<name>/` + a `.test.mjs` asserting:
   fresh-patch, idempotent re-run (byte-identical), `--dry-run` no-op,
   already-patched dry-run, missing-anchor → non-zero exit, missing-root error.
   Include a `node --check` assertion on the patched output.
5. Wire into `install.sh` (new `step N`, renumber, bump `TOTAL`) and add a
   `check_sentinel` line to `verify.sh`.
6. Update the ledger table above.

## Quick verification

```sh
# all proxy sentinels present in the live install
./verify.sh                       # includes the sentinel block

# patcher tests
node --test scripts/patch-proxy-*.test.mjs

# live proxy health
launchctl print "gui/$UID/ai.claude-max-api-proxy" | grep -E 'pid =|last exit'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3460/v1/models   # 200
```

To reload the live proxy after editing `dist/`:
`launchctl kickstart -k "gui/$UID/ai.claude-max-api-proxy"`.
