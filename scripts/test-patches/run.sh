#!/usr/bin/env bash
# Test harness for install.sh patches.
# Copies the upstream proxy files to a tempdir, runs each patch's Node block
# against them, asserts markers are present and re-runs are idempotent, then
# loads the patched routes.js into a smoke harness.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROXY_ROOT="${OPENCLAW_BRIDGE_PROXY_ROOT:-/opt/homebrew/lib/node_modules/claude-max-api-proxy}"

if [ ! -d "$PROXY_ROOT/dist" ]; then
    echo "FAIL: proxy not found at $PROXY_ROOT (override with OPENCLAW_BRIDGE_PROXY_ROOT)" >&2
    exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bridge-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/dist/server" "$TMP/dist/subprocess" "$TMP/dist/adapter" "$TMP/dist/types"
cp -a "$PROXY_ROOT/dist/server/routes.js" "$TMP/dist/server/routes.js"
cp -a "$PROXY_ROOT/dist/subprocess/manager.js" "$TMP/dist/subprocess/manager.js"
cp -a "$PROXY_ROOT/dist/adapter/openai-to-cli.js" "$TMP/dist/adapter/openai-to-cli.js"
cp -a "$PROXY_ROOT/dist/adapter/cli-to-openai.js" "$TMP/dist/adapter/cli-to-openai.js"
cp -a "$PROXY_ROOT/dist/types/"*.js "$TMP/dist/types/" 2>/dev/null || true

# Symlink the proxy's node_modules so the patched routes.js can resolve
# its imports (uuid, etc.) when loaded by the smoke harness.
if [ -d "$PROXY_ROOT/node_modules" ]; then
    ln -s "$PROXY_ROOT/node_modules" "$TMP/node_modules"
fi
# Mark the tempdir as ESM so routes.js (which uses `import`) loads correctly.
echo '{"type":"module"}' > "$TMP/package.json"

ROUTES_FILE="$TMP/dist/server/routes.js"

PATCHES_SH="$TMP/_patches.sh"
"$REPO_ROOT/scripts/test-patches/_extract-patches.sh" "$REPO_ROOT/install.sh" > "$PATCHES_SH"
# shellcheck disable=SC1090
source "$PATCHES_SH"

echo "== applying patches (first pass) =="
apply_concurrency_cap "$ROUTES_FILE"
apply_session_serialize "$ROUTES_FILE"
apply_stream_safety "$ROUTES_FILE"

for marker in '@openclaw-bridge:concurrency-cap v1' '@openclaw-bridge:session-serialize v1' '@openclaw-bridge:stream-safety v1'; do
    grep -q "$marker" "$ROUTES_FILE" || { echo "FAIL: marker missing after first pass: $marker" >&2; exit 1; }
done
echo "  ok all three markers present"

echo "== applying patches (second pass for idempotency) =="
HASH_BEFORE="$(shasum "$ROUTES_FILE" | awk '{print $1}')"
apply_concurrency_cap "$ROUTES_FILE"
apply_session_serialize "$ROUTES_FILE"
apply_stream_safety "$ROUTES_FILE"
HASH_AFTER="$(shasum "$ROUTES_FILE" | awk '{print $1}')"
[ "$HASH_BEFORE" = "$HASH_AFTER" ] || { echo "FAIL: second pass changed file (not idempotent)" >&2; exit 1; }
echo "  ok second pass is a no-op"

echo "== node --check =="
node --check "$ROUTES_FILE"
echo "  ok routes.js parses"

echo "== smoke =="
node "$REPO_ROOT/scripts/test-patches/smoke.mjs" "$TMP"

echo
echo "all tests passed"
