# `rotator/` — multi-account selector

Pure-ESM Node module embedded into the installed `claude-max-api-proxy` tree
(`~/.openclaw/bridge/claude-max-api-proxy/dist/rotator/`) by
`scripts/patch-proxy-rotator.mjs`.

## Files

| File           | Role                                                         |
|----------------|--------------------------------------------------------------|
| `index.js`     | Public API: `prepare(body)`, `complete(ctx, result)`, `snapshot()`, `refresh()` |
| `pool.js`      | `accounts.json` + `state.json` I/O, atomic via tmp+rename    |
| `policy.js`    | `pickMain` (sticky-unless-concurrent), `pickHeartbeat` (uniform random) |
| `detector.js`  | Map exit code + stderr tail → `ok`/`rate_limit`/`usage_limit`/`auth`/`other` |
| `classify.js`  | Incoming request → `heartbeat` or `main` (model-match)       |
| `logger.js`    | JSONL log with 10 MB rotation, 3 generations                 |

## Call flow

```
routes.js (patched)
  └─ const ctx = await rotator.prepare(req.body)     // picks account, returns env
     ClaudeSubprocess(..., { env: ctx.env })         // spawn with CLAUDE_CONFIG_DIR
        └─ on exit:
           await rotator.complete(ctx, { exitCode, stderrTail })
```

## Single-mode

When `accounts.json.mode !== "multi"`, `prepare` returns `{ env: {} }` and
`complete` is a no-op (early return on missing label). The hot path does one
`fs.readFileSync` of the registry (cached 1 s) per request and nothing else.

## Env-var knobs (for tests)

- `OPENCLAW_BRIDGE_ACCOUNTS_DIR` — override `~/.openclaw/bridge/accounts`
- `OPENCLAW_BRIDGE_ROTATOR_CONFIG` — override `~/.openclaw/bridge/rotator.config.json`
- `OPENCLAW_BRIDGE_ROTATOR_LOG` — override rotator log path

## Safety

- State writes use tmp+rename atomicity.
- Logger never throws back into the request path.
- `auth` outcome marks the account cooling until `9999-12-31` (i.e., until
  `openclaw-bridge accounts test <label>` clears it manually).
- All rotation decisions get a single JSONL line in `~/.openclaw/logs/rotator.log`.
