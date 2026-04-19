#!/usr/bin/env bash
# Smoke test: runs each patcher against copies of the fixtures in a tmpdir,
# asserts expected diffs, and re-runs to verify idempotence. No network,
# no launchd, no npm. Safe to run anywhere Node ≥ 20 is installed.
#
# Exit code = number of failed assertions.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

FIXTURES="$HERE/fixtures"
TMP="$(mktemp -d -t openclaw-bridge-smoke.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

FAILS=0
PASSES=0

pass() { printf '  PASS  %s\n' "$1"; PASSES=$((PASSES + 1)); }
fail() { printf '  FAIL  %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

assert_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then pass "$label"; else fail "$label (expected to find: $needle)"; fi
}

assert_not_contains() {
  local label="$1" file="$2" needle="$3"
  if ! grep -qF -- "$needle" "$file"; then pass "$label"; else fail "$label (expected NOT to find: $needle)"; fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected=$expected, actual=$actual)"; fi
}

echo "Smoke test — tmpdir: $TMP"
echo

# ---------------------------------------------------------------------------
# 1) patch-adapter.mjs
# ---------------------------------------------------------------------------
echo "[1/4] patch-adapter.mjs"
cp "$FIXTURES/openai-to-cli.js" "$TMP/adapter.js"
node "$REPO/scripts/patch-adapter.mjs" "$TMP/adapter.js" >/dev/null

assert_contains "adapter: sentinel present"          "$TMP/adapter.js" "@openclaw-bridge:extractContent v1"
assert_contains "adapter: helper body present"       "$TMP/adapter.js" "function extractContent(c)"
assert_contains "adapter: system rewrite applied"    "$TMP/adapter.js" '<system>\n${extractContent(msg.content)}\n</system>\n'
assert_contains "adapter: user rewrite applied"      "$TMP/adapter.js" "parts.push(extractContent(msg.content))"
assert_contains "adapter: prev rewrite applied"      "$TMP/adapter.js" '<previous_response>\n${extractContent(msg.content)}\n</previous_response>\n'
assert_not_contains "adapter: old system untouched"  "$TMP/adapter.js" '<system>\n${msg.content}\n</system>\n'
assert_not_contains "adapter: old user untouched"    "$TMP/adapter.js" "parts.push(msg.content)"

# Syntactic validity of emitted JS — catches the \n escape trap.
if node --check "$TMP/adapter.js" >/dev/null 2>&1; then
  pass "adapter: node --check passes"
else
  fail "adapter: node --check failed (likely \\n escape regression)"
fi

# Idempotency
before="$(shasum "$TMP/adapter.js" | awk '{print $1}')"
node "$REPO/scripts/patch-adapter.mjs" "$TMP/adapter.js" >/dev/null
after="$(shasum "$TMP/adapter.js" | awk '{print $1}')"
assert_eq "adapter: idempotent second run" "$before" "$after"
echo

# ---------------------------------------------------------------------------
# 2) patch-openclaw-config.mjs
# ---------------------------------------------------------------------------
echo "[2/4] patch-openclaw-config.mjs"
cp "$FIXTURES/openclaw.min.json" "$TMP/openclaw.json"
node "$REPO/scripts/patch-openclaw-config.mjs" "$TMP/openclaw.json" 3456 >/dev/null

node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const fails = [];
  const pass = (m) => process.stdout.write("  PASS  " + m + "\n");
  const fail = (m) => { process.stderr.write("  FAIL  " + m + "\n"); fails.push(m); };

  // Openai provider patched
  const oai = c?.models?.providers?.openai;
  if (oai?.baseUrl === "http://localhost:3456/v1") pass("openclaw: baseUrl set"); else fail("openclaw: baseUrl missing/wrong");
  if (oai?.api === "openai-completions")           pass("openclaw: api set");     else fail("openclaw: api missing/wrong");
  if (oai?.apiKey === "claude-code-local")         pass("openclaw: apiKey set");  else fail("openclaw: apiKey missing/wrong");

  const ids = (oai?.models || []).map(m => m.id);
  for (const want of ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"]) {
    if (ids.includes(want)) pass("openclaw: models contains " + want);
    else fail("openclaw: models missing " + want);
  }

  // Aliases
  const a = c?.agents?.defaults?.models;
  if (a?.["openai/claude-opus-4"]?.alias === "Opus")     pass("openclaw: Opus alias set");   else fail("openclaw: Opus alias missing");
  if (a?.["openai/claude-sonnet-4"]?.alias === "Sonnet") pass("openclaw: Sonnet alias set"); else fail("openclaw: Sonnet alias missing");

  // Other keys preserved — crucial merge-safety assertion.
  if (c.models.providers.ollama)                        pass("openclaw: ollama provider preserved");     else fail("openclaw: ollama provider lost");
  if (c._note && c._note.startsWith("FIXTURE ONLY"))     pass("openclaw: _note marker preserved");        else fail("openclaw: _note marker lost");
  if (c.agents?.defaults?.primary === "ollama/gemma4:e4b") pass("openclaw: primary model preserved");    else fail("openclaw: primary model lost");
  if (c.agents?.defaults?.heartbeat?.model === "ollama/gemma4:e4b") pass("openclaw: heartbeat preserved"); else fail("openclaw: heartbeat lost");
  if (c.env?.dummy_token === "sk-test-0000-not-a-real-key") pass("openclaw: env block preserved");       else fail("openclaw: env block lost");
  if (c.meta?.source === "fixture")                     pass("openclaw: meta block preserved");          else fail("openclaw: meta block lost");

  process.exit(fails.length);
