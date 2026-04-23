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
