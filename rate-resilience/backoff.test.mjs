import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffMs, MAX_BURST_ATTEMPTS } from "./backoff.js";

test("attempt 1 within [0, base]", () => {
  for (let i = 0; i < 100; i++) {
    const ms = computeBackoffMs(1, { baseMs: 2000, factor: 2, capMs: 30000 });
    assert.ok(ms >= 0 && ms <= 2000, `got ${ms}`);
  }
});

test("attempt grows but is capped at capMs", () => {
  for (let i = 0; i < 100; i++) {
    const ms = computeBackoffMs(10, { baseMs: 2000, factor: 2, capMs: 30000 });
    assert.ok(ms >= 0 && ms <= 30000, `got ${ms}`);
  }
});

test("full jitter: attempt 2 never exceeds base*factor", () => {
  for (let i = 0; i < 100; i++) {
    const ms = computeBackoffMs(2, { baseMs: 2000, factor: 2, capMs: 30000 });
    assert.ok(ms <= 4000, `got ${ms}`);
  }
});

test("MAX_BURST_ATTEMPTS is 3", () => {
  assert.equal(MAX_BURST_ATTEMPTS, 3);
});
