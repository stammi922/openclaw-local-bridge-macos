#!/usr/bin/env bash
# install.sh
#
# openclaw-local-bridge: one-command installer.
#
# Sets up a local Claude Code bridge for OpenClaw:
#   - installs claude-max-api-proxy (localhost:3457, OpenAI-compatible)
#   - writes a systemd user unit for the proxy with a clean lifecycle
#   - writes a systemd drop-in for openclaw-gateway that declares the
#     runtime environment used by the local Claude Code install
#   - patches ~/.openclaw/openclaw.json to use the local bridge
#   - enables + starts the services and runs a full health check
#
# Idempotent. Reversible via uninstall.sh.

set -euo pipefail

# -------- pretty output --------------------------------------------------

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { printf '%b==>%b %s\n'        "$BLUE"   "$RESET" "$*"; }
ok()      { printf '  %bok%b %s\n'        "$GREEN"  "$RESET" "$*"; }
warn()    { printf '  %b!%b  %s\n'        "$YELLOW" "$RESET" "$*"; }
err()     { printf '  %bx%b  %s\n'        "$RED"    "$RESET" "$*" >&2; }
fatal()   { err "$*"; exit 1; }

banner() {
    printf '\n'
    printf '%b+---------------------------------------------------------------+%b\n' "$BOLD" "$RESET"
    printf '%b|                  openclaw-local-bridge                        |%b\n' "$BOLD" "$RESET"
    printf '%b|    local Claude Code bridge for OpenClaw on localhost:3457    |%b\n' "$BOLD" "$RESET"
    printf '%b+---------------------------------------------------------------+%b\n' "$BOLD" "$RESET"
    printf '\n'
}

# -------- locate repo root -----------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

TEMPLATE_PROXY_UNIT="$REPO_ROOT/systemd/claude-max-api-proxy.service.template"
TEMPLATE_OVERRIDE="$REPO_ROOT/systemd/openclaw-gateway.override.conf.template"
PATCH_SCRIPT="$REPO_ROOT/scripts/patch-openclaw-config.js"
DETECT_SCRIPT="$REPO_ROOT/scripts/detect-paths.sh"
VERIFY_SCRIPT="$REPO_ROOT/scripts/verify.sh"

for f in "$TEMPLATE_PROXY_UNIT" "$TEMPLATE_OVERRIDE" "$PATCH_SCRIPT" "$DETECT_SCRIPT" "$VERIFY_SCRIPT"; do
    [ -f "$f" ] || fatal "missing repo file: $f"
done

# Activate the in-repo pre-commit hook (blocks accidental commits of
# secrets and docs/superpowers/ working notes). No-op if already set.
HOOKS_DIR="$REPO_ROOT/scripts/git-hooks"
if [ -d "$HOOKS_DIR" ] && [ -d "$REPO_ROOT/.git" ]; then
    CURRENT_HOOKS_PATH="$(git -C "$REPO_ROOT" config --get core.hooksPath || true)"
    if [ "$CURRENT_HOOKS_PATH" != "scripts/git-hooks" ]; then
        git -C "$REPO_ROOT" config core.hooksPath scripts/git-hooks
    fi
fi

banner

# -------- safety checks --------------------------------------------------

info 'Running prerequisite checks'

if [ "$(id -u)" -eq 0 ]; then
    fatal 'do not run this installer as root. Run it as your normal user so the systemd --user units land in the right place.'
fi

if ! command -v claude >/dev/null 2>&1; then
    fatal 'Claude CLI not found. Install Claude Code from https://docs.anthropic.com/claude/docs/claude-code then re-run.'
fi
ok "claude found at $(command -v claude)"

CLAUDE_VERSION="$(claude --version 2>/dev/null || true)"
if [ -z "$CLAUDE_VERSION" ]; then
    warn 'could not read "claude --version" output, continuing'
    CLAUDE_VERSION='unknown'
else
    ok "claude version: $CLAUDE_VERSION"
fi

if ! command -v node >/dev/null 2>&1; then
    fatal 'Node.js not found. Install Node.js 18+ from https://nodejs.org/ then re-run.'
fi
ok "node found at $(command -v node) ($(node --version 2>/dev/null || echo '?'))"

if ! command -v npm >/dev/null 2>&1; then
    fatal 'npm not found. It ships with Node.js; re-install Node.js and re-run.'
fi
ok "npm found at $(command -v npm) ($(npm --version 2>/dev/null || echo '?'))"

