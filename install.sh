#!/usr/bin/env bash
# openclaw-local-bridge-macos installer
#
# Routes OpenClaw agents through your local Claude Code CLI on macOS by
# running claude-max-api-proxy under launchd and patching ~/.openclaw/openclaw.json.
#
# See README.md for design and motivation.
set -euo pipefail

# ---------- Resolve script dir (absolute, even via curl|bash bootstrap) -----
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$HERE"

# shellcheck source=lib/log.sh
. "$REPO_ROOT/lib/log.sh"
# shellcheck source=lib/preflight.sh
. "$REPO_ROOT/lib/preflight.sh"
# shellcheck source=lib/paths.sh
. "$REPO_ROOT/lib/paths.sh"
# shellcheck source=lib/backup.sh
. "$REPO_ROOT/lib/backup.sh"

# ---------- Defaults & flag parsing ----------------------------------------
PORT_DEFAULT=3456
FLAG_PORT=""
NON_INTERACTIVE=0
DRY_RUN=0
SKIP_VERIFY=0
FORCE=0
WITH_CLAUDE_PERMS="prompt"   # prompt | yes | no
ENABLE_MULTI_ACCOUNT=0

usage() {
  cat <<EOF
Usage: install.sh [flags]

Flags:
  --port N                       Override the default port ($PORT_DEFAULT)
  --dry-run                      Print what would happen, write nothing
  --non-interactive              No prompts; safe defaults
  --with-claude-permissions      Add Bash(*) + mcp__* allows non-interactively
  --no-claude-permissions        Skip the permissions step entirely
  --skip-verify                  Don't run verify.sh after installing
  --force                        Continue past soft warnings
  --uninstall                    Delegate to ./uninstall.sh
  --enable-multi-account         Print risk notice for multi-account rotator (heavy-user opt-in)
  -h, --help                     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)                     FLAG_PORT="$2"; shift 2 ;;
    --port=*)                   FLAG_PORT="${1#*=}"; shift ;;
    --non-interactive)          NON_INTERACTIVE=1; shift ;;
    --dry-run)                  DRY_RUN=1; shift ;;
    --skip-verify)              SKIP_VERIFY=1; shift ;;
    --force)                    FORCE=1; shift ;;
    --with-claude-permissions)  WITH_CLAUDE_PERMS="yes"; shift ;;
    --no-claude-permissions)    WITH_CLAUDE_PERMS="no"; shift ;;
    --uninstall)                exec "$REPO_ROOT/uninstall.sh" ;;
    --enable-multi-account)     ENABLE_MULTI_ACCOUNT=1; shift ;;
    -h|--help)                  usage; exit 0 ;;
    *) err "Unknown flag: $1"; usage; exit 2 ;;
  esac
done

((DRY_RUN)) && info "DRY-RUN mode — no files will be modified."

# ---------- Steps ----------------------------------------------------------

TOTAL=14

step 1 $TOTAL "Preflight checks"
require_macos
require_node
require_cmd plutil launchctl
require_openclaw
warn_claude_cli || true
require_openclaw_json

step 2 $TOTAL "Resolve dynamic paths"
NODE_BIN="$(get_node_bin)"
CLAUDE_BIN="$(get_claude_bin || true)"
PROXY_HOME="$(proxy_install_dir)"
PROXY_PLIST="$(proxy_plist_path)"
GATEWAY_PLIST="$(gateway_plist_path)"
PLIST_PATH_VAL="$(compose_plist_path)"
info "  NODE_BIN     = $NODE_BIN"
info "  CLAUDE_BIN   = ${CLAUDE_BIN:-<none>}"
info "  PROXY_HOME   = $PROXY_HOME"
info "  PROXY_PLIST  = $PROXY_PLIST"
info "  GATEWAY_PLIST= $GATEWAY_PLIST $([[ -f "$GATEWAY_PLIST" ]] && echo '(present)' || echo '(absent — will skip gateway env injection)')"
info "  plist PATH   = $PLIST_PATH_VAL"

