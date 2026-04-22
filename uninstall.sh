#!/usr/bin/env bash
# openclaw-local-bridge-macos uninstaller
#
# Stops the proxy launchd service, removes the proxy install directory and
# plist, and (interactively) restores openclaw.json / gateway plist /
# claude settings from the most recent timestamped backup.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/log.sh
. "$HERE/lib/log.sh"
# shellcheck source=lib/paths.sh
. "$HERE/lib/paths.sh"

NON_INTERACTIVE=0
RESTORE="prompt"   # prompt | latest | none
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --restore-latest)  RESTORE="latest"; shift ;;
    --no-restore)      RESTORE="none"; shift ;;
    -h|--help)
      cat <<EOF
Usage: uninstall.sh [flags]
  --non-interactive    No prompts; combine with --restore-latest or --no-restore
  --restore-latest     Restore the most recent backup without asking
  --no-restore         Don't restore anything — only stop & remove the bridge
EOF
      exit 0 ;;
    *) die "Unknown flag: $1" ;;
  esac
done

PROXY_PLIST="$(proxy_plist_path)"
PROXY_HOME="$(proxy_install_dir)"
GATEWAY_PLIST="$(gateway_plist_path)"
BACKUPS_DIR="$HOME/.openclaw/bridge-backups"

step 1 6 "Stop and unload the proxy launchd service"
UID_=$(id -u)
launchctl bootout "gui/$UID_/ai.claude-max-api-proxy" 2>/dev/null || true
ok "Service unloaded (or wasn't loaded)."

step 2 6 "Remove proxy plist and install dir"
if [[ -f "$PROXY_PLIST" ]]; then
  rm -f "$PROXY_PLIST"
  ok "Removed $PROXY_PLIST"
fi
if [[ -d "$PROXY_HOME" ]]; then
  rm -rf "$PROXY_HOME"
  ok "Removed $PROXY_HOME"
fi
# Remove the bridge dir if it's now empty.
[[ -d "$HOME/.openclaw/bridge" ]] && rmdir "$HOME/.openclaw/bridge" 2>/dev/null || true

step 3 6 "Choose backup to restore"
if [[ ! -d "$BACKUPS_DIR" ]] || [[ -z "$(ls -A "$BACKUPS_DIR" 2>/dev/null)" ]]; then
  warn "No backups found under $BACKUPS_DIR. Skipping restore."
  RESTORE="none"
fi

CHOSEN=""
if [[ "$RESTORE" != "none" ]]; then
  # Latest = most recent ISO-named subdir.
  LATEST="$(ls -1 "$BACKUPS_DIR" | sort | tail -1)"
  if [[ "$RESTORE" == "latest" ]]; then
    CHOSEN="$BACKUPS_DIR/$LATEST"
  elif (( NON_INTERACTIVE )); then
    info "Non-interactive without --restore-latest/--no-restore — skipping restore."
    RESTORE="none"
  else
    info "Available backups under $BACKUPS_DIR:"
    ls -1 "$BACKUPS_DIR" | sed 's/^/  /'
    read -r -p "Restore which? (blank = latest [$LATEST], 'none' = skip): " ans
    case "$ans" in
      "")    CHOSEN="$BACKUPS_DIR/$LATEST" ;;
      none)  RESTORE="none" ;;
      *)     CHOSEN="$BACKUPS_DIR/$ans" ;;
    esac
    [[ "$RESTORE" != "none" ]] && [[ ! -d "$CHOSEN" ]] && die "Not a backup directory: $CHOSEN"
  fi
fi

step 4 6 "Restore from $CHOSEN"
if [[ "$RESTORE" == "none" ]] || [[ -z "$CHOSEN" ]]; then
  info "Skipping restore."
else
  MANIFEST="$CHOSEN/manifest.json"
  if [[ ! -f "$MANIFEST" ]]; then
    warn "No manifest in $CHOSEN — nothing to restore."
  else
    node -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const [src, dst] of Object.entries(m)) {
        try {
          if (!fs.existsSync(dst)) { console.log("  skipped (backup file missing): " + src); continue; }
          fs.cpSync(dst, src, { recursive: true });
          console.log("  restored " + src);
        } catch (e) { console.log("  failed: " + src + " — " + e.message); }
      }
    ' "$MANIFEST"
  fi
fi

step 5 6 "Unlink MCP bridge binaries and remove mcp-config.json"
if [[ -d "$HERE/mcp-core" ]]; then
  (cd "$HERE/mcp-core" && npm unlink 2>/dev/null) || warn "npm unlink failed for mcp-core (may already be unlinked)"
else
  info "mcp-core source dir missing — assuming already unlinked."
fi
if [[ -d "$HERE/watch-cli" ]]; then
  (cd "$HERE/watch-cli" && npm unlink 2>/dev/null) || warn "npm unlink failed for watch-cli (may already be unlinked)"
else
  info "watch-cli source dir missing — assuming already unlinked."
fi

MCP_CFG="$HOME/.openclaw/mcp-config.json"
restored_mcp_cfg=0
if [[ "$RESTORE" != "none" && -n "${CHOSEN:-}" && -f "$CHOSEN/manifest.json" ]]; then
  if grep -q '"mcp-config.json"' "$CHOSEN/manifest.json" 2>/dev/null; then
    restored_mcp_cfg=1
  fi
fi
if (( restored_mcp_cfg )); then
  info "Leaving $MCP_CFG in place (restored from backup)."
elif [[ -f "$MCP_CFG" ]]; then
  rm -f "$MCP_CFG"
  ok "Removed $MCP_CFG"
else
  info "No mcp-config.json to remove."
fi

step 6 6 "Reload gateway (so restored env / plist is honored)"
if [[ -f "$GATEWAY_PLIST" ]]; then
  launchctl bootout "gui/$UID_/ai.openclaw.gateway" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_" "$GATEWAY_PLIST"
  ok "Gateway reloaded."
else
  info "No gateway plist present — nothing to reload."
fi

cat <<EOF

Done. Backups preserved at $BACKUPS_DIR (delete manually if you don't want them).

EOF
