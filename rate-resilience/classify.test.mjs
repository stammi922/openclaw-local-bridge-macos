import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRateLimit } from "./classify.js";

test("usage-limit string → subtype usage", () => {
  const r = classifyRateLimit("Claude usage limit reached. Your limit will reset at 5pm (UTC)", 1);
  assert.equal(r?.subtype, "usage");
});

test("usage-limit epoch form → usage with retryAfterMs from epoch", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = classifyRateLimit(`Claude AI usage limit reached|${future}`, 1);
  assert.equal(r?.subtype, "usage");
  assert.ok(r.retryAfterMs > 3000_000 && r.retryAfterMs <= 3600_000, "≈1h");
});

test("'Resets in: 2h 5m' → usage with parsed retryAfterMs", () => {
  const r = classifyRateLimit("You've reached your usage limit for this period. Resets in: 2h 5m", 1);
  assert.equal(r?.subtype, "usage");
  assert.equal(r.retryAfterMs, (2 * 3600 + 5 * 60) * 1000);
});

test("burst limiter string → subtype burst", () => {
  const r = classifyRateLimit("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited", 1);
  assert.equal(r?.subtype, "burst");
});

test("normal stderr → null (no false positive)", () => {
  assert.equal(classifyRateLimit("[debug] starting model call\nDONE", 0), null);
});

test("exit 0 is never rate-limited even with limit-ish text", () => {
  assert.equal(classifyRateLimit("rate limited maybe", 0), null);
});

test("undefined stderr → null", () => {
  assert.equal(classifyRateLimit(undefined, 1), null);
});
