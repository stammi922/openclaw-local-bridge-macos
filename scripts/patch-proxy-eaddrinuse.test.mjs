import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-eaddrinuse.mjs");
const indexFixture = path.join(repoRoot, "test", "fixtures", "eaddrinuse", "index.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-eaddrinuse-"));
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(indexFixture, path.join(d, "dist", "server", "index.js"));
  return d;
}
const idx = (d) => path.join(d, "dist", "server", "index.js");

test("patch-proxy-eaddrinuse: fresh patch sets sentinel + adds retry loop", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const out = fs.readFileSync(idx(d), "utf8");
  assert.ok(out.includes("@openclaw-bridge:eaddrinuse-retry v1"), "sentinel present");
  assert.ok(out.includes("for (let attempt = 1; attempt <= maxAttempts; attempt++)"), "retry loop present");
  assert.ok(out.includes("is already in use after"), "exhausted-retries message present");
  assert.ok(!out.includes("return new Promise((resolve, reject) => {\n        serverInstance = createServer(app);"), "old single-shot bind block removed");
});

test("patch-proxy-eaddrinuse: patched output is valid JS (node --check)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  // throws on syntax error
  execFileSync("node", ["--check", idx(d)]);
});

test("patch-proxy-eaddrinuse: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(idx(d));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(idx(d));
  assert.ok(after1.equals(after2), "index.js byte-identical on re-run");
});

test("patch-proxy-eaddrinuse: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(idx(d));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  assert.ok(before.equals(fs.readFileSync(idx(d))), "no changes on dry-run");
});

test("patch-proxy-eaddrinuse: --dry-run on already-patched file reports already patched", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /already patched/);
});

test("patch-proxy-eaddrinuse: missing anchor → non-zero exit with 'changed' in stderr", () => {
  const d = mkFakeProxy();
  fs.writeFileSync(idx(d), "// no anchor here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err, "expected patcher to exit non-zero");
  assert.match(err.stderr.toString(), /changed/i);
});

test("patch-proxy-eaddrinuse: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
