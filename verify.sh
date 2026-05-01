#!/usr/bin/env bash
# Post-install health check. Exit code = number of failures.
#
# Usage: ./verify.sh [--smoke]
#   --smoke   Also fire a real openclaw agent round-trip.
#
# Reads PORT from env (default 3456).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/log.sh
. "$HERE/lib/log.sh"

SMOKE=0
[[ "${1:-}" == "--smoke" ]] && SMOKE=1

# Auto-detect the installed port from the loaded plist so standalone
# invocations work after install.sh auto-selected a non-default port.
# Explicit PORT= env still wins.
detect_port() {
  local plist="$HOME/Library/LaunchAgents/ai.claude-max-api-proxy.plist"
  [[ -f "$plist" ]] || return 1
  plutil -extract ProgramArguments.2 raw "$plist" 2>/dev/null
}
PORT="${PORT:-$(detect_port || echo 3456)}"
UID_=$(id -u)

FAILS=0
declare -a RESULTS

check() {
  # check <label> <command…>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    RESULTS+=("PASS  $label")
  else
    RESULTS+=("FAIL  $label")
    FAILS=$((FAILS + 1))
  fi
}

# 1) launchd service registered
check "launchd: ai.claude-max-api-proxy registered" \
  bash -c "launchctl list | grep -q 'ai\\.claude-max-api-proxy'"

# 2) port listening
check "proxy listening on :$PORT" \
  bash -c "lsof -iTCP:$PORT -sTCP:LISTEN -n -P >/dev/null"

# 3) /v1/models returns and contains claude-sonnet-4
if curl -sSf -m 5 "http://localhost:$PORT/v1/models" 2>/dev/null > /tmp/openclaw-bridge-models.$$; then
  if node -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync("/tmp/openclaw-bridge-models.'"$$"'", "utf8"));
      const ids = (j.data || []).map(m => m.id);
      if (!ids.includes("claude-sonnet-4")) { console.error("missing claude-sonnet-4: " + ids.join(",")); process.exit(1); }
    ' 2>/dev/null; then
    RESULTS+=("PASS  /v1/models advertises claude-sonnet-4")
  else
    RESULTS+=("FAIL  /v1/models reachable but missing claude-sonnet-4")
    FAILS=$((FAILS + 1))
  fi
else
  RESULTS+=("FAIL  /v1/models did not respond on :$PORT")
  FAILS=$((FAILS + 1))
fi
rm -f "/tmp/openclaw-bridge-models.$$"

# 4) gateway env carries CLAUDE_CODE_ENTRYPOINT (only if gateway exists)
if launchctl list | grep -q 'ai\.openclaw\.gateway'; then
  if launchctl print "gui/$UID_/ai.openclaw.gateway" 2>/dev/null | grep -q 'CLAUDE_CODE_ENTRYPOINT'; then
    RESULTS+=("PASS  gateway carries CLAUDE_CODE_ENTRYPOINT")
  else
    RESULTS+=("FAIL  gateway env missing CLAUDE_CODE_ENTRYPOINT")
    FAILS=$((FAILS + 1))
  fi
else
  RESULTS+=("SKIP  gateway plist not loaded")
fi

# 5) openclaw config validates
check "openclaw config validate" \
  bash -c "openclaw config validate >/dev/null"

# 6) optional smoke
if (( SMOKE )); then
  if openclaw agent 'say hi in five words' --agent claude-code 2>/dev/null | grep -qiE 'hi|hello'; then
    RESULTS+=("PASS  smoke: openclaw agent round-trip")
  else
    RESULTS+=("FAIL  smoke: openclaw agent round-trip (see openclaw logs)")
    FAILS=$((FAILS + 1))
  fi
fi

echo ""
echo "── rotator checks ───────────────────────────────────────────"

PROXY_DIR="$HOME/.openclaw/bridge/claude-max-api-proxy"
ROUTES="$PROXY_DIR/dist/server/routes.js"
MANAGER="$PROXY_DIR/dist/subprocess/manager.js"
ADAPTER="$PROXY_DIR/dist/adapter/openai-to-cli.js"

check_sentinel() {
  local file="$1" sentinel="$2" label="$3"
  if [[ -f "$file" ]] && grep -q "$sentinel" "$file"; then
    echo "  ✓ $label sentinel present"
  else
    echo "  ✗ $label sentinel missing in $file"
  fi
}

check_sentinel "$ADAPTER" "@openclaw-bridge:extractContent v1" "extractContent"
check_sentinel "$ROUTES"  "@openclaw-bridge:rotator v1"         "rotator (routes.js)"
check_sentinel "$MANAGER" "@openclaw-bridge:rotator v1"         "rotator (manager.js)"
check_sentinel "$MANAGER" "@openclaw-bridge:timeout v1"         "timeout (manager.js)"
check_sentinel "$ADAPTER" "@openclaw-bridge:systemPrompt v1" "system-prompt (adapter)"
check_sentinel "$ROUTES"  "@openclaw-bridge:systemPrompt v1" "system-prompt (routes)"
check_sentinel "$MANAGER" "@openclaw-bridge:systemPrompt v1" "system-prompt (manager)"

if [[ -f "$PROXY_DIR/dist/rotator/index.js" ]]; then
  echo "  ✓ rotator modules staged in proxy tree"
else
  echo "  ✗ rotator modules missing at $PROXY_DIR/dist/rotator/"
fi

ACCOUNTS_JSON="$HOME/.openclaw/bridge/accounts.json"
if [[ -f "$ACCOUNTS_JSON" ]]; then
  if python3 -c "import json; json.load(open('$ACCOUNTS_JSON'))" >/dev/null 2>&1 \
     || node -e "JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8'))" 2>/dev/null; then
    echo "  ✓ accounts.json parses"
  else
    echo "  ✗ accounts.json malformed"
  fi
  MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8')).mode)" 2>/dev/null || echo "unknown")
  echo "  ℹ mode: $MODE"
  if [[ "$MODE" == "multi" ]]; then
    N=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$ACCOUNTS_JSON','utf8')).accounts||[]).length)")
    if [[ "$N" -ge 1 ]]; then
      echo "  ✓ $N account(s) registered"
    else
      echo "  ✗ mode=multi but no accounts registered"
    fi
  fi
else
  echo "  ℹ accounts.json absent (clean install — OK)"
fi

if command -v openclaw-bridge >/dev/null 2>&1; then
  openclaw-bridge status >/dev/null 2>&1 && echo "  ✓ openclaw-bridge status runs" || echo "  ✗ openclaw-bridge status failed"
else
  echo "  ✗ openclaw-bridge CLI not on PATH"
fi

# Print table
echo
echo "Verify results (port $PORT):"
for r in "${RESULTS[@]}"; do
  case "$r" in
    PASS*) printf '  %s\n' "$r" ;;
    FAIL*) printf '  %s\n' "$r" >&2 ;;
    SKIP*) printf '  %s\n' "$r" ;;
  esac
done
echo

if (( FAILS == 0 )); then
  ok "All checks passed."
else
  err "$FAILS check(s) failed."
fi
exit "$FAILS"
