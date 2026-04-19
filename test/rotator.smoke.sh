#!/usr/bin/env bash
# Unit-ish smoke tests for the rotator module.
# All tests are pure-Node — no proxy, no launchd, no real claude CLI.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
FIXTURES="$HERE/fixtures"

# shellcheck source=../lib/log.sh
. "$REPO_ROOT/lib/log.sh"

FAILS=0
declare -a RESULTS

record() {
  local verdict="$1"; shift
  local label="$*"
  RESULTS+=("$verdict  $label")
  if [[ "$verdict" == "FAIL" ]]; then FAILS=$((FAILS + 1)); fi
}

run_node() {
  # run_node <label> <inline-script>
  local label="$1"; shift
  local script="$1"; shift
  if out="$(node --input-type=module -e "$script" 2>&1)"; then
    record "PASS" "$label"
  else
    record "FAIL" "$label"
    printf '    %s\n' "$out" | sed 's/^/    /'
  fi
}

ROTATOR_DIR="$REPO_ROOT/rotator"

# ---------- Test 1: detector classifies known strings ----------
run_node "detector: rate_limit pattern" "
import { classifyOutcome } from '$ROTATOR_DIR/detector.js';
const got = classifyOutcome(1, 'Error: 429 Too Many Requests — retry-after: 30');
if (got !== 'rate_limit') { console.error('expected rate_limit, got', got); process.exit(1); }
"

run_node "detector: usage_limit pattern" "
import { classifyOutcome } from '$ROTATOR_DIR/detector.js';
const got = classifyOutcome(1, 'You have hit your Claude Max 5-hour usage limit.');
if (got !== 'usage_limit') { console.error('expected usage_limit, got', got); process.exit(1); }
"

run_node "detector: auth pattern" "
import { classifyOutcome } from '$ROTATOR_DIR/detector.js';
const got = classifyOutcome(1, 'Error: 401 unauthorized. Please run claude login.');
if (got !== 'auth') { console.error('expected auth, got', got); process.exit(1); }
"

run_node "detector: ok on exit 0" "
import { classifyOutcome } from '$ROTATOR_DIR/detector.js';
const got = classifyOutcome(0, '');
if (got !== 'ok') { console.error('expected ok, got', got); process.exit(1); }
"

run_node "detector: other fallback" "
import { classifyOutcome } from '$ROTATOR_DIR/detector.js';
const got = classifyOutcome(1, 'some unrelated crash');
if (got !== 'other') { console.error('expected other, got', got); process.exit(1); }
"

# ---------- Test 2: classify request by model ----------
run_node "classify: haiku is heartbeat" "
import { classifyRequest } from '$ROTATOR_DIR/classify.js';
const got = classifyRequest({ model: 'claude-haiku-4' }, { heartbeatModels: ['claude-haiku-4'] });
if (got !== 'heartbeat') { console.error('expected heartbeat'); process.exit(1); }
"

run_node "classify: sonnet is main" "
import { classifyRequest } from '$ROTATOR_DIR/classify.js';
const got = classifyRequest({ model: 'claude-sonnet-4' }, { heartbeatModels: ['claude-haiku-4'] });
if (got !== 'main') { console.error('expected main'); process.exit(1); }
"

run_node "classify: empty heartbeatModels disables" "
import { classifyRequest } from '$ROTATOR_DIR/classify.js';
const got = classifyRequest({ model: 'claude-haiku-4' }, { heartbeatModels: [] });
if (got !== 'main') { console.error('expected main'); process.exit(1); }
"

# ---------- Test 3: policy — pickMain sticky ----------
run_node "policy: pickMain is sticky when last is idle" "
import { pickMain } from '$ROTATOR_DIR/policy.js';
const reg = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/accounts.json','utf8')));
const st  = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/state.healthy.json','utf8')));
st.lastMainLabel = 'bravo';
const got = pickMain(reg, st);
if (!got || got.label !== 'bravo') { console.error('expected bravo, got', got && got.label); process.exit(1); }
"

# ---------- Test 4: policy — spread when last is busy ----------
run_node "policy: pickMain spreads when last is busy" "
import { pickMain } from '$ROTATOR_DIR/policy.js';
const reg = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/accounts.json','utf8')));
const st  = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/state.healthy.json','utf8')));
st.lastMainLabel = 'bravo';
st.accounts.bravo.in_flight = 1; // busy
const got = pickMain(reg, st);
if (!got || got.label === 'bravo') { console.error('expected NOT bravo, got', got && got.label); process.exit(1); }
"

# ---------- Test 5: policy — skips cooling account ----------
run_node "policy: pickMain skips cooling account" "
import { pickMain } from '$ROTATOR_DIR/policy.js';
const reg = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/accounts.json','utf8')));
const st  = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/state.one-cooling.json','utf8')));
const got = pickMain(reg, st, new Date('2026-04-19T10:00:30Z').getTime());
// alpha is cooling until 10:01, bravo is cooling forever, charlie is healthy.
if (!got || got.label !== 'charlie') { console.error('expected charlie, got', got && got.label); process.exit(1); }
"

