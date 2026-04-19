# shellcheck shell=bash
# Preflight checks. Each function dies with a clear remediation hint on hard
# failures; warns and returns nonzero on soft failures (caller decides).

require_macos() {
  [[ "$(uname)" == "Darwin" ]] || die "This installer is macOS-only. For Linux, see https://github.com/ulmeanuadrian/openclaw-local-bridge."
  local major
  major="$(sw_vers -productVersion | cut -d. -f1)"
  if (( major < 12 )); then
    die "macOS 12 (Monterey) or newer required. Detected: $(sw_vers -productVersion)."
  fi
  ok "macOS $(sw_vers -productVersion) detected."
}

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Required command not found: $c. Install it and re-run."
  done
}

require_node() {
  require_cmd node npm
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 20 )); then
    die "Node.js 20 or newer required. Detected: $(node --version). Install via brew install node@22 or nvm install 22."
  fi
  ok "Node $(node --version) detected (npm $(npm --version))."
}

require_openclaw() {
  require_cmd openclaw
  local ver
  ver="$(openclaw --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -z "$ver" ]]; then
    die "Could not determine openclaw version (openclaw --version returned no recognizable version string)."
  fi
  # Compare ver against 2026.4.15 lexicographically — works because format is fixed CalVer width.
  local min="2026.4.15"
  # Use sort -V for proper version comparison.
  if [[ "$(printf '%s\n%s\n' "$min" "$ver" | sort -V | head -1)" != "$min" ]]; then
    die "openclaw $min or newer required. Detected: $ver. Update via npm i -g openclaw."
  fi
  ok "openclaw $ver detected."
}

warn_claude_cli() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found in PATH. The bridge needs it to forward requests. Install Claude Code: https://claude.com/claude-code"
    return 1
  fi
  local ver
  ver="$(claude --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -z "$ver" ]]; then
    warn "Could not parse claude --version output. Continuing anyway."
    return 0
  fi
  local major="${ver%%.*}"
  if (( major < 2 )); then
    warn "claude CLI 2.x recommended for model alias support. Detected: $ver. Continuing anyway."
    return 0
  fi
  ok "claude CLI $ver detected."
}

require_openclaw_json() {
  if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
    die "$HOME/.openclaw/openclaw.json does not exist. Run 'openclaw setup' first to initialize OpenClaw."
  fi
  ok "Found existing openclaw.json."
}
