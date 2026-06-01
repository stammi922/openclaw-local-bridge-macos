import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PATCHER = new URL("./patch-proxy-idle-timeout.mjs", import.meta.url).pathname;
const FIXTURE = new URL("../test/fixtures/idle-timeout/manager.pre.js", import.meta.url).pathname;
const SENTINEL = "@openclaw-bridge:idle-timeout v1";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
  const mgr = path.join(root, "dist/subprocess");
  fs.mkdirSync(mgr, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(mgr, "manager.js"));
  return root;
}
const run = (root, ...a) => execFileSync("node", [PATCHER, "--root", root, ...a], { encoding: "utf8" });
const mgrPath = (root) => path.join(root, "dist/subprocess/manager.js");

test("fresh patch inserts the sentinel + idle timer + resets, valid JS", () => {
  const root = tmpRoot();
  run(root);
  const out = fs.readFileSync(mgrPath(root), "utf8");
  assert.ok(out.includes(SENTINEL));
  assert.ok(out.includes("idleTimeoutId"));
  assert.ok(out.includes("__obResetIdle"));
  assert.match(out, /subprocess\.idle_timeout/);
  execFileSync("node", ["--check", mgrPath(root)]);
});

test("idempotent: second run byte-identical", () => {
  const root = tmpRoot();
  run(root); const a = fs.readFileSync(mgrPath(root), "utf8");
  run(root); const b = fs.readFileSync(mgrPath(root), "utf8");
  assert.equal(a, b);
});

test("--dry-run does not write", () => {
  const root = tmpRoot();
  const before = fs.readFileSync(mgrPath(root), "utf8");
  run(root, "--dry-run");
  assert.equal(fs.readFileSync(mgrPath(root), "utf8"), before);
});

test("missing anchor exits non-zero", () => {
  const root = tmpRoot();
  fs.writeFileSync(mgrPath(root), "export class X {}\n");
  assert.throws(() => run(root));
});

test("--dry-run on an already-patched file is a clean no-op", () => {
  const root = tmpRoot();
  run(root);
  const patched = fs.readFileSync(mgrPath(root), "utf8");
  run(root, "--dry-run"); // already patched
  assert.equal(fs.readFileSync(mgrPath(root), "utf8"), patched);
});

test("missing --root exits non-zero", () => {
  assert.throws(() => execFileSync("node", [PATCHER], { encoding: "utf8", env: { ...process.env, PROXY_HOME: "" } }));
});
