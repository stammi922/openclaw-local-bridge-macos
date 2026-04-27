import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-timeout.mjs");
const managerFixture = path.join(repoRoot, "test", "fixtures", "timeout", "manager.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-timeout-"));
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.copyFileSync(managerFixture, path.join(d, "dist", "subprocess", "manager.js"));
  return d;
}

test("patch-proxy-timeout: fresh patch sets sentinel + bumps value", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const manager = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"), "utf8");
  assert.ok(manager.includes("@openclaw-bridge:timeout v1"), "sentinel present");
  assert.ok(manager.includes("DEFAULT_TIMEOUT = 7200000"), "value bumped to 7200000");
  assert.ok(!manager.includes("DEFAULT_TIMEOUT = 300000"), "old 300000 value removed");
});

test("patch-proxy-timeout: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  assert.ok(after1.equals(after2), "manager.js byte-identical on re-run");
});

test("patch-proxy-timeout: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  const after = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  assert.ok(before.equals(after), "no changes on dry-run");
});

test("patch-proxy-timeout: --dry-run on already-patched file reports already patched", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /already patched/);
});

test("patch-proxy-timeout: missing anchor → non-zero exit with 'anchor' in stderr", () => {
  const d = mkFakeProxy();
  fs.writeFileSync(path.join(d, "dist", "subprocess", "manager.js"), "// no anchor here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err, "expected patcher to exit non-zero");
  assert.match(err.stderr.toString(), /anchor/i);
});

test("patch-proxy-timeout: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
