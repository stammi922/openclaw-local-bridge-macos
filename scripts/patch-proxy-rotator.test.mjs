import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-rotator.mjs");
const routesFixture = path.join(repoRoot, "test", "fixtures", "rotator", "routes.pre.js");
const managerFixture = path.join(repoRoot, "test", "fixtures", "rotator", "manager.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-rotator-"));
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.copyFileSync(routesFixture, path.join(d, "dist", "server", "routes.js"));
  fs.copyFileSync(managerFixture, path.join(d, "dist", "subprocess", "manager.js"));
  return d;
}

test("patch-proxy-rotator: fresh patch succeeds + sentinels present", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const routes = fs.readFileSync(path.join(d, "dist", "server", "routes.js"), "utf8");
  const manager = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"), "utf8");
  assert.ok(routes.includes("@openclaw-bridge:rotator v1"), "routes.js sentinel present");
  assert.ok(manager.includes("@openclaw-bridge:rotator v1"), "manager.js sentinel present");
  const rotatorDir = path.join(d, "dist", "rotator");
  assert.ok(fs.existsSync(path.join(rotatorDir, "index.js")));
  assert.ok(fs.existsSync(path.join(rotatorDir, "pool.js")));
});

test("patch-proxy-rotator: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const after1m = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const after2m = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  assert.ok(after1.equals(after2), "routes.js byte-identical on re-run");
  assert.ok(after1m.equals(after2m), "manager.js byte-identical on re-run");
});

test("patch-proxy-rotator: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.ok(/WOULD patch/.test(out));
  const after = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(before.equals(after), "no changes on dry-run");
});

test("patch-proxy-rotator: missing anchor → non-zero exit with 'anchor' in stderr", () => {
  const d = mkFakeProxy();
  // Mutate routes.js to remove anchor
  fs.writeFileSync(path.join(d, "dist", "server", "routes.js"), "// no anchor here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected patcher to exit non-zero");
  assert.match(err.stderr.toString(), /anchor/i);
});

test("patch-proxy-rotator: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
