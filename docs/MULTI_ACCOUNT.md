# Multi-account rotator

> **This feature is higher-risk than single-account use.** Rotating traffic
> across multiple Claude Max accounts — especially to avoid rate/usage limits
> — is more likely to be treated by Anthropic as abuse of the Services than
> single-account automation. Detection may result in the **simultaneous
> termination of every account you rotate through**, not just one. Use
> at your own risk.
>
> Siehe auch den „Haftungsausschluss" in der README (EN + DE).

## Why this exists

Single-account OpenClaw users with heavy workloads run into two frictions:

1. **Usage caps.** Claude Max enforces a rolling 5-hour usage window. A long
   agent run can exhaust that budget and stall every subsequent call for the
   rest of the window.
2. **Rate limits.** Running multiple agents in parallel can trigger per-minute
   throttling on a single account, even when the 5-hour budget is nowhere
   near exhausted.

And a third, softer concern:

3. **Heartbeat patterning.** OpenClaw fires a heartbeat on a regular cadence
   against the configured provider. A single account sending the same
   heartbeat every N minutes, forever, is the most fingerprintable traffic
   pattern a client can produce.

The multi-account rotator addresses all three by pooling several Claude Max
accounts and picking one per request, with distinct strategies for "real"
requests vs. heartbeats.

## How it works

- The bridge proxy already spawns the `claude` CLI for every incoming
  request. The rotator hooks that spawn to set the `CLAUDE_CONFIG_DIR`
  environment variable, which reroutes the CLI's entire credential store
  (Keychain lookup + file fallback) to an isolated directory.
- Each registered account gets its own config dir populated once via
  `CLAUDE_CONFIG_DIR=<dir> claude login`. No manual token extraction, no
  plaintext bearer files — OAuth refresh works transparently per account.
- **Main requests** (anything whose `model` is *not* on the heartbeat list)
  use a **sticky-unless-concurrent** strategy: reuse the last-picked account
  if it's idle, spread to a different healthy one otherwise. This avoids
  cold-cache / prompt-reuse penalties while preventing two parallel runs
  from colliding on the same rate limiter.
- **Heartbeats** (requests whose `model` matches `heartbeatModels`, default
  `["claude-haiku-4"]`) use **uniform random** selection across the healthy
  pool. This cloaks the systematic cadence across many accounts.
- When the CLI exits, the rotator classifies the outcome from exit code +
  stderr tail (`ok` | `rate_limit` | `usage_limit` | `auth` | `other`) and
  places the account on a cooldown if appropriate:

  | Outcome       | Default cooldown       |
  |---------------|------------------------|
  | `rate_limit`  | 60 seconds             |
  | `usage_limit` | 5 hours (18000 s)      |
  | `auth`        | infinite (manual clear)|
  | `other`       | 30 seconds             |
  | `ok`          | none                   |

## Setup

### 1. Install the bridge (any mode)

```
./install.sh
```

The installer always installs the rotator module + `openclaw-bridge` CLI,
even in single-account mode. Without any accounts registered, the rotator
is inert and the bridge behaves exactly as it did pre-rotator.

To add the up-front acknowledgement prompt during install:

```
./install.sh --enable-multi-account
```

This prints the risk notice and requires the exact phrase
`I accept the risk`. It does **not** flip the mode to `multi` — that's a
separate step after accounts are registered.

### 2. Register accounts

Add each Claude Max account you want in the pool:

```
openclaw-bridge accounts add account1
openclaw-bridge accounts add account2
openclaw-bridge accounts add account3
```

Each invocation:

1. Creates `~/.openclaw/bridge/accounts/<label>/config/` (0700).
2. Runs `CLAUDE_CONFIG_DIR=<dir> claude login` interactively — complete the
   browser OAuth flow for the account you want to assign to this label.
3. Registers the label + config dir in `accounts.json`.

