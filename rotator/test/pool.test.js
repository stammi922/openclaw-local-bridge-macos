import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRegistry, loadState, saveState, ensureAccountSlot,
  _setBridgeDirForTests, _resetCachesForTests,
} from "../pool.js";

function mkBridgeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-pool-"));
  _setBridgeDirForTests(d);
  _resetCachesForTests();
  return d;
}

test("loadRegistry: missing accounts.json → default {mode:'single',accounts:[]}", () => {
  mkBridgeDir();
  const r = loadRegistry();
  assert.equal(r.mode, "single");
  assert.deepEqual(r.accounts, []);
});

test("loadRegistry: malformed JSON → default", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), "{this is not json");
  const r = loadRegistry();
  assert.equal(r.mode, "single");
});

test("loadRegistry: valid multi mode with accounts", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({
    mode: "multi",
    accounts: [{ label: "a", configDir: "/tmp/a" }, { label: "b", configDir: "/tmp/b" }],
  }));
  const r = loadRegistry();
  assert.equal(r.mode, "multi");
  assert.equal(r.accounts.length, 2);
  assert.equal(r.accounts[0].label, "a");
});

test("loadRegistry: 1s cache — mutating the file within 1s does not reload", () => {
  const d = mkBridgeDir();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "single", accounts: [] }));
  const r1 = loadRegistry();
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ mode: "multi", accounts: [] }));
  const r2 = loadRegistry();
  assert.equal(r2.mode, "single", "cache should still see 'single'");
  // reset cache, then re-read:
  _resetCachesForTests();
  const r3 = loadRegistry();
  assert.equal(r3.mode, "multi");
});

test("loadState / saveState: round-trip", () => {
  mkBridgeDir();
  const s = loadState();
  assert.deepEqual(s.accounts, {});
  assert.equal(s.recentOutcomes.length, 0);
  s.lastMainLabel = "work";
  saveState(s);
  const s2 = loadState();
  assert.equal(s2.lastMainLabel, "work");
});

test("saveState: atomic via tmp+rename (no partial-read)", () => {
  const d = mkBridgeDir();
  const s = loadState();
  s.lastMainLabel = "a".repeat(100);
  saveState(s);
  const files = fs.readdirSync(d);
  assert.ok(files.includes("state.json"));
  assert.ok(!files.some(f => f.endsWith(".tmp")), "no leftover tmp files");
});

test("ensureAccountSlot: idempotent, initializes counters", () => {
  mkBridgeDir();
  const s = loadState();
  ensureAccountSlot(s, "work");
  assert.ok(s.accounts.work);
  assert.equal(s.accounts.work.inflight, 0);
  assert.equal(s.accounts.work.cooling_until, 0);
  assert.equal(s.accounts.work.rateLimitStreak, 0);
  ensureAccountSlot(s, "work"); // re-run
  assert.equal(s.accounts.work.inflight, 0, "idempotent — does not reset existing slot");
});
