import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const capPatcher = path.join(repoRoot, "scripts", "patch-routes-concurrency-cap.mjs");
const patcher = path.join(repoRoot, "scripts", "patch-routes-session-serialize.mjs");
const routesFixture = path.join(repoRoot, "test", "fixtures", "routes", "routes.pre.js");

function mkFakeProxy({ withCap = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-session-"));
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(routesFixture, path.join(d, "dist", "server", "routes.js"));
  if (withCap) execFileSync("node", [capPatcher, d]);
  return d;
}

test("patch-routes-session-serialize: fresh patch on cap-patched file", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const routes = fs.readFileSync(path.join(d, "dist", "server", "routes.js"), "utf8");
  assert.ok(routes.includes("@openclaw-bridge:session-serialize v1"), "sentinel present");
  assert.ok(routes.includes("const __OB_sessionLocks = new Map();"), "session lock map injected");
  assert.ok(routes.includes("function __obSessionLock(sessionId)"), "session lock helper injected");
  assert.ok(routes.includes("__obLock = __obSessionLock(__obCli && __obCli.sessionId);"), "lock acquired inside handler");
  assert.ok(routes.includes("} finally { __obLock.release(); }"), "lock release in finally");
});

test("patch-routes-session-serialize: patched routes.js still parses as ESM", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  execFileSync("node", ["--check", path.join(d, "dist", "server", "routes.js")]);
});

test("patch-routes-session-serialize: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const after1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  execFileSync("node", [patcher, d]);
  const after2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(after1.equals(after2), "routes.js byte-identical on re-run");
});

test("patch-routes-session-serialize: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const before = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  const after = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(before.equals(after), "no changes on dry-run");
});

test("patch-routes-session-serialize: --dry-run on already-patched file reports already patched", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /already patched/);
});

test("patch-routes-session-serialize: errors clearly when cap patch is missing", () => {
  const d = mkFakeProxy({ withCap: false });
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err, "expected non-zero exit when cap patch missing");
  assert.match(err.stderr.toString(), /concurrency-cap/);
});

test("patch-routes-session-serialize: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
