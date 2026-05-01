import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-system-prompt.mjs");
const managerFixture = path.join(repoRoot, "test", "fixtures", "system-prompt", "manager.pre.js");
const adapterFixture = path.join(repoRoot, "test", "fixtures", "system-prompt", "openai-to-cli.pre.js");
const routesFixture  = path.join(repoRoot, "test", "fixtures", "system-prompt", "routes.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-sysprompt-"));
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "adapter"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(managerFixture, path.join(d, "dist", "subprocess", "manager.js"));
  fs.copyFileSync(adapterFixture, path.join(d, "dist", "adapter", "openai-to-cli.js"));
  fs.copyFileSync(routesFixture,  path.join(d, "dist", "server", "routes.js"));
  return d;
}

test("patch-proxy-system-prompt: fresh patch sets sentinels in all 3 files + isolation flags + systemPrompt routing", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const manager = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"), "utf8");
  const adapter = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"), "utf8");
  const routes  = fs.readFileSync(path.join(d, "dist", "server", "routes.js"), "utf8");
  assert.ok(manager.includes("@openclaw-bridge:systemPrompt v1"), "manager.js sentinel");
  assert.ok(adapter.includes("@openclaw-bridge:systemPrompt v1"), "openai-to-cli.js sentinel");
  assert.ok(routes.includes("@openclaw-bridge:systemPrompt v1"),  "routes.js sentinel");
  assert.ok(manager.includes("--disable-slash-commands"), "isolation flag");
  assert.ok(manager.includes('"--setting-sources", "project"'), "setting-sources flag");
  assert.ok(manager.includes("options.systemPrompt"), "manager forwards options.systemPrompt to argv");
  // Tight assertions on adapter — sentinel comment alone contains "systemPrompt", so look for the field syntax + filtering call.
  assert.ok(adapter.includes("systemPrompt:"), "adapter return object now includes a systemPrompt field");
  assert.ok(adapter.includes("_nonSystem") || adapter.includes(".filter("), "adapter filters role:'system' out of prompt input");
  assert.ok(routes.includes("cliInput.systemPrompt"), "routes forwards cliInput.systemPrompt to start options");
});

test("patch-proxy-system-prompt: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const m1 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const a1 = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const r1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  execFileSync("node", [patcher, d]);
  const m2 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const a2 = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const r2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(m1.equals(m2), "manager.js byte-identical");
  assert.ok(a1.equals(a2), "openai-to-cli.js byte-identical");
  assert.ok(r1.equals(r2), "routes.js byte-identical");
});

test("patch-proxy-system-prompt: --dry-run makes no changes + reports plan", () => {
  const d = mkFakeProxy();
  const mBefore = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const aBefore = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const rBefore = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  const out = execFileSync("node", [patcher, d, "--dry-run"]).toString();
  assert.match(out, /WOULD patch/);
  const mAfter = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const aAfter = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const rAfter = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(mBefore.equals(mAfter), "manager.js unchanged on dry-run");
  assert.ok(aBefore.equals(aAfter), "openai-to-cli.js unchanged on dry-run");
  assert.ok(rBefore.equals(rAfter), "routes.js unchanged on dry-run");
});

test("patch-proxy-system-prompt: missing anchor → non-zero exit with 'anchor' in stderr", () => {
  const d = mkFakeProxy();
  fs.writeFileSync(path.join(d, "dist", "subprocess", "manager.js"), "// no anchor here\n");
  let err;
  try {
    execFileSync("node", [patcher, d], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.match(err.stderr.toString(), /anchor/i);
});

test("patch-proxy-system-prompt: missing proxy root → exits with error", () => {
  let err;
  try {
    execFileSync("node", [patcher, "/definitely/does/not/exist"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
