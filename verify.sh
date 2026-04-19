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
PORT="${PORT:-3456}"
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
