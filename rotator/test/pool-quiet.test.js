import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, complete } from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests, loadState } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function setup(accounts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts }));
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("pool-quiet: 2 distinct accounts → rate_limit within 120s → poolQuietUntil = now+300s", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctxA = await prepare({ model: "claude-sonnet-4" });
  await complete(ctxA, { exitCode: 1, stderrTail: "HTTP 429 rate_limit_error" });
  _resetCachesForTests();
  const ctxB = await prepare({ model: "claude-sonnet-4" });
  await complete(ctxB, { exitCode: 1, stderrTail: "HTTP 429 rate_limit_error" });
  const s = loadState();
  assert.ok(s.poolQuietUntil > Date.now(), "pool quiet should be set");
  assert.ok(s.poolQuietUntil <= Date.now() + 305 * 1000, "duration ~300s");
});

test("pool-quiet: during quiet period, prepare → {noHealthy:'pool_quiet'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const a = await prepare({ model: "claude-sonnet-4" });
  await complete(a, { exitCode: 1, stderrTail: "rate limit exceeded" });
  _resetCachesForTests();
  const b = await prepare({ model: "claude-sonnet-4" });
  await complete(b, { exitCode: 1, stderrTail: "rate limit exceeded" });
  _resetCachesForTests();
  const c = await prepare({ model: "claude-sonnet-4" });
  assert.equal(c.noHealthy, "pool_quiet");
  assert.equal(c.label, null);
});

test("pool-quiet: 2 distinct usage_limit within 600s → 3600s quiet", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const a = await prepare({ model: "claude-sonnet-4" });
  await complete(a, { exitCode: 1, stderrTail: "Your usage limit has been reached" });
  _resetCachesForTests();
  const b = await prepare({ model: "claude-sonnet-4" });
  await complete(b, { exitCode: 1, stderrTail: "5-hour usage window exhausted" });
  const s = loadState();
  assert.ok(s.poolQuietUntil - Date.now() > 3500 * 1000, "duration ~3600s");
  assert.ok(s.poolQuietUntil - Date.now() <= 3605 * 1000);
});

test("pool-quiet: re-trigger within 30min doubles duration (cap 3600s)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-quiet-cfg-"));
  const d = setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  // First trigger
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  let s = loadState();
  const d1 = s.poolQuietUntil - Date.now();
  assert.ok(d1 <= 305 * 1000, `first quiet ~300s (got ${d1}ms)`);

  // Simulate pool quiet expired + re-trigger within 30min
  s.poolQuietUntil = Date.now() - 1000;
  s.poolQuietLastTriggeredAt = Date.now() - 10 * 60 * 1000; // 10 min ago, within 30min
  s.recentOutcomes = []; // Clear recent outcomes to test clean re-trigger
  // Clear account cooldowns so prepare() can pick accounts again
  for (const label in s.accounts) {
    s.accounts[label].cooling_until = 0;
  }
  // Use the returned temp dir `d` from setup() directly (more robust than env var)
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(s, null, 2));
  _resetCachesForTests();

  // Second trigger
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "rate limit" });
  s = loadState();
  const d2 = s.poolQuietUntil - Date.now();
  assert.ok(d2 > 550 * 1000, `second quiet should be ~600s, got ${d2}ms`);
});