if ! systemctl --user show-environment >/dev/null 2>&1; then
    fatal 'systemd --user session is not active. Enable it with: loginctl enable-linger '"$USER"' then log out and back in.'
fi
ok 'systemd --user session is active'

OPENCLAW_CFG="${HOME}/.openclaw/openclaw.json"
if [ ! -f "$OPENCLAW_CFG" ]; then
    fatal "OpenClaw config not found at $OPENCLAW_CFG. Install OpenClaw first."
fi
ok "OpenClaw config found at $OPENCLAW_CFG"

# -------- detect paths via helper ----------------------------------------

info 'Detecting system paths'

# shellcheck disable=SC1090
eval "$(bash "$DETECT_SCRIPT")"

ok "node bin:   $NODE_BIN"
ok "npm bin:    $NPM_BIN"
ok "claude bin: $CLAUDE_BIN"
ok "npm global: $NPM_GLOBAL_ROOT"

# -------- install claude-max-api-proxy if missing ------------------------

info 'Checking claude-max-api-proxy'

if [ "$PROXY_INSTALLED" = "1" ] && [ -n "$PROXY_ENTRY" ] && [ -f "$PROXY_ENTRY" ]; then
    ok "claude-max-api-proxy already installed at $PROXY_ENTRY"
else
    info "installing claude-max-api-proxy via: npm install -g claude-max-api-proxy"
    if ! "$NPM_BIN" install -g claude-max-api-proxy; then
        fatal 'npm install -g claude-max-api-proxy failed. See the error above. If your npm global prefix requires sudo, reconfigure it to a user-writable path (e.g. ~/.npm-global) and retry.'
    fi
    # re-detect
    # shellcheck disable=SC1090
    eval "$(bash "$DETECT_SCRIPT")"
    if [ "$PROXY_INSTALLED" != "1" ] || [ -z "$PROXY_ENTRY" ] || [ ! -f "$PROXY_ENTRY" ]; then
        fatal 'claude-max-api-proxy installed but standalone.js entry point was not found. Please open an issue.'
    fi
    ok "claude-max-api-proxy installed at $PROXY_ENTRY"
    warn 'This installer uses the published claude-max-api-proxy package from npm. If you maintain a fork, reinstall it manually after this script completes.'
fi

# -------- patch claude-max-api-proxy openai-to-cli adapter ----------------
# OpenClaw 4.15+ sends user content as array [{type:"text",text:"..."}].
# The default proxy adapter does parts.push(msg.content) which JS converts to
# "[object Object]" for arrays. Fix: extract .text from text-typed parts.

PROXY_ROOT="$(dirname "$(dirname "$PROXY_ENTRY")")"
ADAPTER_FILE="$PROXY_ROOT/dist/adapter/openai-to-cli.js"

if [ -f "$ADAPTER_FILE" ]; then
    if grep -q "function extractContent" "$ADAPTER_FILE"; then
        ok "openai-to-cli adapter already patched (extractContent present)"
    else
        info "patching openai-to-cli.js (multimodal/array content extractor)"
        cp -a "$ADAPTER_FILE" "${ADAPTER_FILE}.bak.$(date +%s)"
        node -e '
