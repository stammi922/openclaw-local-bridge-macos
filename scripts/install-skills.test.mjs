import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const installer = path.join(repoRoot, "scripts", "install-skills.mjs");

function mkFakeBridge() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "install-skills-bridge-"));
  fs.mkdirSync(path.join(d, "skills", "superpowers", "test-driven-development"), { recursive: true });
  fs.writeFileSync(path.join(d, "skills", "superpowers", "test-driven-development", "SKILL.md"),
    "---\nname: test-driven-development\ndescription: t\n---\nbody\n");
  fs.mkdirSync(path.join(d, "skills", "superpowers", "brainstorming"), { recursive: true });
  fs.writeFileSync(path.join(d, "skills", "superpowers", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: t\n---\nbody\n");
  // Non-skill files should be ignored:
  fs.writeFileSync(path.join(d, "skills", "superpowers", "LICENSE"), "MIT");
  fs.writeFileSync(path.join(d, "skills", "superpowers", "README.md"), "readme");
  fs.writeFileSync(path.join(d, "skills", "superpowers", "VENDOR.md"), "abc123\n2026-05-01");
  return d;
}

function mkFakeOpenclawHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "install-skills-home-"));
}

test("install-skills: fresh install copies SKILL.md folders + ignores LICENSE/README/VENDOR", () => {
  const bridge = mkFakeBridge();
  const oc = mkFakeOpenclawHome();
  execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc]);
  assert.ok(fs.existsSync(path.join(oc, "skills", "test-driven-development", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(oc, "skills", "brainstorming", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(oc, "skills", "LICENSE")));
  assert.ok(!fs.existsSync(path.join(oc, "skills", "README.md")));
  assert.ok(!fs.existsSync(path.join(oc, "skills", "VENDOR.md")));
});

test("install-skills: re-run is byte-identical (idempotent)", () => {
  const bridge = mkFakeBridge();
  const oc = mkFakeOpenclawHome();
  execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc]);
  const before = fs.readFileSync(path.join(oc, "skills", "test-driven-development", "SKILL.md"));
  execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc]);
  const after = fs.readFileSync(path.join(oc, "skills", "test-driven-development", "SKILL.md"));
  assert.ok(before.equals(after));
});

test("install-skills: source newer than dest → updates dest", () => {
  const bridge = mkFakeBridge();
  const oc = mkFakeOpenclawHome();
  execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc]);
  // Mutate source.
  fs.writeFileSync(path.join(bridge, "skills", "superpowers", "test-driven-development", "SKILL.md"),
    "---\nname: test-driven-development\ndescription: t\n---\nUPDATED body\n");
  execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc]);
  const after = fs.readFileSync(path.join(oc, "skills", "test-driven-development", "SKILL.md"), "utf8");
  assert.match(after, /UPDATED/);
});

test("install-skills: --dry-run makes no changes", () => {
  const bridge = mkFakeBridge();
  const oc = mkFakeOpenclawHome();
  const out = execFileSync("node", [installer, "--bridge-root", bridge, "--openclaw-home", oc, "--dry-run"]).toString();
  assert.match(out, /WOULD install/);
  assert.ok(!fs.existsSync(path.join(oc, "skills", "test-driven-development")));
});
