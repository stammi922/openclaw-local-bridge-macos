# shellcheck shell=bash
# Dynamic path resolution. No hardcoded /opt/homebrew or /Users paths.

get_node_bin()      { command -v node; }
get_npm_bin()       { command -v npm; }
get_claude_bin()    { command -v claude || true; }
get_openclaw_bin()  { command -v openclaw; }

proxy_plist_path()    { echo "$HOME/Library/LaunchAgents/ai.claude-max-api-proxy.plist"; }
gateway_plist_path()  { echo "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"; }
proxy_install_dir()   { echo "$HOME/.openclaw/bridge/claude-max-api-proxy"; }

# Compose a minimal, deduped, launchd-safe PATH for the proxy plist.
# Order: node dir, claude dir, npm-global bin, system dirs. dedupes blanks.
#
# `npm bin -g` was removed in npm 9+ and emits an error on stdout, so we
# derive the global bin from `npm prefix -g` (e.g. /opt/homebrew) and
# append /bin. If npm isn't present or the prefix lookup fails, we skip
# the npm entry entirely — the system dirs below still cover the usual
# install locations.
compose_plist_path() {
  local node_bin claude_bin npm_prefix npm_global_bin=""
  node_bin="$(get_node_bin)"
  claude_bin="$(get_claude_bin)"
  if npm_prefix="$(npm prefix -g 2>/dev/null)" && [[ -n "$npm_prefix" && -d "$npm_prefix/bin" ]]; then
    npm_global_bin="$npm_prefix/bin"
  fi
  local parts=()
  [[ -n "$node_bin"       ]] && parts+=("$(dirname "$node_bin")")
  [[ -n "$claude_bin"     ]] && parts+=("$(dirname "$claude_bin")")
  [[ -n "$npm_global_bin" ]] && parts+=("$npm_global_bin")
  parts+=("/usr/local/bin" "/opt/homebrew/bin" "/usr/bin" "/bin")
  printf '%s\n' "${parts[@]}" | awk 'NF && !seen[$0]++' | paste -sd: -
}