const fs = require("fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
const helper = `function extractContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (p && p.type === "text" && typeof p.text === "string") ? p.text : "").filter(Boolean).join("\n");
  return String(c == null ? "" : c);
}
`;
if (!s.includes("function extractContent")) {
  s = s.replace("export function messagesToPrompt(", helper + "export function messagesToPrompt(");
}
s = s.replace("`<system>\\n${msg.content}\\n</system>\\n`", "`<system>\\n${extractContent(msg.content)}\\n</system>\\n`");
s = s.replace("parts.push(msg.content)", "parts.push(extractContent(msg.content))");
s = s.replace("`<previous_response>\\n${msg.content}\\n</previous_response>\\n`", "`<previous_response>\\n${extractContent(msg.content)}\\n</previous_response>\\n`");
fs.writeFileSync(p, s);
' "$ADAPTER_FILE"
        ok "openai-to-cli.js patched (extractContent helper added)"
    fi
else
    warn "openai-to-cli.js not found at expected path; skipping array-content patch"
fi

# -------- patch claude-max-api-proxy subprocess manager (silence debug noise)
# The shipped manager.js logs `[Subprocess] Received N bytes of stdout` for
# every chunk streamed back from the claude CLI. On a busy host this dominates
# the err log (millions of lines, tens of MB). Gate it (and the spawn/close
# debug lines) behind OPENCLAW_BRIDGE_DEBUG=1.

MANAGER_FILE="$PROXY_ROOT/dist/subprocess/manager.js"

if [ -f "$MANAGER_FILE" ]; then
    if grep -q "@openclaw-bridge:silent-debug v1" "$MANAGER_FILE"; then
        ok "subprocess manager already patched (silent-debug v1 present)"
    else
        info "patching subprocess manager (silence per-chunk debug logging)"
        cp -a "$MANAGER_FILE" "${MANAGER_FILE}.bak.$(date +%s)"
        node -e '
const fs = require("fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
const marker = "// @openclaw-bridge:silent-debug v1";
if (s.includes(marker)) process.exit(0);
const guard = "if (process.env.OPENCLAW_BRIDGE_DEBUG === \"1\") ";
s = s.replace(
  "console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);",
  guard + "console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);"
);
s = s.replace(
  "console.error(`[Subprocess] Received ${data.length} bytes of stdout`);",
  guard + "console.error(`[Subprocess] Received ${data.length} bytes of stdout`);"
);
s = s.replace(
  "console.error(`[Subprocess] Process closed with code: ${code}`);",
  guard + "console.error(`[Subprocess] Process closed with code: ${code}`);"
);
s = "// @openclaw-bridge:silent-debug v1\n" + s;
fs.writeFileSync(p, s);
' "$MANAGER_FILE"
        ok "subprocess manager patched (silent-debug v1)"
    fi
else
    warn "subprocess manager.js not found at expected path; skipping silent-debug patch"
fi

# -------- patch claude-max-api-proxy subprocess manager (strip null bytes)
# Some plugin-supplied system prompts can contain embedded NULs which crash
# spawn() with ERR_INVALID_ARG_VALUE: "must be a string without null bytes".
# Defensive fix: scrub NUL bytes from prompt + systemPrompt at the entry of
# buildArgsImpl. Marker: @openclaw-bridge:strip-null-bytes v1

if [ -f "$MANAGER_FILE" ]; then
    if grep -q "@openclaw-bridge:strip-null-bytes v1" "$MANAGER_FILE"; then
        ok "subprocess manager already patched (strip-null-bytes v1 present)"
    else
        info "patching subprocess manager (strip null bytes from prompt/systemPrompt)"
        cp -a "$MANAGER_FILE" "${MANAGER_FILE}.bak.$(date +%s)"
        node -e '
const fs = require("fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
const marker = "// @openclaw-bridge:strip-null-bytes v1";
if (s.includes(marker)) process.exit(0);
const inject = "    // @openclaw-bridge:strip-null-bytes v1\n" +
               "    if (typeof prompt === \"string\" && prompt.indexOf(\"\\u0000\") !== -1) prompt = prompt.replace(/\\u0000/g, \"\");\n" +
               "    if (options && typeof options.systemPrompt === \"string\" && options.systemPrompt.indexOf(\"\\u0000\") !== -1) options = { ...options, systemPrompt: options.systemPrompt.replace(/\\u0000/g, \"\") };\n";
s = s.replace(
  "function buildArgsImpl(prompt, options) {\n",
  "function buildArgsImpl(prompt, options) {\n" + inject
);
fs.writeFileSync(p, s);
' "$MANAGER_FILE"
        ok "subprocess manager patched (strip-null-bytes v1)"
    fi
fi

# -------- backup openclaw.json -------------------------------------------

info 'Backing up OpenClaw config'

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="${OPENCLAW_CFG}.bak.${STAMP}"
cp -a "$OPENCLAW_CFG" "$BACKUP_PATH"
ok "backup: $BACKUP_PATH"

# -------- patch openclaw.json --------------------------------------------

info 'Patching openclaw.json (idempotent)'

if ! "$NODE_BIN" "$PATCH_SCRIPT" "$OPENCLAW_CFG"; then
    err 'JSON patcher reported an error. Restoring backup.'
    cp -a "$BACKUP_PATH" "$OPENCLAW_CFG"
    fatal 'aborted; original openclaw.json restored from backup.'
fi

# -------- write systemd units --------------------------------------------

info 'Writing systemd user units'

USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "$USER_SYSTEMD_DIR"

PROXY_UNIT_PATH="${USER_SYSTEMD_DIR}/claude-max-api-proxy.service"

# Substitute placeholders in the proxy unit template.
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT

sed \
    -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
    -e "s|{{PROXY_ENTRY}}|${PROXY_ENTRY}|g" \
    -e "s|{{USER_HOME}}|${USER_HOME}|g" \
    -e "s|{{USER}}|${USER_NAME}|g" \
    -e "s|{{PATH}}|${DETECTED_PATH}|g" \
    "$TEMPLATE_PROXY_UNIT" > "$TMP_UNIT"

install -m 0644 "$TMP_UNIT" "$PROXY_UNIT_PATH"
ok "wrote $PROXY_UNIT_PATH"

# Drop-in for the openclaw gateway (does not modify the upstream unit).
GATEWAY_OVERRIDE_DIR="${USER_SYSTEMD_DIR}/openclaw-gateway.service.d"
GATEWAY_OVERRIDE_PATH="${GATEWAY_OVERRIDE_DIR}/99-local-bridge.conf"
mkdir -p "$GATEWAY_OVERRIDE_DIR"
install -m 0644 "$TEMPLATE_OVERRIDE" "$GATEWAY_OVERRIDE_PATH"
ok "wrote $GATEWAY_OVERRIDE_PATH"

# -------- reload + enable + start ----------------------------------------

info 'Reloading systemd user daemon'
systemctl --user daemon-reload
ok 'daemon-reload done'

info 'Enabling and starting claude-max-api-proxy.service'
systemctl --user enable --now claude-max-api-proxy.service
ok 'claude-max-api-proxy.service is enabled and started'

# Give the proxy a moment to bind before we verify.
sleep 1

if systemctl --user list-unit-files openclaw-gateway.service 2>/dev/null | grep -q '^openclaw-gateway.service'; then
    info 'Restarting openclaw-gateway.service so it picks up the drop-in'
    if systemctl --user restart openclaw-gateway.service; then
        ok 'openclaw-gateway.service restarted'
    else
        warn 'openclaw-gateway.service restart failed; check: systemctl --user status openclaw-gateway.service'
    fi
else
    warn 'openclaw-gateway.service is not installed on this machine; drop-in will apply once it is.'
fi

# -------- verify ---------------------------------------------------------

info 'Running verification'
if ! bash "$VERIFY_SCRIPT"; then
    err 'verification failed. See docs/TROUBLESHOOTING.md'
    exit 1
fi

# -------- final message --------------------------------------------------

printf '\n'
printf '%b+---------------------------------------------------------------+%b\n' "$GREEN" "$RESET"
printf '%b|                     install complete                           |%b\n' "$GREEN" "$RESET"
printf '%b+---------------------------------------------------------------+%b\n' "$GREEN" "$RESET"
printf '\n'
printf '  %bClaude CLI%b         %s\n' "$BOLD" "$RESET" "$CLAUDE_VERSION"
printf '  %bProxy URL%b          http://localhost:3457/v1\n' "$BOLD" "$RESET"
printf '  %bProxy unit%b         %s\n' "$BOLD" "$RESET" "$PROXY_UNIT_PATH"
printf '  %bGateway drop-in%b    %s\n' "$BOLD" "$RESET" "$GATEWAY_OVERRIDE_PATH"
printf '  %bConfig backup%b      %s\n' "$BOLD" "$RESET" "$BACKUP_PATH"
printf '\n'
printf '  %bDocs%b               %s\n' "$BOLD" "$RESET" 'docs/HOW-IT-WORKS.md'
printf '  %bTroubleshooting%b    %s\n' "$BOLD" "$RESET" 'docs/TROUBLESHOOTING.md'
printf '  %bUninstall%b          %s\n' "$BOLD" "$RESET" 'bash uninstall.sh'
printf '\n'
printf '%b!  half-life warning%b\n' "$YELLOW" "$RESET"
printf '%b   This tool depends on the current behavior of the Claude Code CLI%b\n' "$YELLOW" "$RESET"
printf '%b   and the claude-max-api-proxy package. Both can change in any%b\n' "$YELLOW" "$RESET"
printf '%b   release. Pin your Claude CLI version (claude --version) and test%b\n' "$YELLOW" "$RESET"
printf '%b   after upgrades. This is a community tool, not endorsed by%b\n' "$YELLOW" "$RESET"
printf '%b   Anthropic or OpenClaw.%b\n' "$YELLOW" "$RESET"
printf '\n'
