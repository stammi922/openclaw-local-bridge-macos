#!/usr/bin/env bash
# Rotator smoke test — does NOT require real Claude OAuth.
# Run from repo root: bash test/rotator.smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
PATCHER="$REPO_ROOT/scripts/patch-proxy-rotator.mjs"
FIXTURES="$REPO_ROOT/test/fixtures/rotator"

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "[rotator smoke] building fake proxy tree…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/dist/server" "$TMP/dist/subprocess"
cp "$FIXTURES/routes.pre.js" "$TMP/dist/server/routes.js"
cp "$FIXTURES/manager.pre.js" "$TMP/dist/subprocess/manager.js"

echo "[rotator smoke] dry-run…"
OUT="$(node "$PATCHER" "$TMP" --dry-run)"
[[ "$OUT" == *"WOULD patch"* ]] && pass "dry-run reports plan" || fail "dry-run did not report plan"

echo "[rotator smoke] fresh patch…"
node "$PATCHER" "$TMP" > /dev/null
grep -q "@openclaw-bridge:rotator v1" "$TMP/dist/server/routes.js" && pass "routes.js sentinel present" || fail "routes.js sentinel missing"
grep -q "@openclaw-bridge:rotator v1" "$TMP/dist/subprocess/manager.js" && pass "manager.js sentinel present" || fail "manager.js sentinel missing"
[[ -f "$TMP/dist/rotator/index.js" ]] && pass "rotator/index.js staged" || fail "rotator/index.js missing"

echo "[rotator smoke] byte-identical re-patch…"
SHA1=$(shasum "$TMP/dist/server/routes.js" | awk '{print $1}')
SHA1M=$(shasum "$TMP/dist/subprocess/manager.js" | awk '{print $1}')
node "$PATCHER" "$TMP" > /dev/null
SHA2=$(shasum "$TMP/dist/server/routes.js" | awk '{print $1}')
SHA2M=$(shasum "$TMP/dist/subprocess/manager.js" | awk '{print $1}')
[[ "$SHA1" == "$SHA2" ]] && pass "routes.js byte-identical on re-run" || fail "routes.js changed on re-run"
[[ "$SHA1M" == "$SHA2M" ]] && pass "manager.js byte-identical on re-run" || fail "manager.js changed on re-run"

echo "[rotator smoke] single-mode no-op (in-process)…"
SINGLE_DIR="$(mktemp -d)"
echo '{"mode":"single","accounts":[]}' > "$SINGLE_DIR/accounts.json"
OPENCLAW_BRIDGE_ACCOUNTS_DIR="$SINGLE_DIR" OPENCLAW_BRIDGE_ROTATOR_LOG="$SINGLE_DIR/rotator.log" node -e "
import('$REPO_ROOT/rotator/index.js').then(async (m) => {
  const ctx = await m.prepare({ model: 'claude-sonnet-4' });
  if (Object.keys(ctx.env).length !== 0) { console.error('env not empty'); process.exit(1); }
  if (ctx.label !== null) { console.error('label not null'); process.exit(1); }
  const fs = await import('node:fs');
  if (fs.existsSync('$SINGLE_DIR/state.json')) { console.error('state.json written in single mode'); process.exit(1); }
  process.exit(0);
});
" && pass "single-mode prepare is no-op" || fail "single-mode prepare wrote state or env"

echo "[rotator smoke] multi-mode env injection…"
MULTI_DIR="$(mktemp -d)"
mkdir -p "$MULTI_DIR/accounts/a/config" "$MULTI_DIR/accounts/b/config"
cat >"$MULTI_DIR/accounts.json" <<JSON
{"mode":"multi","accounts":[{"label":"a","configDir":"$MULTI_DIR/accounts/a/config"},{"label":"b","configDir":"$MULTI_DIR/accounts/b/config"}]}
JSON
OPENCLAW_BRIDGE_ACCOUNTS_DIR="$MULTI_DIR" OPENCLAW_BRIDGE_ROTATOR_LOG="$MULTI_DIR/rotator.log" node -e "
import('$REPO_ROOT/rotator/index.js').then(async (m) => {
  const ctx = await m.prepare({ model: 'claude-sonnet-4' });
  if (!ctx.env.CLAUDE_CONFIG_DIR) { console.error('no CLAUDE_CONFIG_DIR'); process.exit(1); }
  if (!ctx.env.CLAUDE_CONFIG_DIR.includes('$MULTI_DIR')) { console.error('wrong dir: ' + ctx.env.CLAUDE_CONFIG_DIR); process.exit(1); }
  process.exit(0);
});
" && pass "multi-mode prepare sets CLAUDE_CONFIG_DIR" || fail "multi-mode env missing"

echo "[rotator smoke] patcher refuses when anchor missing…"
BAD="$(mktemp -d)"
mkdir -p "$BAD/dist/server" "$BAD/dist/subprocess"
echo '// missing anchor' > "$BAD/dist/server/routes.js"
cp "$FIXTURES/manager.pre.js" "$BAD/dist/subprocess/manager.js"
PATCHER_OUT="$(node "$PATCHER" "$BAD" 2>&1 || true)"
if echo "$PATCHER_OUT" | grep -q "anchor"; then pass "patcher rejects missing anchor"
else fail "patcher should have rejected missing anchor"; fi

echo ""
echo "[rotator smoke] $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
