import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-gateway-plist.mjs");
const FAKE_HOME = "/Users/test-bridge";

function plutil(...argv) {
  return spawnSync("plutil", argv, { encoding: "utf8" });
}

function runPatcher(plistPath, extra = []) {
  return spawnSync("node", [patcher, plistPath, ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: FAKE_HOME },
  });
}

function mkPlist({ withEnv = false, withEntrypoint = false, withWorkingDir = false } = {}) {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), "patch-gateway-plist-")) + "/test.plist";
  const envBlock = withEnv
    ? `<key>EnvironmentVariables</key><dict>${withEntrypoint ? "<key>CLAUDE_CODE_ENTRYPOINT</key><string>cli</string>" : ""}</dict>`
    : "";
  const wdBlock = withWorkingDir ? `<key>WorkingDirectory</key><string>${FAKE_HOME}</string>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.openclaw.gateway</string>
<key>ProgramArguments</key><array><string>/usr/bin/false</string></array>
${envBlock}
${wdBlock}
</dict></plist>`;
  fs.writeFileSync(f, xml);
  // canonicalize so plutil treats as parsed
  const conv = plutil("-convert", "xml1", f);
  if (conv.status !== 0) throw new Error(`fixture invalid: ${conv.stderr}`);
  return f;
}

test("patch-gateway-plist: succeeds when EnvironmentVariables dict is missing entirely (regression)", () => {
  const f = mkPlist({});
  const res = runPatcher(f);
  assert.equal(res.status, 0, `patcher failed: ${res.stderr}`);
  const env = plutil("-extract", "EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT", "raw", f);
  assert.equal(env.status, 0, "CLAUDE_CODE_ENTRYPOINT key missing after patch");
  assert.equal(env.stdout.trim(), "cli");
  const wd = plutil("-extract", "WorkingDirectory", "raw", f);
  assert.equal(wd.status, 0);
  assert.equal(wd.stdout.trim(), FAKE_HOME);
});

test("patch-gateway-plist: succeeds when EnvironmentVariables dict exists but key is missing", () => {
  const f = mkPlist({ withEnv: true });
  const res = runPatcher(f);
  assert.equal(res.status, 0, `patcher failed: ${res.stderr}`);
  const env = plutil("-extract", "EnvironmentVariables.CLAUDE_CODE_ENTRYPOINT", "raw", f);
  assert.equal(env.stdout.trim(), "cli");
});

test("patch-gateway-plist: idempotent — re-run on patched plist is byte-identical", () => {
  const f = mkPlist({});
  const r1 = runPatcher(f);
  assert.equal(r1.status, 0);
  const before = fs.readFileSync(f);
  const r2 = runPatcher(f);
  assert.equal(r2.status, 0);
  const after = fs.readFileSync(f);
  assert.ok(before.equals(after), "plist changed on second patcher run");
});

test("patch-gateway-plist: --dry-run on plist with missing dict makes no changes", () => {
  const f = mkPlist({});
  const before = fs.readFileSync(f);
  const res = runPatcher(f, ["--dry-run"]);
  assert.equal(res.status, 0, `dry-run failed: ${res.stderr}`);
  const after = fs.readFileSync(f);
  assert.ok(before.equals(after), "dry-run mutated plist");
});
