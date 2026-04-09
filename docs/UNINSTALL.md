# Uninstall

One command reverts everything this repo installed:

```bash
bash uninstall.sh
```

## What it does

1. Stops and disables `claude-max-api-proxy.service` (via `systemctl --user`).
2. Removes `~/.config/systemd/user/claude-max-api-proxy.service`.
3. Removes `~/.config/systemd/user/openclaw-gateway.service.d/99-local-bridge.conf`
   (and the directory if it is now empty).
4. Runs `systemctl --user daemon-reload`.
5. Restarts `openclaw-gateway.service` if it is installed, so the gateway
   drops the drop-in environment.
6. Looks for the most recent `~/.openclaw/openclaw.json.bak.*` backup and
   asks whether you want to restore it. If you say yes, it copies the
   backup over `openclaw.json` and restarts the gateway again. If you say
   no, or if the uninstaller is running non-interactively, the backup is
   left in place and `openclaw.json` is untouched.

## What it does NOT do

- It does not uninstall the `claude-max-api-proxy` npm package. If you
  want that too, run:

  ```bash
  npm uninstall -g claude-max-api-proxy
  ```

- It does not touch the upstream `openclaw-gateway.service` unit file.
  There was nothing to revert there; the drop-in was always a separate
  file.

- It does not delete any `openclaw.json.bak.*` backup files. You can
  remove them by hand when you are confident everything works:

  ```bash
  ls ~/.openclaw/openclaw.json.bak.*
  rm ~/.openclaw/openclaw.json.bak.<timestamp>
  ```

## Manual fallback

If for any reason you want to do it yourself without running the script:

```bash
systemctl --user disable --now claude-max-api-proxy.service
rm -f ~/.config/systemd/user/claude-max-api-proxy.service
rm -f ~/.config/systemd/user/openclaw-gateway.service.d/99-local-bridge.conf
rmdir ~/.config/systemd/user/openclaw-gateway.service.d 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
# then restore openclaw.json manually if desired
ls ~/.openclaw/openclaw.json.bak.*
cp ~/.openclaw/openclaw.json.bak.<timestamp> ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway.service
```
