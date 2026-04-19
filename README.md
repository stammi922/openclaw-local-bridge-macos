# openclaw-local-bridge-macos

Route every [OpenClaw](https://openclaw.ai) agent through your authenticated
[Claude Code](https://claude.com/claude-code) CLI on macOS — so the agents
ride your Claude Max subscription instead of paying per-token API costs.

This is the macOS / launchd port of
[`ulmeanuadrian/openclaw-local-bridge`](https://github.com/ulmeanuadrian/openclaw-local-bridge)
(which targets Linux + systemd). It bundles
[`claude-max-api-proxy`](https://github.com/atalovesyou/claude-max-api-proxy)
under `vendor/` so install works without touching the npm registry.

---

## What this does

When you run `./install.sh`:

1. **Copies** the bundled `claude-max-api-proxy` to `~/.openclaw/bridge/` and
   runs it on `localhost:<port>` (default `3456`) under launchd, with
   `KeepAlive` so it restarts on crash and survives reboots.
2. **Patches `~/.openclaw/openclaw.json`** to add an `openai` provider
   pointing at the proxy. Your existing config (auth profiles, channels,
   skills, gateway settings, other providers — everything) is preserved.
3. **Patches the proxy adapter** to handle OpenClaw 4.15+'s array-typed
   message content (without this, system prompts arrive as the literal string
   `"[object Object]"` and break tool calls).
4. **Adds `CLAUDE_CODE_ENTRYPOINT=cli`** to your existing
   `ai.openclaw.gateway.plist` so the gateway tells Claude Code it's running
   from the CLI rather than the IDE.
5. **Optionally** (asks first) adds `"permissions": {"allow": ["Bash(*)", "mcp__*"]}`
   to `~/.claude/settings.json` so OpenClaw agents can run tools through
   Claude Code without being prompted for each call. **You can decline.**

The result: `openclaw agent 'do a thing' --agent claude-code` round-trips
through your Max subscription, with full Claude Sonnet / Opus / Haiku model
access automatically resolved to the latest published versions.

---

## Requirements

- macOS 12 (Monterey) or newer
- Node.js ≥ 20 (npm ≥ 9 recommended)
- `openclaw` ≥ `2026.4.15` — older versions silently mishandle array content
- `claude` CLI ≥ 2.0, authenticated via `claude login` and on an active
  Claude Max subscription

The installer checks all of these and bails with a clear error message if
something is wrong. No silent half-installs.

---

## Install

### Recommended — clone, read, then run

```bash
git clone https://github.com/stammi922/openclaw-local-bridge-macos
cd openclaw-local-bridge-macos
less install.sh   # please actually read it before running
./install.sh
```

### Convenience one-liner (pinned to a release tag)

The bundled proxy can't be piped over a single HTTP request, so the one-liner
is a thin bootstrap that shallow-clones the tagged release and runs
`install.sh` from the clone:

```bash
curl -fsSL https://raw.githubusercontent.com/stammi922/openclaw-local-bridge-macos/v1.0.0/install.sh | bash
```

(The script auto-detects when it's being executed via `curl | bash` and
clones itself to a temp dir before doing anything destructive.)

---

## Flags

```
--port N                       Override the default port (3456)
--dry-run                      Print what would happen, write nothing
--non-interactive              No prompts; safe defaults
--with-claude-permissions      Add Bash(*) + mcp__* allows non-interactively
--no-claude-permissions        Skip the permissions step entirely
--skip-verify                  Don't run verify.sh after installing
--force                        Continue past soft warnings
--uninstall                    Delegate to ./uninstall.sh
--help                         Show this help
```

---

## Verify

```bash
./verify.sh           # quick health checks
./verify.sh --smoke   # also fires a real round-trip through Claude Code
```

Prints a pass/fail table; exit code = number of failures.

---

## Uninstall

```bash
./uninstall.sh
```

Stops and removes the launchd service for the proxy, deletes
`~/.openclaw/bridge/`, and (interactively) restores `openclaw.json`, the
gateway plist, and `~/.claude/settings.json` from the most recent timestamped
backup under `~/.openclaw/bridge-backups/`. Backups themselves are preserved.

---

## How it works (one paragraph)

`claude-max-api-proxy` is a small Express server that exposes an
OpenAI-compatible `/v1/chat/completions` endpoint and forwards each request
to your local `claude` CLI in `--print` mode. OpenClaw is configured with an
`openai`-shaped provider whose `baseUrl` points at the proxy. When OpenClaw
runs an agent turn, it talks OpenAI; the proxy translates and shells out to
Claude Code; Claude Code answers using your Max subscription; the response
flows back. Everything runs on `localhost`. No tokens leave your machine.

---

## Troubleshooting

**`EACCES` during install** — npm is trying to write to a global directory
you don't own. Switch to a Node manager (nvm/fnm/volta) or `brew install
node@22` to put npm under your user. Don't `sudo` this installer.

**Port already in use** — pass `--port 3457` (or any free port).

**No gateway plist found** — the installer warns and skips that step.
Happens if you run OpenClaw via `openclaw gateway` in a terminal rather than
as a launchd service. Install OpenClaw's launchd service first if you want
the env var injected automatically.

**Corporate proxy / custom CA** — set `NODE_EXTRA_CA_CERTS` in your shell
before installing; the installer reads it and includes it in the launchd
plist's environment.

**`openclaw config validate` fails after install** — restore the most recent
backup from `~/.openclaw/bridge-backups/` and file an issue. The patcher
runs validate before declaring success, so this should be rare.

---

## Vendored dependency

`vendor/claude-max-api-proxy/` is a verbatim, pinned snapshot of the upstream
npm package, with its production `node_modules/` pre-installed. See
[`VENDOR.md`](./VENDOR.md) for the refresh process. Refreshing requires only
`npm pack` and a smoke test — no upstream coordination.

---

## Credit

- **Linux/systemd original:** [ulmeanuadrian/openclaw-local-bridge](https://github.com/ulmeanuadrian/openclaw-local-bridge)
  — © 2026 Adrian Ulmeanu, MIT.
- **Vendored proxy:** [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
  — © Atal Ashutosh, MIT.

This repo is a clean macOS rewrite. See [`NOTICE`](./NOTICE) for full
attribution.

## License

MIT. See [`LICENSE`](./LICENSE).
