# How it works

`openclaw-local-bridge` stitches together three pieces that were all already
on your machine and gives them a clean lifecycle.

## The three pieces

**1. `claude-max-api-proxy`** is a small Node HTTP server that listens on
`http://localhost:3457` and speaks the OpenAI-compatible Chat Completions
protocol. When a request arrives, it translates it into a call into the
local Claude Code CLI and returns the response back in OpenAI format. It
runs entirely on loopback as a normal user process.

**2. The OpenClaw provider entry.** In `~/.openclaw/openclaw.json`, under
`models.providers.openai`, we point `baseUrl` at
`http://localhost:3457/v1` and declare `claude-opus-4`, `claude-sonnet-4`,
and `claude-haiku-4` as available models. OpenClaw already knows how to
talk to OpenAI-compatible providers, so no code change is needed on the
OpenClaw side, only configuration.

**3. The systemd environment.** The proxy runs as a `systemctl --user`
service (`claude-max-api-proxy.service`), and the OpenClaw gateway
(`openclaw-gateway.service`) gets a drop-in override file at
`~/.config/systemd/user/openclaw-gateway.service.d/99-local-bridge.conf`
that declares one environment variable:

```
Environment=CLAUDE_CODE_ENTRYPOINT=cli
```

This variable is read by the Claude Code CLI to decide how to identify and
route requests. Setting it in the systemd environment ensures requests are
routed and identified identically to an interactive Claude Code session per
the user's active subscription. Because the gateway runs as a systemd
service, any child process the gateway spawns inherits this environment
cleanly and deterministically, with no shell-init quirks or race
conditions.

## Process tree

```
systemd --user  (your login session)
|
+-- claude-max-api-proxy.service
|   +-- node .../claude-max-api-proxy/dist/server/standalone.js 3457
|       (listens on 127.0.0.1:3457)
|
+-- openclaw-gateway.service
    |   (Environment=CLAUDE_CODE_ENTRYPOINT=cli  via 99-local-bridge.conf)
    +-- node .../openclaw/dist/index.js gateway --port 18789
        |
        +-- OpenClaw agent workers / tool runs
            |  HTTP
            v
        http://localhost:3457/v1/chat/completions
            |  (handled by the proxy, which invokes)
            v
        claude  (your authenticated CLI)
```

## Request flow

1. An OpenClaw agent decides it needs to call its primary model,
   `openai/claude-opus-4`.
2. OpenClaw looks up the provider config for `openai` and sees
   `baseUrl=http://localhost:3457/v1`.
3. OpenClaw sends a standard OpenAI-style `POST /v1/chat/completions` to
   the proxy on loopback.
4. The proxy translates the request into a local Claude Code CLI invocation.
   Because `CLAUDE_CODE_ENTRYPOINT=cli` is already set in the service
   environment inherited by all children, the CLI identifies the call
   identically to an interactive Claude Code session.
5. The CLI returns its response; the proxy converts it back into the
   OpenAI-compatible shape; OpenClaw receives it and moves on.

Everything stays on `127.0.0.1`. There is no extra token refresh, no extra
OAuth round-trip, no external control plane involved in the hot path.

## Why systemd environment propagation matters

Linux processes inherit their environment from their parent. When a service
is managed by systemd, the `Environment=` directives in the unit (and in
any drop-in override files) define that starting environment. Every child
process the service spawns, including any subshells or child Node processes,
inherits it automatically.

If you set an env var interactively with `export CLAUDE_CODE_ENTRYPOINT=cli`
in your shell, it only applies to that shell and its children. A daemon
that was started earlier by systemd will not see it. That is why we declare
the variable at the systemd layer: the gateway and everything it launches
pick it up deterministically, whether the machine has just booted, whether
you have ever opened a shell this session, or whether the variable is in
your `.bashrc`.

## Why a drop-in instead of editing the unit

We never touch the upstream `openclaw-gateway.service` file. Instead we
write a separate drop-in under `openclaw-gateway.service.d/`, which systemd
merges into the effective unit at load time. Three good things follow:

- OpenClaw upgrades that replace the upstream unit file do not wipe our change.
- `systemctl --user cat openclaw-gateway.service` shows both the base unit
  and the drop-in, so it is obvious where the extra env var came from.
- Uninstalling is just deleting the drop-in file and reloading systemd.

## Files touched on your machine

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.config/systemd/user/claude-max-api-proxy.service` | installer | proxy unit |
| `~/.config/systemd/user/openclaw-gateway.service.d/99-local-bridge.conf` | installer | env drop-in for gateway |
| `~/.openclaw/openclaw.json` | installer (patched) | provider + defaults |
| `~/.openclaw/openclaw.json.bak.<timestamp>` | installer (created) | backup of the previous config |

That is all. No dotfile edits, no shell-init changes, no system-wide
services, no sudo.
