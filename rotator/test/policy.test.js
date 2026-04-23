import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMain, pickHeartbeat, markChecked, markReleased, _setRngForTests } from "../policy.js";
import { ensureAccountSlot } from "../pool.js";

function mkRegistry(labels) {
  return { mode: "multi", accounts: labels.map(l => ({ label: l, configDir: `/fake/${l}` })) };
}

function mkState(labels, overrides = {}) {
  const s = {
    lastMainLabel: null,
    poolQuietUntil: 0,
    recentOutcomes: [],
    accounts: {},
    ...overrides,
  };
  for (const l of labels) ensureAccountSlot(s, l);
  return s;
}

test("pickMain: sticky reuse when last-picked is healthy AND idle", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 0;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "a");
});

test("pickMain: rotates off sticky when last-picked has inflight > 0", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 1;
  const picked = pickMain(reg, state);
  assert.notEqual(picked.label, "a");
});

test("pickMain: filters cooling accounts", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  state.accounts.b.cooling_until = Date.now() + 60000;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "c");
});

test("pickMain: returns null when no healthy accounts", () => {
  const reg = mkRegistry(["a"]);
  const state = mkState(["a"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  assert.equal(pickMain(reg, state), null);
});

test("pickMain: tiebreak by LRU lastPickedAt (oldest first)", () => {
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  state.accounts.a.lastPickedAt = 3000;
  state.accounts.b.lastPickedAt = 1000; // oldest
  state.accounts.c.lastPickedAt = 2000;
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "b");
});

test("pickHeartbeat: uniform over healthy (seeded)", () => {
  _setRngForTests(() => 0.0);
  const reg = mkRegistry(["a", "b", "c"]);
  const state = mkState(["a", "b", "c"]);
  assert.equal(pickHeartbeat(reg, state).label, "a", "first when rng=0.0");
  _setRngForTests(() => 0.999);
  assert.equal(pickHeartbeat(reg, state).label, "c", "last when rng≈1");
  _setRngForTests(() => 0.5);
  assert.equal(pickHeartbeat(reg, state).label, "b", "middle when rng=0.5");
});

test("pickHeartbeat: filters cooling", () => {
  _setRngForTests(() => 0.0);
  const reg = mkRegistry(["a", "b"]);
  const state = mkState(["a", "b"]);
  state.accounts.a.cooling_until = Date.now() + 60000;
  assert.equal(pickHeartbeat(reg, state).label, "b");
});

test("pickMain: inflight self-heal — stale inflight decays to 0 after 5min", () => {
  const reg = mkRegistry(["a"]);
  const state = mkState(["a"], { lastMainLabel: "a" });
  state.accounts.a.inflight = 5;
  state.accounts.a.lastCheckedAt = Date.now() - 6 * 60 * 1000; // 6min ago
  const picked = pickMain(reg, state);
  assert.equal(picked.label, "a", "should pick despite stale inflight");
  assert.equal(state.accounts.a.inflight, 0, "stale inflight was reset");
});

test("markChecked: increments inflight + updates timestamps", () => {
  const state = mkState(["a"]);
  markChecked(state, "a");
  assert.equal(state.accounts.a.inflight, 1);
  assert.ok(state.accounts.a.lastCheckedAt > 0);
  assert.ok(state.accounts.a.lastPickedAt > 0);
});

test("markReleased: decrements inflight + sets cooldown on non-ok", () => {
  const state = mkState(["a"]);
  markChecked(state, "a");
  markReleased(state, "a", "rate_limit", { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 });
  assert.equal(state.accounts.a.inflight, 0);
  assert.ok(state.accounts.a.cooling_until > Date.now());
  assert.equal(state.accounts.a.rateLimitStreak, 1);
  assert.equal(state.accounts.a.counters.rate_limit, 1);
});

test("markReleased: rate-limit streak escalates exponentially with 3600s cap", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  // 5 successive rate_limit outcomes
  for (let i = 0; i < 8; i++) markReleased(state, "a", "rate_limit", cd);
  // expected durations: 60, 120, 240, 480, 960, 1920, 3600 (cap), 3600 (cap)
  assert.equal(state.accounts.a.rateLimitStreak, 8);
});

test("markReleased: ok outcome resets rate-limit streak", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  markReleased(state, "a", "rate_limit", cd);
  markReleased(state, "a", "rate_limit", cd);
  assert.equal(state.accounts.a.rateLimitStreak, 2);
  markReleased(state, "a", "ok", cd);
  assert.equal(state.accounts.a.rateLimitStreak, 0);
  assert.equal(state.accounts.a.cooling_until, 0, "ok clears cooling");
});

test("markReleased: auth outcome sets indefinite cooldown (-1 sentinel)", () => {
  const state = mkState(["a"]);
  const cd = { rate_limit: 60, usage_limit: 18000, auth: -1, other: 30 };
  markReleased(state, "a", "auth", cd);
  assert.equal(state.accounts.a.cooling_until, Number.MAX_SAFE_INTEGER);
});