step 3 $TOTAL "Select port"
PORT="${FLAG_PORT:-$PORT_DEFAULT}"
port_in_use() { lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }
if port_in_use "$PORT"; then
  if [[ -n "$FLAG_PORT" ]]; then
    die "Port $PORT is already in use (you specified it via --port). Pick a different one."
  fi
  if (( NON_INTERACTIVE )); then
    candidate="$PORT"
    for _ in $(seq 1 20); do
      candidate=$((candidate + 1))
      if ! port_in_use "$candidate"; then
        warn "Default port $PORT is busy. Auto-selected free port $candidate."
        PORT="$candidate"
        break
      fi
    done
    if port_in_use "$PORT"; then
      die "Couldn't find a free port near $PORT_DEFAULT. Pass --port explicitly."
    fi
  else
    warn "Default port $PORT is in use."
    read -r -p "  Enter a port to try (blank = auto-pick next free): " entered
    if [[ -n "$entered" ]]; then
      [[ "$entered" =~ ^[0-9]+$ ]] || die "Not a number: $entered"
      port_in_use "$entered" && die "Port $entered is also in use."
      PORT="$entered"
    else
      candidate="$PORT"
      for _ in $(seq 1 20); do
        candidate=$((candidate + 1))
        if ! port_in_use "$candidate"; then PORT="$candidate"; break; fi
      done
      info "Selected free port $PORT"
    fi
  fi
fi
ok "Using port $PORT"

step 4 $TOTAL "Install bundled proxy to $PROXY_HOME"
if (( DRY_RUN )); then
  dim "  would: cp -a $REPO_ROOT/vendor/claude-max-api-proxy → $PROXY_HOME"
else
  mkdir -p "$(dirname "$PROXY_HOME")"
  if [[ -d "$PROXY_HOME" ]]; then
    info "  $PROXY_HOME already exists — refreshing in place"
    rm -rf "$PROXY_HOME"
  fi
  cp -a "$REPO_ROOT/vendor/claude-max-api-proxy" "$PROXY_HOME"
  if [[ ! -d "$PROXY_HOME/node_modules" ]]; then
    info "  vendored node_modules missing (curl-bootstrap?) — running npm ci"
    (cd "$PROXY_HOME" && npm ci --omit=dev --no-audit --no-fund)
  fi
  ok "Proxy installed at $PROXY_HOME"
fi
mkdir -p "$HOME/.openclaw/logs"

step 5 $TOTAL "Back up files about to change"
if (( DRY_RUN )); then
  dim "  would create: $HOME/.openclaw/bridge-backups/<timestamp>/"
else
  init_backup_dir
  backup_file "$PROXY_HOME/dist/adapter/openai-to-cli.js" "openai-to-cli.js"
  backup_file "$HOME/.openclaw/openclaw.json"             "openclaw.json"
  backup_file "$GATEWAY_PLIST"                            "ai.openclaw.gateway.plist"
  backup_file "$HOME/.claude/settings.json"               "claude-settings.json"
  ok "Backups in $BRIDGE_BACKUP_DIR"
fi

step 6 $TOTAL "Patch proxy adapter"
node "$REPO_ROOT/scripts/patch-adapter.mjs" "$PROXY_HOME/dist/adapter/openai-to-cli.js" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run)

step 7 $TOTAL "Patch proxy to install rotator"
node "$REPO_ROOT/scripts/patch-proxy-rotator.mjs" "$PROXY_HOME" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run)

step 8 $TOTAL "Scaffold rotator bridge state and link CLI"
BRIDGE_DIR="$HOME/.openclaw/bridge"
if (( ! DRY_RUN )); then
  mkdir -p "$BRIDGE_DIR"
  if [[ ! -f "$BRIDGE_DIR/accounts.json" ]]; then
    cp "$REPO_ROOT/templates/accounts.json.tmpl" "$BRIDGE_DIR/accounts.json"
    info "Created $BRIDGE_DIR/accounts.json (mode=single)"
  else
    info "Kept existing $BRIDGE_DIR/accounts.json"
  fi
fi

NPM_BIN="$(npm prefix -g)/bin"
if (( ! DRY_RUN )); then
  mkdir -p "$NPM_BIN"
  ln -sf "$REPO_ROOT/cli/openclaw-bridge" "$NPM_BIN/openclaw-bridge"
  info "Linked openclaw-bridge → $NPM_BIN/openclaw-bridge"
fi

