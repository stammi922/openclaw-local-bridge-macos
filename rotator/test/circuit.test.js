import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepare, complete, probeOnce, scheduleProbeTimer, _setNowForTests, _setProbeExecutorForTests,
} from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests, loadState, saveState } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function setup(accounts) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts }));
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("circuit: 2 auth outcomes in 24h → circuitTrippedAt set, nextProbeAt = T+1h", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "401 Unauthorized" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "invalid_grant" });
  const s = loadState();
  assert.ok(s.circuitTrippedAt);
  assert.ok(s.nextProbeAt);
  const dt = s.nextProbeAt - s.circuitTrippedAt;
  assert.ok(dt >= 60 * 60 * 1000 - 100, "nextProbeAt ≥ T+1h");
  assert.ok(dt <= 60 * 60 * 1000 + 100);
});

test("circuit: prepare during tripped circuit → {noHealthy:'circuit_tripped'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "401 Unauthorized" });
  _resetCachesForTests();
  await complete(await prepare({ model: "claude-sonnet-4" }), { exitCode: 1, stderrTail: "invalid_grant" });
  _resetCachesForTests();
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.equal(ctx.noHealthy, "circuit_tripped");
});

test("probeOnce: all cooled accounts return 'ok' → circuit clears", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  // Manually trip the circuit
  const s = loadState();
  s.circuitTrippedAt = Date.now();
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  s.accounts.b = { ...s.accounts.a };
  saveState(s);
  _setProbeExecutorForTests(async (_label, _configDir) => "ok");
  const result = await probeOnce();
  assert.equal(result.cleared, true);
  const s2 = loadState();
  assert.equal(s2.circuitTrippedAt, null);
  assert.equal(s2.nextProbeAt, null);
});

test("probeOnce: some cooled accounts still fail → re-arms for T+24h, increments probeAttempts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const s = loadState();
  s.circuitTrippedAt = Date.now();
  s.probeAttempts = 0;
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  s.accounts.b = { ...s.accounts.a };
  saveState(s);
  _setProbeExecutorForTests(async (label, _d) => label === "a" ? "ok" : "auth");
  const result = await probeOnce();
  assert.equal(result.cleared, false);
  const s2 = loadState();
  assert.ok(s2.circuitTrippedAt, "circuit still tripped");
  assert.equal(s2.probeAttempts, 1);
  assert.ok(s2.nextProbeAt - Date.now() > 23 * 60 * 60 * 1000, "re-armed for ~24h");
});

test("probeOnce: 7th failing probe → no further re-arm, escalation log, stays tripped", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-circuit-cfg-"));
  setup([{ label: "a", configDir: path.join(tmp, "a") }]);
  const s = loadState();
  s.circuitTrippedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
  s.probeAttempts = 6; // 7th will be the "final"
  s.accounts.a = { inflight: 0, cooling_until: Number.MAX_SAFE_INTEGER, rateLimitStreak: 0, lastPickedAt: 0, lastCheckedAt: 0, lastReleasedAt: 0, counters: { ok: 0, rate_limit: 0, usage_limit: 0, auth: 1, other: 0 } };
  saveState(s);
  _setProbeExecutorForTests(async () => "auth");
  const result = await probeOnce();
  assert.equal(result.cleared, false);
  assert.equal(result.exhausted, true);
  const s2 = loadState();
  assert.equal(s2.nextProbeAt, null, "no further auto-probes");
  assert.ok(s2.circuitTrippedAt, "stays tripped");
});