# ---------- Test 6: policy — null when pool empty ----------
run_node "policy: pickMain returns null with no healthy pool" "
import { pickMain } from '$ROTATOR_DIR/policy.js';
const reg = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/accounts.json','utf8')));
const st  = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/state.one-cooling.json','utf8')));
// Force everyone cooling:
st.accounts.charlie.cooling_until = '9999-12-31T23:59:59Z';
const got = pickMain(reg, st, new Date('2026-04-19T10:00:30Z').getTime());
if (got !== null) { console.error('expected null, got', got && got.label); process.exit(1); }
"

# ---------- Test 7: pickHeartbeat uniform distribution (5k draws) ----------
run_node "policy: pickHeartbeat is roughly uniform over healthy pool" "
import { pickHeartbeat } from '$ROTATOR_DIR/policy.js';
const reg = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/accounts.json','utf8')));
const st  = JSON.parse(await import('node:fs').then(m => m.readFileSync('$FIXTURES/state.healthy.json','utf8')));
const N = 5000;
const counts = { alpha: 0, bravo: 0, charlie: 0 };
for (let i = 0; i < N; i++) {
  const pick = pickHeartbeat(reg, st);
  counts[pick.label]++;
}
const expected = N / 3;
const tol = expected * 0.15; // 15% deviation tolerance on 5k draws
for (const [k, v] of Object.entries(counts)) {
  if (Math.abs(v - expected) > tol) {
    console.error('account', k, 'got', v, 'expected~', expected, '±', tol);
    process.exit(1);
  }
}
"

# ---------- Test 8: markChecked/markReleased cooldown math ----------
run_node "policy: markReleased on rate_limit sets ~60s cooldown" "
import { markReleased, healthyAccounts } from '$ROTATOR_DIR/policy.js';
const state = { lastMainLabel: null, accounts: {} };
const cooldowns = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
const now = new Date('2026-04-19T12:00:00Z').getTime();
markReleased(state, 'alpha', 'rate_limit', cooldowns, now);
const until = new Date(state.accounts.alpha.cooling_until).getTime();
const delta = (until - now) / 1000;
if (Math.abs(delta - 60) > 1) { console.error('expected ~60s cooldown, got', delta); process.exit(1); }
"

run_node "policy: markReleased on auth sets infinite cooldown" "
import { markReleased } from '$ROTATOR_DIR/policy.js';
const state = { lastMainLabel: null, accounts: {} };
const cooldowns = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
markReleased(state, 'alpha', 'auth', cooldowns);
if (state.accounts.alpha.cooling_until !== '9999-12-31T23:59:59Z') {
  console.error('expected far-future cooldown, got', state.accounts.alpha.cooling_until); process.exit(1);
}
"

# ---------- Test 9: prepare() single-mode is a no-op ----------
run_node "index: prepare returns empty env in single mode" "
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rotator-test-'));
process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR = tmp;
process.env.OPENCLAW_BRIDGE_ROTATOR_CONFIG = path.join(tmp, 'no-such-config.json');
process.env.OPENCLAW_BRIDGE_ROTATOR_LOG = path.join(tmp, 'rotator.log');
fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ mode: 'single', accounts: [] }));
const { prepare, refresh } = await import('$ROTATOR_DIR/index.js');
refresh();
const ctx = await prepare({ model: 'claude-sonnet-4' });
if (ctx.kind !== 'single') { console.error('expected kind=single, got', ctx.kind); process.exit(1); }
if (ctx.label !== null) { console.error('expected label=null, got', ctx.label); process.exit(1); }
if (Object.keys(ctx.env).length !== 0) { console.error('expected empty env'); process.exit(1); }
"

# ---------- Test 10: prepare() multi-mode sets CLAUDE_CONFIG_DIR ----------
run_node "index: prepare in multi mode sets CLAUDE_CONFIG_DIR" "
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rotator-test-'));
process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR = tmp;
process.env.OPENCLAW_BRIDGE_ROTATOR_CONFIG = path.join(tmp, 'no-such-config.json');
process.env.OPENCLAW_BRIDGE_ROTATOR_LOG = path.join(tmp, 'rotator.log');
fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({
  mode: 'multi',
  accounts: [{ label: 'a1', configDir: '/tmp/fake-a1' }, { label: 'a2', configDir: '/tmp/fake-a2' }]
}));
const { prepare, refresh, complete } = await import('$ROTATOR_DIR/index.js');
refresh();
const ctx = await prepare({ model: 'claude-sonnet-4' });
if (!ctx.label) { console.error('expected a label'); process.exit(1); }
if (!ctx.env.CLAUDE_CONFIG_DIR) { console.error('expected CLAUDE_CONFIG_DIR in env'); process.exit(1); }
if (!ctx.env.CLAUDE_CONFIG_DIR.includes('fake-')) { console.error('unexpected CLAUDE_CONFIG_DIR', ctx.env.CLAUDE_CONFIG_DIR); process.exit(1); }
await complete(ctx, { exitCode: 0, stderrTail: '' });
"

# ---------- Print results ----------
echo
echo "Rotator smoke test results:"
for r in "${RESULTS[@]}"; do
  case "$r" in
    PASS*) printf '  %s\n' "$r" ;;
    FAIL*) printf '  %s\n' "$r" >&2 ;;
  esac
done
echo

if (( FAILS == 0 )); then
  ok "All rotator smoke tests passed (${#RESULTS[@]} checks)."
else
  err "$FAILS rotator smoke check(s) failed."
fi
exit "$FAILS"
