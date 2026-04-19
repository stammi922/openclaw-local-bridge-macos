// Selection strategies.
//
// pickMain:      sticky on last account if idle; otherwise lowest in_flight,
//                LRU tiebreak.
// pickHeartbeat: uniform-random over healthy pool (crypto-random, not Math.random)
//                so the distribution can't be fingerprinted as a deterministic
//                generator.

import crypto from "node:crypto";
import { ensureAccountSlot } from "./pool.js";

export function healthyAccounts(registry, state, now = Date.now()) {
  return registry.accounts.filter((a) => {
    const s = state.accounts[a.label];
    if (!s || !s.cooling_until) return true;
    return new Date(s.cooling_until).getTime() <= now;
  });
}

export function pickMain(registry, state, now = Date.now()) {
  const healthy = healthyAccounts(registry, state, now);
  if (healthy.length === 0) return null;

  const last = state.lastMainLabel;
  if (last) {
    const stickyCandidate = healthy.find((a) => a.label === last);
    if (stickyCandidate) {
      const slot = ensureAccountSlot(state, last);
      if ((slot.in_flight ?? 0) === 0) return stickyCandidate;
    }
  }

  // Spread: lowest in_flight, tiebreak on oldest last_used (LRU), then label.
  let best = null;
  for (const a of healthy) {
    const slot = ensureAccountSlot(state, a.label);
    const inFlight = slot.in_flight ?? 0;
    const lu = slot.last_used ? new Date(slot.last_used).getTime() : 0;
    if (
      !best ||
      inFlight < best.inFlight ||
      (inFlight === best.inFlight && lu < best.lu) ||
      (inFlight === best.inFlight && lu === best.lu && a.label < best.account.label)
    ) {
      best = { account: a, inFlight, lu };
    }
  }
  return best ? best.account : null;
}

export function pickHeartbeat(registry, state, now = Date.now()) {
  const healthy = healthyAccounts(registry, state, now);
  if (healthy.length === 0) return null;
  const idx = crypto.randomInt(0, healthy.length);
  return healthy[idx];
}

export function markChecked(state, label, now = Date.now()) {
  const slot = ensureAccountSlot(state, label);
  slot.in_flight = (slot.in_flight ?? 0) + 1;
  slot.last_used = new Date(now).toISOString();
  return slot;
}

export function markReleased(state, label, outcome, cooldowns, now = Date.now()) {
  const slot = ensureAccountSlot(state, label);
  slot.in_flight = Math.max(0, (slot.in_flight ?? 0) - 1);
  slot.last_outcome = outcome;
  if (!slot.counters) slot.counters = { ok: 0, rate_limit: 0, usage_limit: 0, auth: 0, other: 0 };
  slot.counters[outcome] = (slot.counters[outcome] ?? 0) + 1;
  const seconds = cooldowns[outcome];
  if (outcome === "auth") {
    slot.cooling_until = "9999-12-31T23:59:59Z";
  } else if (typeof seconds === "number" && seconds > 0) {
    slot.cooling_until = new Date(now + seconds * 1000).toISOString();
  } else {
    slot.cooling_until = null;
  }
  return slot;
}