step 9 $TOTAL "Patch ~/.openclaw/openclaw.json"
node "$REPO_ROOT/scripts/patch-openclaw-config.mjs" "$HOME/.openclaw/openclaw.json" "$PORT" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run)
if (( ! DRY_RUN )); then
  if openclaw config validate >/dev/null 2>&1; then
    ok "openclaw config validate: pass"
  else
    err "openclaw config validate FAILED — restoring backup."
    cp -a "$BRIDGE_BACKUP_DIR/openclaw.json" "$HOME/.openclaw/openclaw.json"
    die "Patched config rejected by openclaw — restored from backup."
  fi
fi

step 10 $TOTAL "Patch gateway plist (if present)"
node "$REPO_ROOT/scripts/patch-gateway-plist.mjs" "$GATEWAY_PLIST" $([[ $DRY_RUN -eq 1 ]] && echo --dry-run)

step 11 $TOTAL "Render proxy plist & (re)load launchd services"
if (( DRY_RUN )); then
  dim "  would write: $PROXY_PLIST"
  dim "  would: launchctl bootout/bootstrap proxy (and gateway if present)"
else
  node "$REPO_ROOT/scripts/render-proxy-plist.mjs" \
    --template  "$REPO_ROOT/templates/ai.claude-max-api-proxy.plist.tmpl" \
    --home      "$HOME" \
    --node      "$NODE_BIN" \
    --proxy-home "$PROXY_HOME" \
    --port      "$PORT" \
    --path      "$PLIST_PATH_VAL" \
    > "$PROXY_PLIST"
  chmod 644 "$PROXY_PLIST"
  ok "Wrote $PROXY_PLIST"

  UID_=$(id -u)

  # launchctl bootout returns 0 before the service has fully torn down, so a
  # subsequent bootstrap races the kernel and can fail with "Bootstrap failed:
  # 5: Input/output error". Wait for the label to leave `launchctl list`, then
  # retry bootstrap a few times for good measure. Keeps the happy path fast
  # (bootstrap usually succeeds on first try) without a fixed sleep.
  launchd_reload() {
    local label="$1" plist="$2"
    launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
    local i=0
    while (( i < 20 )) && launchctl list | awk '{print $3}' | grep -qx "$label"; do
      sleep 0.1; i=$((i+1))
    done
    i=0
    while (( i < 10 )); do
      if launchctl bootstrap "gui/$UID_" "$plist" 2>/dev/null; then return 0; fi
      sleep 0.2; i=$((i+1))
    done
    launchctl bootstrap "gui/$UID_" "$plist"
  }

  launchd_reload "ai.claude-max-api-proxy" "$PROXY_PLIST"
  launchctl kickstart -k "gui/$UID_/ai.claude-max-api-proxy" || true
  ok "Loaded ai.claude-max-api-proxy"

  if [[ -f "$GATEWAY_PLIST" ]]; then
    launchd_reload "ai.openclaw.gateway" "$GATEWAY_PLIST"
    ok "Reloaded ai.openclaw.gateway with new env"
  fi
fi

step 12 $TOTAL "Claude Code permissions"
add_claude_perms() {
  if (( DRY_RUN )); then
    node "$REPO_ROOT/scripts/patch-claude-settings.mjs" --dry-run
  else
    node "$REPO_ROOT/scripts/patch-claude-settings.mjs"
  fi
}
case "$WITH_CLAUDE_PERMS" in
  no)
    info "Skipping Claude Code permissions step (--no-claude-permissions)."
    ;;
  yes)
    add_claude_perms
    ;;
  prompt)
    if (( NON_INTERACTIVE )); then
      info "Skipping Claude Code permissions step (non-interactive default; pass --with-claude-permissions to opt in)."
    else
      cat <<EOF

OpenClaw delegates tool execution to Claude Code, which by default asks for
your approval before running each bash command or MCP tool call. For agents
to run autonomously you can pre-approve them by adding the following to
~/.claude/settings.json:

  {
    "permissions": {
      "allow": ["Bash(*)", "mcp__*"]
    }
  }

  Bash(*)   pre-approves every bash command Claude Code runs
  mcp__*    pre-approves every MCP tool call

WARNING: This grants Claude Code blanket permission to run any shell command
and any MCP tool without asking. That is what enables openclaw to work
autonomously, but it also means a misbehaving prompt could run destructive
commands unprompted. Only accept if you trust the agents and prompts you run.

Existing keys in ~/.claude/settings.json are preserved. The pre-mutation copy
is backed up alongside the other bridge backups so uninstall can restore it.

