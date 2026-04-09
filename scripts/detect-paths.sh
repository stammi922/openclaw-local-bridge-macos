#!/usr/bin/env bash
# detect-paths.sh
#
# Detects the Claude CLI, Node, and claude-max-api-proxy paths on the current
# system. Prints a set of KEY=VALUE lines (shell-eval friendly) and exits 0,
# or exits non-zero with a clear error message on stderr if something is
# missing.
#
# Usage:
#     eval "$(scripts/detect-paths.sh)"
#
# Output variables:
#     CLAUDE_BIN          absolute path to claude CLI
#     CLAUDE_VERSION      output of `claude --version` (best effort)
#     NODE_BIN            absolute path to node
#     NPM_BIN             absolute path to npm
#     USER_HOME           $HOME
#     USER_NAME           $USER (or id -un fallback)
#     NPM_GLOBAL_ROOT     output of `npm root -g`
#     PROXY_ENTRY         absolute path to claude-max-api-proxy standalone.js
#     PROXY_INSTALLED     1 if the proxy is already installed, 0 otherwise
#     DETECTED_PATH       a clean PATH that should reach claude + node

set -euo pipefail

err() {
    printf 'detect-paths: %s\n' "$*" >&2
}

require_cmd() {
    local name="$1"
    local hint="$2"
    if ! command -v "$name" >/dev/null 2>&1; then
        err "'$name' not found in PATH. $hint"
        exit 1
    fi
    command -v "$name"
}

CLAUDE_BIN="$(require_cmd claude 'Install Claude Code CLI from https://docs.anthropic.com/claude/docs/claude-code')"
NODE_BIN="$(require_cmd node 'Install Node.js 18+ (https://nodejs.org/).')"
NPM_BIN="$(require_cmd npm 'npm should ship with Node.js. Re-install Node.js if missing.')"

CLAUDE_VERSION="$("$CLAUDE_BIN" --version 2>/dev/null || echo 'unknown')"

USER_HOME="${HOME:?HOME must be set}"
USER_NAME="${USER:-$(id -un)}"

NPM_GLOBAL_ROOT="$("$NPM_BIN" root -g 2>/dev/null || true)"
if [ -z "${NPM_GLOBAL_ROOT}" ]; then
    err 'Cannot determine npm global root. Is npm configured correctly?'
    exit 1
fi

PROXY_ENTRY=""
PROXY_INSTALLED=0
CANDIDATE="${NPM_GLOBAL_ROOT}/claude-max-api-proxy/dist/server/standalone.js"
if [ -f "$CANDIDATE" ]; then
    PROXY_ENTRY="$CANDIDATE"
    PROXY_INSTALLED=1
fi

# Build a reasonable PATH for the systemd unit: prepend the dirs that own
# claude and node, then merge the user's current PATH.
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"
NODE_DIR="$(dirname "$NODE_BIN")"

DETECTED_PATH="${NODE_DIR}:${CLAUDE_DIR}:${USER_HOME}/.local/bin:${USER_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

# Emit shell-eval friendly output.
printf 'CLAUDE_BIN=%q\n'       "$CLAUDE_BIN"
printf 'CLAUDE_VERSION=%q\n'   "$CLAUDE_VERSION"
printf 'NODE_BIN=%q\n'         "$NODE_BIN"
printf 'NPM_BIN=%q\n'          "$NPM_BIN"
printf 'USER_HOME=%q\n'        "$USER_HOME"
printf 'USER_NAME=%q\n'        "$USER_NAME"
printf 'NPM_GLOBAL_ROOT=%q\n'  "$NPM_GLOBAL_ROOT"
printf 'PROXY_ENTRY=%q\n'      "$PROXY_ENTRY"
printf 'PROXY_INSTALLED=%q\n'  "$PROXY_INSTALLED"
printf 'DETECTED_PATH=%q\n'    "$DETECTED_PATH"