' "$TMP/openclaw.json" || FAILS=$((FAILS + $?))

# Idempotency
before="$(shasum "$TMP/openclaw.json" | awk '{print $1}')"
node "$REPO/scripts/patch-openclaw-config.mjs" "$TMP/openclaw.json" 3456 >/dev/null
after="$(shasum "$TMP/openclaw.json" | awk '{print $1}')"
assert_eq "openclaw: idempotent second run" "$before" "$after"
echo

# ---------------------------------------------------------------------------
# 3) patch-gateway-plist.mjs
# ---------------------------------------------------------------------------
echo "[3/4] patch-gateway-plist.mjs"
cp "$FIXTURES/ai.openclaw.gateway.plist" "$TMP/gateway.plist"
node "$REPO/scripts/patch-gateway-plist.mjs" "$TMP/gateway.plist" >/dev/null

current="$(plutil -extract EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT raw "$TMP/gateway.plist" 2>/dev/null || echo '<missing>')"
assert_eq "gateway: CLAUDE_CODE_ENTRYPOINT=cli" "cli" "$current"

# Preserve other keys.
home_val="$(plutil -extract EnvironmentVariables.HOME raw "$TMP/gateway.plist" 2>/dev/null || echo '<missing>')"
assert_eq "gateway: HOME preserved" "/tmp" "$home_val"

# Idempotency: a byte-for-byte second run should produce no change on disk
# (plutil may re-pretty-print, but the key=value we care about is unchanged).
node "$REPO/scripts/patch-gateway-plist.mjs" "$TMP/gateway.plist" >/dev/null
current2="$(plutil -extract EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT raw "$TMP/gateway.plist" 2>/dev/null)"
assert_eq "gateway: idempotent value still cli" "cli" "$current2"

# Missing-file behavior: should exit 0 and print a friendly message.
if node "$REPO/scripts/patch-gateway-plist.mjs" "$TMP/definitely-does-not-exist.plist" >/dev/null 2>&1; then
  pass "gateway: missing plist is a no-op (exit 0)"
else
  fail "gateway: missing plist should be a no-op but exited nonzero"
fi
echo

# ---------------------------------------------------------------------------
# 4) render-proxy-plist.mjs
# ---------------------------------------------------------------------------
echo "[4/4] render-proxy-plist.mjs"
node "$REPO/scripts/render-proxy-plist.mjs" \
  --template  "$REPO/templates/ai.claude-max-api-proxy.plist.tmpl" \
  --home      "/tmp/fakehome" \
  --node      "/usr/local/bin/node" \
  --proxy-home "/tmp/fakehome/.openclaw/bridge/claude-max-api-proxy" \
  --port      "3456" \
  --path      "/usr/local/bin:/usr/bin:/bin" \
  > "$TMP/rendered.plist"

assert_contains "proxy plist: Label set"         "$TMP/rendered.plist" "<string>ai.claude-max-api-proxy</string>"
assert_contains "proxy plist: PORT substituted"  "$TMP/rendered.plist" "<string>3456</string>"
assert_contains "proxy plist: NODE substituted"  "$TMP/rendered.plist" "<string>/usr/local/bin/node</string>"
assert_contains "proxy plist: HOME substituted"  "$TMP/rendered.plist" "<string>/tmp/fakehome</string>"
assert_contains "proxy plist: PATH substituted"  "$TMP/rendered.plist" "<string>/usr/local/bin:/usr/bin:/bin</string>"
assert_not_contains "proxy plist: no leftover placeholders" "$TMP/rendered.plist" "{{"

# plutil accepts the rendered file.
if plutil -lint "$TMP/rendered.plist" >/dev/null 2>&1; then
  pass "proxy plist: plutil -lint passes"
else
  fail "proxy plist: plutil -lint failed"
fi

# XML-escape safety check: home dir with an ampersand must not break plist.
node "$REPO/scripts/render-proxy-plist.mjs" \
  --template  "$REPO/templates/ai.claude-max-api-proxy.plist.tmpl" \
  --home      "/tmp/A&B" \
  --node      "/usr/local/bin/node" \
  --proxy-home "/tmp/A&B/.openclaw/bridge/claude-max-api-proxy" \
  --port      "3456" \
  --path      "/usr/local/bin" \
  > "$TMP/rendered-amp.plist"
if plutil -lint "$TMP/rendered-amp.plist" >/dev/null 2>&1; then
  pass "proxy plist: XML-escapes ampersand in paths"
else
  fail "proxy plist: ampersand in HOME broke rendered plist"
fi
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "----"
echo "Smoke result: $PASSES passed, $FAILS failed"
exit "$FAILS"
