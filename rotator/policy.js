const INFLIGHT_STALE_MS = 5 * 60 * 1000;
const RL_STREAK_RESET_MS = 30 * 60 * 1000;
const RL_MAX_COOLDOWN_S = 3600;

let _rng = Math.random;
export function _setRngForTests(fn) { _rng = fn; }

function now() { return Date.now(); }

function healAccount(state, label) {
  const a = state.accounts[label];
  if (!a) return;
  if (a.inflight > 0 && a.lastCheckedAt && (now() - a.lastCheckedAt) > INFLIGHT_STALE_MS) {
    a.inflight = 0;
  }
  if (a.rateLimitStreak > 0 && a.lastReleasedAt && (now() - a.lastReleasedAt) > RL_STREAK_RESET_MS) {
    a.rateLimitStreak = 0;
  }
}

function isHealthy(state, label) {
  healAccount(state, label);
  const a = state.accounts[label];
  if (!a) return false;
  return a.cooling_until <= now();
}

function healthyAccounts(registry, state) {
  const out = [];
  for (const acc of registry.accounts) {
    if (!state.accounts[acc.label]) continue;
    if (isHealthy(state, acc.label)) out.push(acc);
  }
  return out;
}

export function pickMain(registry, state) {
  const healthy = healthyAccounts(registry, state);
  if (healthy.length === 0) return null;

  const last = state.lastMainLabel;
  if (last && healthy.find(a => a.label === last)) {
    healAccount(state, last);
    if ((state.accounts[last].inflight || 0) === 0) {
      return healthy.find(a => a.label === last);
    }
  }

  // Pick lowest inflight; tiebreak by oldest lastPickedAt
  healthy.sort((a, b) => {
    const ai = state.accounts[a.label].inflight;
    const bi = state.accounts[b.label].inflight;
    if (ai !== bi) return ai - bi;
    return state.accounts[a.label].lastPickedAt - state.accounts[b.label].lastPickedAt;
  });
  return healthy[0];
}

export function pickHeartbeat(registry, state) {
  const healthy = healthyAccounts(registry, state);
  if (healthy.length === 0) return null;
  const i = Math.floor(_rng() * healthy.length);
  return healthy[Math.min(i, healthy.length - 1)];
}

export function markChecked(state, label) {
  const a = state.accounts[label];
  if (!a) return;
  a.inflight = (a.inflight || 0) + 1;
  const t = now();
  a.lastCheckedAt = t;
  a.lastPickedAt = t;
}

export function markReleased(state, label, outcome, cooldowns) {
  const a = state.accounts[label];
  if (!a) return;
  a.inflight = Math.max(0, (a.inflight || 0) - 1);
  a.lastReleasedAt = now();
  a.counters = a.counters || { ok: 0, rate_limit: 0, usage_limit: 0, auth: 0, other: 0 };
  a.counters[outcome] = (a.counters[outcome] || 0) + 1;

  if (outcome === "ok") {
    a.cooling_until = 0;
    a.rateLimitStreak = 0;
    return;
  }
  if (outcome === "rate_limit") {
    a.rateLimitStreak = (a.rateLimitStreak || 0) + 1;
    const secs = Math.min(RL_MAX_COOLDOWN_S, (cooldowns.rate_limit || 60) * Math.pow(2, a.rateLimitStreak - 1));
    a.cooling_until = now() + secs * 1000;
    return;
  }
  if (outcome === "auth") {
    a.cooling_until = (cooldowns.auth === -1) ? Number.MAX_SAFE_INTEGER : now() + cooldowns.auth * 1000;
    return;
  }
  // usage_limit | other
  const secs = cooldowns[outcome] ?? 30;
  a.cooling_until = secs === -1 ? Number.MAX_SAFE_INTEGER : now() + secs * 1000;
}
