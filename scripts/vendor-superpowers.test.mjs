import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const vendor = path.join(repoRoot, "scripts", "vendor-superpowers.mjs");
const sampleFixture = path.join(repoRoot, "test", "fixtures", "superpowers", "sample-skill.pre.md");

function mkFakeUpstream() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sp-upstream-"));
  fs.mkdirSync(path.join(d, "skills", "test-driven-development"), { recursive: true });
  fs.copyFileSync(sampleFixture, path.join(d, "skills", "test-driven-development", "SKILL.md"));
  fs.mkdirSync(path.join(d, "skills", "using-superpowers"), { recursive: true }); // skipped meta-skill
  fs.copyFileSync(sampleFixture, path.join(d, "skills", "using-superpowers", "SKILL.md"));
  fs.writeFileSync(path.join(d, "LICENSE"), "MIT License\n\nCopyright (c) 2025 Jesse Vincent\n");
  // Make it look like a git repo so vendor script can read SHA.
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "add", "."], { cwd: d });
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: d });
  return d;
}

function mkFakeBridge() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sp-bridge-"));
  return d;
}

test("vendor-superpowers: copies kept skills + skips meta-skills + applies fix-ups", () => {
  const upstream = mkFakeUpstream();
  const bridge = mkFakeBridge();
  execFileSync("node", [vendor, "--upstream-clone", upstream, "--bridge-root", bridge]);
  const tdd = fs.readFileSync(path.join(bridge, "skills", "superpowers", "test-driven-development", "SKILL.md"), "utf8");
  assert.ok(tdd.includes("openclaw skill loader"), "Skill tool replaced");
  assert.ok(!tdd.includes("the Skill tool"), "old phrase removed");
  assert.ok(!tdd.includes("superpowers:test-driven-development"), "plugin prefix dropped");
  assert.ok(tdd.includes("exec tool"), "Bash tool replaced");
  assert.ok(!fs.existsSync(path.join(bridge, "skills", "superpowers", "using-superpowers")),
    "meta-skill 'using-superpowers' must NOT be vendored");
});

test("vendor-superpowers: writes VENDOR.md with SHA + LICENSE + README.md", () => {
  const upstream = mkFakeUpstream();
  const bridge = mkFakeBridge();
  execFileSync("node", [vendor, "--upstream-clone", upstream, "--bridge-root", bridge]);
  const vendorMd = fs.readFileSync(path.join(bridge, "skills", "superpowers", "VENDOR.md"), "utf8");
  assert.match(vendorMd, /^[0-9a-f]{40}\b/m, "VENDOR.md has a 40-char SHA on its own line");
  assert.match(vendorMd, /\d{4}-\d{2}-\d{2}/, "VENDOR.md has an ISO-ish date");
  const license = fs.readFileSync(path.join(bridge, "skills", "superpowers", "LICENSE"), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Jesse Vincent/);
  const readme = fs.readFileSync(path.join(bridge, "skills", "superpowers", "README.md"), "utf8");
  assert.match(readme, /obra\/superpowers/);
});

test("vendor-superpowers: re-run is idempotent (byte-identical SKILL.md output)", () => {
  const upstream = mkFakeUpstream();
  const bridge = mkFakeBridge();
  execFileSync("node", [vendor, "--upstream-clone", upstream, "--bridge-root", bridge]);
  const before = fs.readFileSync(path.join(bridge, "skills", "superpowers", "test-driven-development", "SKILL.md"));
  execFileSync("node", [vendor, "--upstream-clone", upstream, "--bridge-root", bridge]);
  const after = fs.readFileSync(path.join(bridge, "skills", "superpowers", "test-driven-development", "SKILL.md"));
  assert.ok(before.equals(after), "second vendor run should be byte-identical");
});

test("vendor-superpowers: missing upstream → exits with error", () => {
  const bridge = mkFakeBridge();
  let err;
  try {
    execFileSync("node", [vendor, "--upstream-clone", "/definitely/does/not/exist", "--bridge-root", bridge],
      { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err = e; }
  assert.ok(err);
});
