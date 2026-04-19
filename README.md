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

> ### ⚠️ Use at your own risk
>
> This project is an **unofficial, user-community integration**. It is not
> affiliated with, endorsed by, or sponsored by Anthropic, OpenClaw, or any
> upstream project it depends on.
>
> Automating prompts into your `claude` CLI / Claude Max subscription **may
> conflict with Anthropic's Terms of Service or Usage Policies** depending
> on how you use it. Rate-limiting, account suspension, or permanent
> termination of your Anthropic (or any other) account is a real possible
> outcome. You alone are responsible for reviewing those terms before
> installing this bridge.
>
> The installer also offers to add broad Claude Code tool-execution
> permissions (`Bash(*)`, `mcp__*`) to `~/.claude/settings.json`. Accepting
> this grants any agent running through the bridge permission to execute
> arbitrary shell commands and MCP tool calls on your machine without
> further prompts. **Decline if you are not sure.**
>
> The author provides this software free of charge, with no warranty of
> any kind, and accepts no liability for account bans, lockouts, data loss,
> billing surprises, or any other consequence of running it. See
> [Legal notice / Haftungsausschluss](#legal-notice--haftungsausschluss)
> for the full terms.
>
> **By running `install.sh` you confirm that you have read and accepted
> these terms.**

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

---

## License

MIT. See [`LICENSE`](./LICENSE).

---

## Legal notice / Haftungsausschluss

### No affiliation, no endorsement

This project is an independent, user-community tool published free of charge
under the MIT license. It is **not** affiliated with, endorsed by, sponsored
by, or certified by:

- **Anthropic PBC** (maker of Claude and Claude Code)
- **OpenClaw** / **clawdbot**
- any upstream project listed in `NOTICE` or `vendor/`

"Claude", "Claude Code", "Claude Max", "Anthropic", "OpenClaw", and related
marks are the property of their respective owners. All references are
nominative (descriptive use only).

### Third-party Terms of Service are your responsibility

Your use of the `claude` CLI and your Claude Max subscription is governed
by **Anthropic's own agreements**, including but not limited to the
[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms),
the [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms),
the [Usage Policy](https://www.anthropic.com/legal/aup), and any
subscription-specific terms attached to Claude Max.

This bridge automates programmatic prompts into that CLI. Such usage **may
or may not be permitted** under your agreement with Anthropic, depending
on volume, automation, resale, fair-use assessment, and future policy
changes. **It is solely your responsibility** to review those terms and
confirm that your intended use complies — before installing, and on an
ongoing basis while you run this software. The same applies to OpenClaw's
and any other third party's terms.

### Possible consequences you accept by installing

Possible outcomes of running this software include, without limitation:

- rate-limiting, temporary suspension, or **permanent termination** of
  your Anthropic, OpenClaw, GitHub, or other third-party accounts
- loss of access to paid subscriptions you previously held, with or
  without refund
- unexpected API or subscription charges
- loss, corruption, or unintended disclosure of local data (especially if
  you accept the `Bash(*)` / `mcp__*` Claude Code permissions the
  installer offers — these grant blanket shell- and tool-execution rights
  to any agent running through the bridge)
- malfunction, downtime, or security issues inherited from upstream
  dependencies

By running `install.sh` you acknowledge and accept all such risks.

### No warranty

THE SOFTWARE IS PROVIDED **"AS IS"**, WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND
UNINTERRUPTED OR ERROR-FREE OPERATION. See [`LICENSE`](./LICENSE).

### Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE
AUTHOR OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER
LIABILITY — including, without limitation, suspension, termination,
rate-limiting, or ban of any Anthropic, OpenClaw, GitHub, or other
third-party account; loss of data; loss of productivity; financial loss
from usage overage or subscription changes; reputational harm; or any
direct, indirect, incidental, special, consequential, or exemplary
damages — whether arising in contract, tort (including negligence), or
otherwise, arising from, out of, or in connection with the software or
the use of or inability to use the software.

### Haftungsausschluss (Deutschland / EU)

Diese Software wird als kostenloses Open-Source-Projekt unter der
MIT-Lizenz **unentgeltlich** zur Verfügung gestellt. Es handelt sich um
ein privates Community-Projekt; es besteht keinerlei Geschäftsbeziehung
oder Vertragsverhältnis zwischen dem Autor und den Nutzern der Software.

Eine **Gewährleistung** wird — soweit gesetzlich zulässig — nicht
übernommen. Die Software wird „wie besehen" („as is") bereitgestellt.

Eine **Haftung** des Autors für Schäden, die durch die Nutzung oder die
Unmöglichkeit der Nutzung dieser Software entstehen — insbesondere für
Sperrungen, Kündigungen, Drosselungen oder sonstige Maßnahmen seitens
Anthropic, OpenClaw, GitHub oder anderer Drittanbieter, für entgangene
Nutzung bezahlter Abonnements, für unerwartete Nutzungs- oder
Abrechnungsfolgen, für Datenverlust, entgangenen Gewinn, mittelbare
Schäden oder Folgeschäden — ist **im gesetzlich zulässigen Umfang
ausgeschlossen**.

Dieser Haftungsausschluss **gilt nicht** für:

- Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit,
  die auf einer fahrlässigen Pflichtverletzung des Autors oder auf einer
  vorsätzlichen oder fahrlässigen Pflichtverletzung eines gesetzlichen
  Vertreters oder Erfüllungsgehilfen beruhen;
- sonstige Schäden, die auf **Vorsatz oder grober Fahrlässigkeit** des
  Autors oder eines gesetzlichen Vertreters oder Erfüllungsgehilfen
  beruhen;
- zwingende Haftungstatbestände nach dem Produkthaftungsgesetz.

Die Einhaltung der Nutzungsbedingungen der jeweiligen Drittanbieter,
insbesondere der Terms of Service und der Usage Policy von Anthropic,
obliegt **ausschließlich dem Nutzer**. Die Nutzung dieser Software
erfolgt auf **eigenes Risiko** und in eigener Verantwortung.

Mit der Ausführung von `install.sh` bestätigt der Nutzer, diese Hinweise
gelesen, verstanden und akzeptiert zu haben.