Pick labels that help you remember which Anthropic account is which
(`work`, `personal`, `research`, etc.). Labels must match
`[a-z0-9][a-z0-9_-]{0,31}`.

Smoke-test each account:

```
openclaw-bridge accounts test account1
```

### 3. Flip mode to multi

```
openclaw-bridge mode set multi
```

This prints the risk confirmation and requires `I accept the risk` before
writing `mode: "multi"` to `accounts.json`. Rotation activates immediately
(within 1 second; the registry is cache-invalidated hourly-ish).

Reload the proxy if you want a hard trigger:

```
openclaw-bridge reload
```

### 4. Observe

```
openclaw-bridge status        # mode, accounts, health, last 10 decisions
openclaw-bridge accounts list # table of counters per account
openclaw-bridge tail          # live rotator.log tail, pretty-printed
```

## Operations

### Manually force a re-pick

```
openclaw-bridge rotate-now
```

Clears `lastMainLabel` so the next main request picks based on health +
in-flight + LRU rather than stickiness.

### An account got stuck in `auth` cooldown

Claude rotated or revoked the OAuth grant for that account. Re-login:

```
openclaw-bridge accounts rm <label> --purge
openclaw-bridge accounts add <label>
openclaw-bridge accounts test <label>
```

(`test` clears `cooling_until` on success.)

### Disable the rotator without uninstalling

```
openclaw-bridge mode set single
openclaw-bridge reload
```

The rotator code stays in place but runs the single-mode no-op path. No
perf or behavior change vs. a fresh single-mode install.

### Fully remove

```
./uninstall.sh                   # keeps ~/.openclaw/bridge/accounts/
./uninstall.sh --purge-accounts  # deletes credentials as well
```

## Configuration

Optional `~/.openclaw/bridge/rotator.config.json`:

```json
{
  "cooldowns": {
    "rate_limit": 60,
    "usage_limit": 18000,
    "auth": -1,
    "other": 30
  },
  "heartbeatModels": ["claude-haiku-4"],
  "configDirEnvVar": "CLAUDE_CONFIG_DIR"
}
```

- `cooldowns` — seconds; `-1` = infinite (manual clear required).
- `heartbeatModels` — request bodies whose `.model` matches are treated as
  heartbeats. Set to `[]` to route *everything* through the main strategy.
- `configDirEnvVar` — the env var whose value gets set to the picked
  account's config dir. Default `CLAUDE_CONFIG_DIR` matches current Claude
  CLI. Change only if Anthropic renames the knob.

## Known limitations

- **Duplicate-account detection.** The rotator can't tell if you accidentally
  logged two labels into the same Anthropic account — both would rotate
  against the same upstream. `openclaw-bridge accounts test` prints the
  assistant's model echo; use separate Anthropic accounts and watch per-label
  counters drift to spot duplicates.
- **OAuth refresh races.** Two concurrent spawns against the same account
  may each trigger a token refresh. The CLI's own file lock serializes
  this; worst case one spawn waits milliseconds. Not a correctness issue.
- **Approximate counters.** Under concurrency, `state.json` is written with
  tmp+rename atomicity but readers don't block writers, so counters may lag
  by one write. Decisions still re-read state before each pick.
- **Log growth.** `~/.openclaw/logs/rotator.log` rotates at 10 MB, 3
  generations. No time-based rotation.
- **No weighted scheduling.** Every healthy account is treated as equal.
  For 5–10 accounts this is enough; for much larger pools add your own
  weighting on top.

## Risk summary

Using this feature:

- Doubles-down on automation that Anthropic's ToS may not contemplate.
- Correlates multiple accounts via a single machine fingerprint.
- Can trigger ban cascades if any one of the rotated accounts is flagged.
- Requires separate Claude Max subscriptions — no sharing.

You are fully responsible for deciding whether this risk is acceptable
for your use. The maintainer provides this feature **AS IS** and
disclaims all warranties to the maximum extent permitted by law (see
the "Legal notice / Haftungsausschluss" section in README).
