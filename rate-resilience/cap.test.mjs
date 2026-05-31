import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateAwareCap } from "./cap.js";

test("starts at base max", () => {
  const cap = createRateAwareCap({ baseMax: 4, cooldownMs: 60000 });
  assert.equal(cap.currentMax(), 4);
});

test("shrinks to floor(base/2) on rate-limit, min 1", () => {
  const cap = createRateAwareCap({ baseMax: 4, cooldownMs: 60000, now: () => 0 });
  cap.onRateLimited("burst");
  assert.equal(cap.currentMax(), 2);
  const cap1 = createRateAwareCap({ baseMax: 1, cooldownMs: 60000, now: () => 0 });
  cap1.onRateLimited("burst");
  assert.equal(cap1.currentMax(), 1);
});

test("restores after cooldown elapses", () => {
  let t = 0;
  const cap = createRateAwareCap({ baseMax: 4, cooldownMs: 60000, now: () => t });
  cap.onRateLimited("burst");
  assert.equal(cap.currentMax(), 2);
  t = 59999;
  assert.equal(cap.currentMax(), 2);
  t = 60001;
  assert.equal(cap.currentMax(), 4);
});

test("repeat hit extends cooldown from the new now", () => {
  let t = 0;
  const cap = createRateAwareCap({ baseMax: 4, cooldownMs: 60000, now: () => t });
  cap.onRateLimited("burst");
  t = 50000;
  cap.onRateLimited("burst");
  t = 100000;
  assert.equal(cap.currentMax(), 2);
  t = 110001;
  assert.equal(cap.currentMax(), 4);
});
