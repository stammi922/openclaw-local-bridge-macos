import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, complete, snapshot, refresh } from "../index.js";
import { _setBridgeDirForTests, _resetCachesForTests } from "../pool.js";
import { _setLogPathForTests } from "../logger.js";

function mkEnv(mode, accounts = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-idx-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  _setLogPathForTests(path.join(d, "rotator.log"));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode, accounts }));
  // Pre-create configDirs so configDir existence check passes
  for (const a of accounts) fs.mkdirSync(a.configDir, { recursive: true });
  return d;
}

test("prepare: single mode → {env:{}, label:null, kind:'single'}, no state writes", async () => {
  const d = mkEnv("single");
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.deepEqual(ctx.env, {});
  assert.equal(ctx.label, null);
  assert.equal(ctx.kind, "single");
  assert.equal(fs.existsSync(path.join(d, "state.json")), false, "no state.json written");
});

test("complete: single-mode ctx (label=null) → no-op, no state writes", async () => {
  const d = mkEnv("single");
  await complete({ label: null, kind: "single" }, { exitCode: 0, stderrTail: "" });
  assert.equal(fs.existsSync(path.join(d, "state.json")), false);
});

test("prepare: multi mode happy path → picks account + sets env + updates state", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctx = await prepare({ model: "claude-sonnet-4" });
  assert.ok(ctx.env.CLAUDE_CONFIG_DIR);
  assert.ok(["a", "b"].includes(ctx.label));
  assert.equal(ctx.kind, "main");
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.accounts[ctx.label].inflight, 1);
  assert.equal(state.lastMainLabel, ctx.label);
});

test("prepare: multi mode heartbeat → pickHeartbeat path + does not update lastMainLabel", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [
    { label: "a", configDir: path.join(tmp, "a") },
    { label: "b", configDir: path.join(tmp, "b") },
  ]);
  const ctx = await prepare({ model: "claude-haiku-4" }); // default heartbeat model
  assert.equal(ctx.kind, "heartbeat");
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.lastMainLabel, null, "heartbeats do not anchor sticky pointer");
});

test("prepare → complete round-trip: ok outcome decrements inflight + clears cooling", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  const ctx = await prepare({ model: "claude-sonnet-4" });
  await complete(ctx, { exitCode: 0, stderrTail: "" });
  const state = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(state.accounts.a.inflight, 0);
  assert.equal(state.accounts.a.counters.ok, 1);
});

test("prepare: no healthy accounts → {env:{}, noHealthy:'all_cooling'}", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  const d = mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  // Force cooldown
  const ctx = await prepare({ model: "claude-sonnet-4" });
  await complete(ctx, { exitCode: 1, stderrTail: "Error: Authentication failed" });
  _resetCachesForTests();
  const ctx2 = await prepare({ model: "claude-sonnet-4" });
  assert.deepEqual(ctx2.env, {});
  assert.ok(["all_cooling", "circuit_tripped"].includes(ctx2.noHealthy));
});

test("snapshot: returns registry + state + config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-cfg-"));
  mkEnv("multi", [{ label: "a", configDir: path.join(tmp, "a") }]);
  const snap = snapshot();
  assert.equal(snap.registry.mode, "multi");
  assert.ok(Array.isArray(snap.registry.accounts));
  assert.ok(snap.state && typeof snap.state === "object");
  assert.ok(snap.config);
});
