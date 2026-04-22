#!/usr/bin/env bash
# End-to-end: prove main can actually spawn a subagent through the proxy+MCP stack.
# Assumes:
#   - openclaw gateway is running
#   - claude-max-api-proxy is running under launchd with OPENCLAW_MCP_CONFIG set
#   - ~/.openclaw/mcp-config.json was rendered by install.sh step 12
# Gated: only runs when E2E=1.
set -euo pipefail

[[ "${E2E:-}" == "1" ]] || { echo "E2E unset; skip."; exit 0; }

LCM_DB="${HOME}/.openclaw/lcm.db"
[[ -f "$LCM_DB" ]] || { echo "[e2e] lcm.db missing: $LCM_DB"; exit 1; }
command -v openclaw >/dev/null || { echo "[e2e] openclaw not on PATH"; exit 1; }
command -v sqlite3 >/dev/null || { echo "[e2e] sqlite3 not on PATH"; exit 1; }

before_count="$(sqlite3 "$LCM_DB" "SELECT COUNT(*) FROM messages WHERE session_key LIKE 'agent:main:subagent:%';")"
echo "[e2e] subagent messages before: ${before_count}"

SID="$(uuidgen | tr 'A-Z' 'a-z')"
echo "[e2e] main session id: ${SID}"

if ! timeout 90 openclaw agent \
    --agent main \
    --session-id "$SID" \
    --message "Use the sessions_spawn tool to spawn a subagent whose only job is to reply with the single word SUB-PONG. Wait for its reply. Then respond with exactly what the subagent said, nothing else." \
    --json >/tmp/e2e-main.out 2>/tmp/e2e-main.err; then
  echo "[e2e] FAIL: main invocation failed. stderr tail:"
  tail -n 40 /tmp/e2e-main.err
  exit 1
fi

after_count="$(sqlite3 "$LCM_DB" "SELECT COUNT(*) FROM messages WHERE session_key LIKE 'agent:main:subagent:%';")"
echo "[e2e] subagent messages after: ${after_count}"

if (( after_count <= before_count )); then
  echo "[e2e] FAIL: no new subagent message rows in lcm.db"
  exit 1
fi

pong_hit="$(sqlite3 "$LCM_DB" \
  "SELECT COUNT(*) FROM messages WHERE session_key LIKE 'agent:main:subagent:%' AND content LIKE '%SUB-PONG%';")"
if (( pong_hit < 1 )); then
  echo "[e2e] FAIL: SUB-PONG never appeared in a subagent's content"
  exit 1
fi

main_echoed="$(sqlite3 "$LCM_DB" \
  "SELECT COUNT(*) FROM messages WHERE session_key = 'agent:main:main' AND content LIKE '%SUB-PONG%' AND created_at > datetime('now', '-2 minutes');")"
if (( main_echoed < 1 )); then
  echo "[e2e] FAIL: main never echoed SUB-PONG within the last 2 minutes"
  exit 1
fi

echo "[e2e] PASS"
