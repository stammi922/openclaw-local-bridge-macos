#!/usr/bin/env bash
# uninstall.sh
#
# Reverts the changes made by install.sh:
#   - stops and disables claude-max-api-proxy.service
#   - removes the proxy unit file and the openclaw-gateway drop-in
#   - restores ~/.openclaw/openclaw.json from the most recent .bak
#     (with confirmation)
#   - reloads systemd and restarts openclaw-gateway if present
#
# Does NOT uninstall the claude-max-api-proxy npm package (user may keep it).

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf '%b==>%b %s\n'  "$BLUE"   "$RESET" "$*"; }
ok()    { printf '  %bok%b %s\n'  "$GREEN"  "$RESET" "$*"; }
warn()  { printf '  %b!%b  %s\n'  "$YELLOW" "$RESET" "$*"; }
err()   { printf '  %bx%b  %s\n'  "$RED"    "$RESET" "$*" >&2; }
fatal() { err "$*"; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
    fatal 'do not run this uninstaller as root. Run it as your normal user.'
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
    fatal 'systemd --user session is not active.'
fi

USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
PROXY_UNIT_PATH="${USER_SYSTEMD_DIR}/claude-max-api-proxy.service"
GATEWAY_OVERRIDE_DIR="${USER_SYSTEMD_DIR}/openclaw-gateway.service.d"
GATEWAY_OVERRIDE_PATH="${GATEWAY_OVERRIDE_DIR}/99-local-bridge.conf"

OPENCLAW_CFG="${HOME}/.openclaw/openclaw.json"

# ---- stop + disable proxy ------------------------------------------------

info 'Stopping claude-max-api-proxy.service'
if systemctl --user list-unit-files claude-max-api-proxy.service 2>/dev/null | grep -q '^claude-max-api-proxy.service'; then
    systemctl --user disable --now claude-max-api-proxy.service >/dev/null 2>&1 || true
    ok 'proxy service stopped and disabled'
else
    warn 'claude-max-api-proxy.service not registered (already removed?)'
fi

# ---- remove unit file ----------------------------------------------------

if [ -f "$PROXY_UNIT_PATH" ]; then
    rm -f "$PROXY_UNIT_PATH"
    ok "removed $PROXY_UNIT_PATH"
else
    warn "no unit file at $PROXY_UNIT_PATH"
fi

# ---- remove drop-in ------------------------------------------------------

if [ -f "$GATEWAY_OVERRIDE_PATH" ]; then
    rm -f "$GATEWAY_OVERRIDE_PATH"
    ok "removed $GATEWAY_OVERRIDE_PATH"
    # remove the override dir if now empty
    if [ -d "$GATEWAY_OVERRIDE_DIR" ] && [ -z "$(ls -A "$GATEWAY_OVERRIDE_DIR" 2>/dev/null)" ]; then
        rmdir "$GATEWAY_OVERRIDE_DIR"
        ok "removed empty $GATEWAY_OVERRIDE_DIR"
    fi
else
    warn "no drop-in at $GATEWAY_OVERRIDE_PATH"
fi

# ---- daemon-reload + restart gateway ------------------------------------

info 'Reloading systemd user daemon'
systemctl --user daemon-reload
ok 'daemon-reload done'

if systemctl --user list-unit-files openclaw-gateway.service 2>/dev/null | grep -q '^openclaw-gateway.service'; then
    info 'Restarting openclaw-gateway.service'
    if systemctl --user restart openclaw-gateway.service; then
        ok 'openclaw-gateway.service restarted'
    else
        warn 'openclaw-gateway.service restart failed; check: systemctl --user status openclaw-gateway.service'
    fi
fi

# ---- restore openclaw.json from backup ----------------------------------

info 'Looking for openclaw.json backups'

if [ ! -d "$(dirname "$OPENCLAW_CFG")" ]; then
    warn "no ~/.openclaw directory; nothing to restore"
else
    # Find newest backup (matches openclaw.json.bak.YYYYMMDD-HHMMSS)
    LATEST_BAK="$(ls -1t "${OPENCLAW_CFG}".bak.* 2>/dev/null | head -n 1 || true)"
    if [ -z "$LATEST_BAK" ]; then
        warn 'no .bak backup found; openclaw.json left unchanged'
        warn 'edit it by hand if you want to remove the local provider entries'
    else
        printf '\n  %bmost recent backup:%b %s\n' "$BOLD" "$RESET" "$LATEST_BAK"
        printf '  %brestore it over the current openclaw.json? [y/N] %b' "$BOLD" "$RESET"
        # If stdin is not a tty (e.g. curl | bash), default to "no" for safety.
        if [ -t 0 ]; then
            read -r ANSWER || ANSWER='n'
        else
            ANSWER='n'
            printf 'n (non-interactive)\n'
        fi
        case "$ANSWER" in
            y|Y|yes|YES)
                cp -a "$LATEST_BAK" "$OPENCLAW_CFG"
                ok "restored $OPENCLAW_CFG from $LATEST_BAK"
                if systemctl --user list-unit-files openclaw-gateway.service 2>/dev/null | grep -q '^openclaw-gateway.service'; then
                    info 'Restarting openclaw-gateway.service to pick up restored config'
                    systemctl --user restart openclaw-gateway.service || warn 'restart failed'
                fi
                ;;
            *)
                warn "skipped restore; backup remains at $LATEST_BAK"
                ;;
        esac
    fi
fi

printf '\n'
printf '%b+---------------------------------------------------------------+%b\n' "$GREEN" "$RESET"
printf '%b|                    uninstall complete                          |%b\n' "$GREEN" "$RESET"
printf '%b+---------------------------------------------------------------+%b\n' "$GREEN" "$RESET"
printf '\n'
printf '  The claude-max-api-proxy npm package was %bnot%b removed.\n' "$BOLD" "$RESET"
printf '  To remove it manually:  npm uninstall -g claude-max-api-proxy\n'
printf '\n'
