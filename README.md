# openclaw-local-bridge

> Companion tool for the Medium walkthrough: **[Running OpenClaw on Local Claude Code: What €43 of Debugging Taught Me](https://medium.com/@ulmeanuadrian/1f64de4d6852)**

One-command setup for running your OpenClaw fleet fully against your local
authenticated Claude Code install, with proper systemd lifecycle and no
external OAuth dependencies.

> Run OpenClaw fully locally against your authenticated Claude Code install,
> with proper systemd lifecycle and zero external OAuth dependencies.

**What you get**

- Local-first routing: every OpenClaw agent talks to `http://localhost:3457/v1`, served by `claude-max-api-proxy` running under your own user.
- Stable systemd lifecycle: the proxy is a normal `systemctl --user` unit with restart policy, and OpenClaw's gateway picks up its runtime environment through a clean drop-in.
- Interactive-session-identical routing: both services share the same runtime environment the Claude Code CLI would have when launched from your terminal, under your active subscription.
- No third-party OAuth dependency: you already authenticated `claude` once in your terminal. The bridge reuses that session. Nothing else holds tokens.
- Idempotent and reversible: running `install.sh` twice changes nothing; `uninstall.sh` reverts the systemd bits and can restore your `openclaw.json` from the timestamped backup.

## Why

**Operational sovereignty.** Your agents run on your machine, against your
CLI, under your user session. No extra control plane, no extra token bucket,
no extra thing that can expire at 3am.

**Stable lifecycle.** Without this bridge, many OpenClaw setups shell out to
`claude` through ad-hoc child processes that inherit whatever environment
happened to be around. That is fragile: token refresh races, stale env vars,
and "it works when I run it by hand but the daemon can't find claude"
problems. With this bridge, the proxy runs as a first-class systemd user
unit, and the OpenClaw gateway inherits a single, declared environment
through a drop-in override.

**Local-first.** One HTTP hop, all on loopback. No external OAuth dance.
Your subscription, your CLI, your machine.

**Clean uninstall.** The drop-in is a separate file under
`openclaw-gateway.service.d/`, never a modified unit. Your upstream OpenClaw
unit file is untouched; removing the drop-in and reloading systemd reverts
the change completely.

## Requirements

- Linux with systemd (tested on Ubuntu 22.04+, Debian 12+)
- OpenClaw installed and running, with `~/.openclaw/openclaw.json` present
- Claude Code CLI installed and authenticated: `claude --version` works and `claude` can make calls from a normal terminal
- Node.js 18+ and npm (the proxy is a Node process; `npm root -g` must be writable without sudo, or your global prefix must already be user-owned such as `~/.npm-global`)
- An active Claude subscription (Pro or Max) on the authenticated CLI
- A systemd user session (`systemctl --user` works; run `loginctl enable-linger $USER` if you want services to survive logout)

## Install

Quick install (review the script first if you prefer):

```bash
curl -fsSL https://raw.githubusercontent.com/ulmeanuadrian/openclaw-local-bridge/main/install.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/ulmeanuadrian/openclaw-local-bridge.git
cd openclaw-local-bridge
bash install.sh
```

The installer refuses to run as root. Run it as your normal user; the systemd
user units will land in `~/.config/systemd/user/`.

## What it does

1. Verifies `claude`, `node`, `npm`, `systemctl --user`, and `~/.openclaw/openclaw.json` are all in place.
2. Installs `claude-max-api-proxy` from npm if it is not already present. This is a small Node HTTP server that exposes your local Claude Code CLI as an OpenAI-compatible endpoint on `http://localhost:3457/v1`.
3. Timestamps and backs up your `~/.openclaw/openclaw.json` to `~/.openclaw/openclaw.json.bak.YYYYMMDD-HHMMSS`.
4. Runs an idempotent JSON patcher over `openclaw.json`:
   - Ensures `models.providers.openai` points at `http://localhost:3457/v1` with the standard `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4` model definitions.
   - Sets `agents.defaults.model.primary` to `openai/claude-opus-4` and fallbacks to `openai/claude-sonnet-4` (only when not already a custom openai-prefixed value).
   - Sets friendly aliases (`Opus`, `Sonnet`) on the default model entries.
   - Deletes the legacy `agents.defaults.cliBackends` block if present.
5. Writes a systemd user unit for the proxy at `~/.config/systemd/user/claude-max-api-proxy.service` with a proper restart policy and the runtime environment the Claude Code CLI expects.
6. Writes a systemd drop-in at `~/.config/systemd/user/openclaw-gateway.service.d/99-local-bridge.conf` so the OpenClaw gateway inherits that same runtime environment. This does not touch the upstream unit file.
7. Runs `systemctl --user daemon-reload`, enables and starts `claude-max-api-proxy.service`, and restarts `openclaw-gateway.service` if it is installed.
8. Runs a full health check (`scripts/verify.sh`): the proxy service is active, port 3457 is listening, `/v1/models` answers with Claude model ids, the drop-in env var is visible in the gateway's runtime environment, and `openclaw.json` points at the bridge.

If anything fails along the way, the script stops, the backup is still in
place, and the troubleshooting doc explains how to recover.

## Uninstall

```bash
bash uninstall.sh
```

It stops and disables the proxy service, removes the unit file and the
drop-in, reloads systemd, restarts the OpenClaw gateway, and offers to
restore your `openclaw.json` from the most recent `.bak` file. The
`claude-max-api-proxy` npm package is left alone so you can keep using it
directly if you want.

More detail: [docs/UNINSTALL.md](docs/UNINSTALL.md)

## How it works

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the process tree, a
walkthrough of the three moving pieces (proxy, provider config, systemd
drop-in), and notes on why systemd environment propagation matters.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common failure
modes: proxy won't start, port 3457 already in use, OpenClaw still routing
to the old provider, permission errors, breakage after a Claude CLI upgrade,
and more.

## Important: half-life warning

This tool depends on the current behavior of the Claude Code CLI and the
`claude-max-api-proxy` package. Both can change in any release. Pin your
Claude CLI version (`claude --version`) and test after upgrades. If
something breaks after a CLI update, downgrade first, then file an issue.

This is a community tool. It is not endorsed by Anthropic or OpenClaw.

## License

MIT. Copyright (c) 2026 Adrian Ulmeanu. See [LICENSE](LICENSE).
