import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome, DEFAULT_PATTERNS } from "../detector.js";

test("classifyOutcome: exitCode 0 → 'ok' regardless of stderr content", () => {
  assert.equal(classifyOutcome(0, ""), "ok");
  assert.equal(classifyOutcome(0, "rate limit exceeded"), "ok");
  assert.equal(classifyOutcome(0, "anthropic auth failed"), "ok");
});

test("classifyOutcome: exitCode !== 0 + rate-limit regex → 'rate_limit'", () => {
  assert.equal(classifyOutcome(1, "Error: Rate limit exceeded, retry in 60s"), "rate_limit");
  assert.equal(classifyOutcome(1, "HTTP 429 rate_limit_error"), "rate_limit");
});

test("classifyOutcome: exitCode !== 0 + usage-limit regex → 'usage_limit'", () => {
  assert.equal(classifyOutcome(1, "Your usage limit has been reached. Reset at 14:00"), "usage_limit");
  assert.equal(classifyOutcome(1, "5-hour usage window exhausted"), "usage_limit");
});

test("classifyOutcome: exitCode !== 0 + auth regex → 'auth'", () => {
  assert.equal(classifyOutcome(1, "Error: Authentication failed. Please run 'claude login'"), "auth");
  assert.equal(classifyOutcome(1, "401 Unauthorized: OAuth token invalid"), "auth");
  assert.equal(classifyOutcome(1, "invalid_grant: refresh failed"), "auth");
});

test("classifyOutcome: exitCode !== 0 + unknown stderr → 'other'", () => {
  assert.equal(classifyOutcome(1, "Network timeout"), "other");
  assert.equal(classifyOutcome(1, ""), "other");
  assert.equal(classifyOutcome(137, "killed"), "other");
});

test("classifyOutcome: null/undefined exitCode treated as failure", () => {
  assert.equal(classifyOutcome(null, ""), "other");
  assert.equal(classifyOutcome(undefined, ""), "other");
});

test("classifyOutcome: custom patterns override defaults", () => {
  const custom = { rate_limit: /CUSTOM_RATE/i, usage_limit: /CUSTOM_USAGE/i, auth: /CUSTOM_AUTH/i };
  assert.equal(classifyOutcome(1, "CUSTOM_RATE triggered", custom), "rate_limit");
  assert.equal(classifyOutcome(1, "rate limit exceeded", custom), "other");
});