EOF
      read -r -p "Add these permissions to ~/.claude/settings.json? [Y/n] " answer
      case "${answer:-Y}" in
        [Yy]*) add_claude_perms ;;
        *)     info "Skipped." ;;
      esac
    fi
    ;;
esac

step 13 $TOTAL "Verify"
if (( SKIP_VERIFY || DRY_RUN )); then
  info "Skipping verify ($([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo --skip-verify))."
else
  PORT="$PORT" "$REPO_ROOT/verify.sh" || warn "verify reported failures — check the table above."
fi

step 14 $TOTAL "Install MCP bridge binaries (openclaw-core-mcp, openclaw-watch)"
if (( DRY_RUN )); then
  dim "  would: (cd $REPO_ROOT && npm install --workspaces --include-workspace-root --no-audit --no-fund)"
  dim "  would: npm run build -w mcp-core && npm run build -w watch-cli"
  dim "  would: (cd $REPO_ROOT/mcp-core  && npm link)"
  dim "  would: (cd $REPO_ROOT/watch-cli && npm link)"
  dim "  would: verify openclaw-core-mcp and openclaw-watch on PATH"
  dim "  would: backup existing $HOME/.openclaw/mcp-config.json (if present)"
  dim "  would render: $HOME/.openclaw/mcp-config.json (from proxy/mcp-config.json.template)"
else
  (cd "$REPO_ROOT" && npm install --workspaces --include-workspace-root --no-audit --no-fund)
  (cd "$REPO_ROOT" && npm run build -w mcp-core && npm run build -w watch-cli)

  link_status=0
  (cd "$REPO_ROOT/mcp-core"  && npm link) || link_status=$?
  if (( link_status != 0 )); then
    warn "npm link for mcp-core exited with status $link_status — continuing."
  fi
  link_status=0
  (cd "$REPO_ROOT/watch-cli" && npm link) || link_status=$?
  if (( link_status != 0 )); then
    warn "npm link for watch-cli exited with status $link_status — continuing."
  fi

  if ! command -v openclaw-core-mcp >/dev/null || ! command -v openclaw-watch >/dev/null; then
    warn "openclaw-core-mcp and/or openclaw-watch not found on PATH."
    warn "  Check 'npm config get prefix' and ensure its bin dir is on your PATH."
  fi

  if [[ -n "${BRIDGE_BACKUP_DIR:-}" ]]; then
    backup_file "$HOME/.openclaw/mcp-config.json" "mcp-config.json"
  fi

  mkdir -p "$HOME/.openclaw"
  sed "s#__HOME__#${HOME}#g" "$REPO_ROOT/proxy/mcp-config.json.template" > "$HOME/.openclaw/mcp-config.json"
  chmod 600 "$HOME/.openclaw/mcp-config.json"
  ok "Wrote $HOME/.openclaw/mcp-config.json"
fi

if (( ENABLE_MULTI_ACCOUNT == 1 )); then
  cat <<'RISK'

╔════════════════════════════════════════════════════════════════════╗
║                    MULTI-ACCOUNT ROTATOR — RISK                    ║
╠════════════════════════════════════════════════════════════════════╣
║ Pooling multiple Claude Max accounts to avoid rate/usage limits    ║
║ may be treated by Anthropic as abuse of the Services.              ║
║ Detection can cause SIMULTANEOUS TERMINATION of every account.     ║
║ See docs/MULTI_ACCOUNT.md for the full risk breakdown.             ║
║ Use at your own risk.                                              ║
╚════════════════════════════════════════════════════════════════════╝

To continue, type exactly:  I accept the risk
RISK
  read -r ACK
  if [[ "$ACK" != "I accept the risk" ]]; then
    warn "Multi-account risk not acknowledged — rotator code is installed but mode stays 'single'."
  else
    info "Risk acknowledged. Rotator code installed. Next: openclaw-bridge accounts add <label>"
  fi
fi

cat <<EOF

$( ((DRY_RUN)) && echo "DRY-RUN complete. Re-run without --dry-run to apply." || echo "Done." )

Next steps:
  - Tail logs:     tail -f ~/.openclaw/logs/claude-max-api-proxy.{log,err.log}
  - Test agent:    openclaw agent 'say hi in five words' --agent claude-code
  - MCP client cfg: $HOME/.openclaw/mcp-config.json
  - Tail events:    openclaw-watch
  - Uninstall:     ./uninstall.sh

EOF
