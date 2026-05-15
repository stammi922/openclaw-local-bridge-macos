# Troubleshooting

If `install.sh` or `scripts/verify.sh` reports failures, start here.

## 1. `install.sh` refuses to run: "do not run this installer as root"

Run it as your normal user, not via `sudo`. The systemd user units live
under `~/.config/systemd/user/`, which only your user's session can
activate. If you run the installer as root you end up with root-owned files
in the wrong place.

```bash
bash install.sh
```

## 2. "Claude CLI not found"

Install Claude Code first and make sure it works from your shell:

```bash
claude --version
```

If `claude` is installed but not in `PATH`, add the directory that contains
it to `PATH` in your shell rc file and open a new terminal before running
the installer again.

## 3. "systemd --user session is not active"

On some Linux setups `systemctl --user` only works inside a logged-in
graphical or SSH session with lingering disabled. Enable lingering so your
user's services can run without an open session:

```bash
loginctl enable-linger "$USER"
```

Log out and back in, then re-run the installer.

## 4. The proxy service won't start

Check the journal for the proxy:

```bash
journalctl --user -u claude-max-api-proxy.service -n 100 --no-pager
```

Common causes:

- `node` or the proxy entry point was at a different path when the unit was written. Re-run `bash install.sh` so the paths are re-detected.
- The Claude CLI cannot reach its configured session. Run `claude` once from a normal terminal to confirm it still works.
- Port 3457 was already in use. See section 5 below.

Manually restart:

```bash
systemctl --user restart claude-max-api-proxy.service
systemctl --user status claude-max-api-proxy.service --no-pager
```

## 5. Port 3457 already in use

Something else is bound to `127.0.0.1:3457`. Find it:

```bash
ss -tlnp 2>/dev/null | grep 3457
```

Either stop the other process, or change the port:

1. Edit `~/.config/systemd/user/claude-max-api-proxy.service` and change the `3457` argument at the end of `ExecStart=` and any `Environment=` lines that reference it.
2. Edit `~/.openclaw/openclaw.json` and change `models.providers.openai.baseUrl` to match.
3. Reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart claude-max-api-proxy.service
systemctl --user restart openclaw-gateway.service
bash scripts/verify.sh
```

## 6. `curl http://localhost:3457/v1/models` returns nothing or hangs

The service is probably not running. Check:

```bash
systemctl --user is-active claude-max-api-proxy.service
journalctl --user -u claude-max-api-proxy.service -n 50 --no-pager
```

If it says `activating (auto-restart)` it is crash-looping. Read the
journal output for the error.

## 7. OpenClaw is still routing to the old provider

Confirm the drop-in is actually being loaded by the gateway:

```bash
systemctl --user show openclaw-gateway.service -p Environment | tr ' ' '\n' | grep CLAUDE_CODE_ENTRYPOINT
```

You should see `CLAUDE_CODE_ENTRYPOINT=cli`. If you do not:

```bash
systemctl --user cat openclaw-gateway.service
```

Make sure `99-local-bridge.conf` is listed at the bottom. If it is not
there:

```bash
ls ~/.config/systemd/user/openclaw-gateway.service.d/
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

Also double-check `openclaw.json`:

```bash
grep baseUrl ~/.openclaw/openclaw.json
```

It should say `"baseUrl": "http://localhost:3457/v1"`.

## 8. Permission errors when writing the unit file

You ran the installer as root by mistake and now
`~/.config/systemd/user/` has root-owned files. Fix ownership:

```bash
sudo chown -R "$USER:$USER" ~/.config/systemd/user/
```

Then re-run `bash install.sh` as your normal user.

## 9. "npm install -g claude-max-api-proxy" fails with EACCES

Your npm global prefix is not user-writable. Either:

- Point npm at a user-writable prefix (recommended):

  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  # then add ~/.npm-global/bin to PATH in your shell rc
  ```

- Or, less cleanly, install with `sudo` once, then re-run the installer
  (as your normal user, not root).

## 10. Restoring `openclaw.json` from the backup

The installer writes a timestamped backup before touching anything:

```bash
ls ~/.openclaw/openclaw.json.bak.*
```

To restore the most recent one manually:

```bash
cp ~/.openclaw/openclaw.json.bak.<timestamp> ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway.service
```

`uninstall.sh` can do this for you interactively.

## 11. Things broke after a Claude CLI update

Claude Code CLI can change behavior between releases, and the
`claude-max-api-proxy` package may need to catch up. Two options:

- Downgrade the Claude CLI to the last version that worked. How you do
  this depends on how you installed Claude; consult the Claude Code docs.
- Pin `claude-max-api-proxy` to a specific version known to work with
  your Claude CLI:

  ```bash
  npm install -g claude-max-api-proxy@<version>
  systemctl --user restart claude-max-api-proxy.service
  ```

Then open an issue on this repo with your Claude CLI version and the
journal output, so others can find the fix.

## 12. `verify.sh` says everything is ok but my agents still fail

- Check the OpenClaw agent logs, not just the gateway journal.
- Make sure the agent you care about is actually using the provider
  `openai/claude-opus-4` (or whatever you configured) and not an older
  `anthropic/...` direct-API entry you left in place.
- If you override `model.primary` per-agent, those overrides are respected
  and not touched by the installer. Audit them with:

  ```bash
  grep -E '"model":|"primary":|"fallbacks":' ~/.openclaw/openclaw.json
  ```

## 13. Tuning concurrency

By default the proxy caps concurrent `claude` subprocesses at 4. Symptoms
that you may want a different cap:

- Bridge feels slow under burst (raise it).
- Gateway logs `liveness warning ... eventLoopUtilization=1` or the
  machine starts swapping (lower it).

Edit `~/.config/systemd/user/claude-max-api-proxy.service`, add or update
under `[Service]`:

```
Environment=OPENCLAW_BRIDGE_MAX_CONCURRENT=2
```

Then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart claude-max-api-proxy.service
```

Same-session-id requests (those sharing the OpenAI `user` field) are
always serialized regardless of cap; this is a separate guarantee against
context mixing when two callers reuse the same session id.

## 14. Empty responses or `incomplete turn detected` in gateway logs

The proxy ships with a `stream-safety` patch that synthesizes a single
chunk from `result.result` when the Claude CLI emits a result event with
no preceding streaming deltas. If you still see empty responses after
running `install.sh`, verify the patch was applied:

```bash
grep -c 'openclaw-bridge:stream-safety v1' \
    "$(dirname "$(readlink -f "$(command -v claude-max-api 2>/dev/null || echo /opt/none)")")/../dist/server/routes.js" 2>/dev/null \
    || grep -rc 'openclaw-bridge:stream-safety v1' \
        "$(npm root -g)/claude-max-api-proxy/dist/server/routes.js"
```

A non-zero count means the patch is in place. If it is missing, re-run
`install.sh` (idempotent).

## Getting help

Open an issue on GitHub with:

- `claude --version`
- `node --version`
- `systemctl --user status claude-max-api-proxy.service --no-pager`
- `journalctl --user -u claude-max-api-proxy.service -n 100 --no-pager`
- The relevant slice of `openclaw.json` (redact any secrets first).
