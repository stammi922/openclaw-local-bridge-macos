import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-routes-stream-safety.mjs");
const routesFixture = path.join(repoRoot, "test", "fixtures", "routes", "routes.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-stream-"));
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(routesFixture, path.join(d, "dist", "server", "routes.js"));
  return d;
}

test("patch-routes-stream-safety: fresh patch sets sentinel + injects everything", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const routes = fs.readFileSync(path.join(d, "dist", "server", "routes.js"), "utf8");
  assert.ok(routes.includes("@openclaw-bridge:stream-safety v1"), "sentinel present");
  assert.ok(routes.includes("export async function __OB_TEST_handleStreamingResponse"), "handler renamed + exported");
  assert.ok(routes.includes("await __OB_TEST_handleStreamingResponse(req, res, subprocess"), "caller updated");
  assert.ok(routes.includes("__obKeepAlive = setInterval"), "keep-alive interval installed");
  assert.ok(routes.includes('try { res.write(":keep-alive\\n\\n");'), "keep-alive payload present");
  assert.ok(routes.includes("__obSawDelta = true;"), "sawDelta flag set in delta handler");
  assert.ok(routes.includes("if (!__obSawDelta && _result"), "empty-result fallback installed");
  assert.ok(routes.includes("__obStopKeepAlive()"), "keep-alive cleared on terminal events");
});

test("patch-routes-stream-safety: patched routes.js still parses as ESM", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  execFileSync("node", ["--check", path.join(d, "dist", "server", "routes.js")]);
});

test("patch-routes-stream-safety: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(after1.equals(after2), "routes.js byte-identical on re-run");
});

test("patch-routes-stream-safety: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  const after = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(before.equals(after), "no changes on dry-run");
});

test("patch-routes-stream-safety: --dry-run on already-patched file reports already patched", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /already patched/);
});

test("patch-routes-stream-safety: missing anchor → non-zero exit with 'anchor' in stderr", () => {
  const d = mkFakeProxy();
  fs.writeFileSync(path.join(d, "dist", "server", "routes.js"), "// nothing useful in here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err, "expected patcher to exit non-zero");
  assert.match(err.stderr.toString(), /anchor/i);
});

test("patch-routes-stream-safety: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
