import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-rate-resilience.mjs");
const mgrFix = path.join(repoRoot, "test", "fixtures", "rate-resilience", "manager.pre.js");
const rtFix = path.join(repoRoot, "test", "fixtures", "rate-resilience", "routes.pre.js");

function mkProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-rr-"));
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(mgrFix, path.join(d, "dist", "subprocess", "manager.js"));
  fs.copyFileSync(rtFix, path.join(d, "dist", "server", "routes.js"));
  return d;
}
const mgr = (d) => path.join(d, "dist", "subprocess", "manager.js");
const rt = (d) => path.join(d, "dist", "server", "routes.js");

test("fresh patch: sentinel + modules + valid JS", () => {
  const d = mkProxy();
  execFileSync("node", [patcher, d]);
  for (const f of [mgr(d), rt(d)]) {
    assert.ok(fs.readFileSync(f, "utf8").includes("@openclaw-bridge:rate-resilience v1"));
    execFileSync("node", ["--check", f]);
  }
  for (const m of ["classify.js", "backoff.js", "cap.js", "events.js"])
    assert.ok(fs.existsSync(path.join(d, "dist", "rate-resilience", m)), `${m} copied`);
  const m = fs.readFileSync(mgr(d), "utf8");
  assert.ok(m.includes('classifyRateLimit(this.stderrTail, code)'));
  assert.ok(m.includes('type: "subprocess.timeout"'));
  const r = fs.readFileSync(rt(d), "utf8");
  assert.ok(r.includes('__obRateCap.currentMax()'));
  assert.ok(r.includes('type: "rate_limited"'));
});

test("idempotent: re-run byte-identical", () => {
  const d = mkProxy();
  execFileSync("node", [patcher, d]);
  const a1 = fs.readFileSync(mgr(d)); const b1 = fs.readFileSync(rt(d));
  execFileSync("node", [patcher, d]);
  assert.ok(a1.equals(fs.readFileSync(mgr(d))) && b1.equals(fs.readFileSync(rt(d))));
});

test("--dry-run makes no changes", () => {
  const d = mkProxy();
  const a = fs.readFileSync(mgr(d));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  assert.ok(a.equals(fs.readFileSync(mgr(d))));
});

test("missing anchor → non-zero + 'anchor not found'", () => {
  const d = mkProxy();
  fs.writeFileSync(mgr(d), "// no anchors\n");
  let err;
  try { execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err = e; }
  assert.ok(err);
  assert.match(err.stderr.toString(), /anchor not found/i);
});
