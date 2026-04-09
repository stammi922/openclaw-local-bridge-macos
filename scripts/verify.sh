#!/usr/bin/env bash
# verify.sh
#
# Post-install health check for openclaw-local-bridge.
# Exits 0 on full success, 1 if any hard check fails.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
WARN=0
FAIL=0

header() {
    printf '\n%b==>%b %s\n' "$BOLD" "$RESET" "$1"
}

ok() {
    printf '  %bok%b  %s\n' "$GREEN" "$RESET" "$1"
    PASS=$((PASS + 1))
}

warn() {
    printf '  %b!%b   %s\n' "$YELLOW" "$RESET" "$1"
    WARN=$((WARN + 1))
}

fail() {
    printf '  %bx%b   %s\n' "$RED" "$RESET" "$1"
    FAIL=$((FAIL + 1))
}

has_systemd_user() {
    systemctl --user show-environment >/dev/null 2>&1
}

service_exists() {
    systemctl --user list-unit-files "$1" 2>/dev/null | grep -q "^$1"
}

header 'systemd user session'
if has_systemd_user; then
    ok 'systemd --user is available'
else
    fail 'systemd --user session is not active (run: loginctl enable-linger $USER)'
fi

header 'claude-max-api-proxy.service'
if service_exists 'claude-max-api-proxy.service'; then
    ok 'unit file is installed'
    if systemctl --user is-active --quiet claude-max-api-proxy.service; then
        ok 'service is active'
    else
        fail 'service is not active (systemctl --user status claude-max-api-proxy.service)'
    fi
    if systemctl --user is-enabled --quiet claude-max-api-proxy.service 2>/dev/null; then
        ok 'service is enabled at login'
    else
        warn 'service is not enabled (will not restart on next login)'
    fi
else
    fail 'claude-max-api-proxy.service is not installed'
fi

header 'local proxy endpoint (http://localhost:3457)'
LISTENING=0
if command -v ss >/dev/null 2>&1; then
    if ss -tln 2>/dev/null | grep -qE '[:.]3457[[:space:]]'; then
        ok 'port 3457 is listening'
        LISTENING=1
    fi
fi
if [ "$LISTENING" -eq 0 ] && command -v netstat >/dev/null 2>&1; then
    if netstat -tln 2>/dev/null | grep -qE '[:.]3457[[:space:]]'; then
        ok 'port 3457 is listening'
        LISTENING=1
    fi
fi
if [ "$LISTENING" -eq 0 ]; then
    # Fall back to a direct curl probe: if it answers, it is effectively listening.
    if command -v curl >/dev/null 2>&1 && curl -sSf -m 5 http://localhost:3457/v1/models >/dev/null 2>&1; then
        ok 'proxy answers on http://localhost:3457'
        LISTENING=1
    fi
fi
if [ "$LISTENING" -eq 0 ]; then
    fail 'nothing is listening on port 3457'
fi

if command -v curl >/dev/null 2>&1; then
    BODY="$(curl -sSf -m 5 http://localhost:3457/v1/models 2>/dev/null || true)"
    if [ -n "$BODY" ]; then
        if printf '%s' "$BODY" | grep -qi 'claude'; then
            ok '/v1/models returns a claude-* model list'
        else
            warn '/v1/models responded but no claude model ids found'
        fi
    else
        warn 'could not curl http://localhost:3457/v1/models'
    fi
else
    warn 'curl not available, skipped /v1/models probe'
fi

header 'openclaw-gateway.service (if installed)'
if service_exists 'openclaw-gateway.service'; then
    ok 'openclaw-gateway.service is installed'
    ENV_LINE="$(systemctl --user show openclaw-gateway.service -p Environment 2>/dev/null || true)"
    if printf '%s' "$ENV_LINE" | grep -q 'CLAUDE_CODE_ENTRYPOINT=cli'; then
        ok 'drop-in env var is present in runtime (CLAUDE_CODE_ENTRYPOINT=cli)'
    else
        fail 'CLAUDE_CODE_ENTRYPOINT=cli is not present in runtime environment (drop-in not loaded?)'
    fi
    if systemctl --user is-active --quiet openclaw-gateway.service; then
        ok 'openclaw-gateway.service is active'
    else
        warn 'openclaw-gateway.service is not active (not started yet?)'
    fi
else
    warn 'openclaw-gateway.service is not installed on this machine (skipping drop-in check)'
fi

header 'openclaw.json provider'
CFG="${HOME}/.openclaw/openclaw.json"
if [ -f "$CFG" ]; then
    if grep -q '"baseUrl": "http://localhost:3457/v1"' "$CFG"; then
        ok 'openclaw.json points at http://localhost:3457/v1'
    else
        fail 'openclaw.json does not reference http://localhost:3457/v1'
    fi
    if grep -q '"cliBackends"' "$CFG"; then
        warn 'openclaw.json still contains a cliBackends block'
    else
        ok 'legacy cliBackends block is absent'
    fi
else
    fail "openclaw.json not found at $CFG"
fi

header 'summary'
printf '  %bpass%b:  %d\n' "$GREEN"  "$RESET" "$PASS"
printf '  %bwarn%b:  %d\n' "$YELLOW" "$RESET" "$WARN"
printf '  %bfail%b:  %d\n' "$RED"    "$RESET" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
    printf '\n%bverify: FAILED%b  see docs/TROUBLESHOOTING.md\n' "$RED" "$RESET"
    exit 1
fi

printf '\n%bverify: OK%b\n' "$GREEN" "$RESET"
exit 0
