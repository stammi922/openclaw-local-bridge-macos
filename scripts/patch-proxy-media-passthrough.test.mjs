import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const patcher = path.join(repoRoot, "scripts", "patch-proxy-media-passthrough.mjs");
const fxDir = path.join(repoRoot, "test", "fixtures", "media-passthrough");
const managerFixture = path.join(fxDir, "manager.pre.js");
const adapterFixture = path.join(fxDir, "openai-to-cli.pre.js");
const routesFixture  = path.join(fxDir, "routes.pre.js");

function mkFakeProxy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "patch-media-"));
  fs.mkdirSync(path.join(d, "dist", "subprocess"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "adapter"), { recursive: true });
  fs.mkdirSync(path.join(d, "dist", "server"), { recursive: true });
  fs.copyFileSync(managerFixture, path.join(d, "dist", "subprocess", "manager.js"));
  fs.copyFileSync(adapterFixture, path.join(d, "dist", "adapter", "openai-to-cli.js"));
  fs.copyFileSync(routesFixture,  path.join(d, "dist", "server", "routes.js"));
  return d;
}

function read(d, rel) { return fs.readFileSync(path.join(d, "dist", rel), "utf8"); }

test("patch-proxy-media-passthrough: fresh patch wires images/files through all 3 files", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const adapter = read(d, "adapter/openai-to-cli.js");
  const manager = read(d, "subprocess/manager.js");
  const routes  = read(d, "server/routes.js");

  // sentinels
  assert.ok(adapter.includes("@openclaw-bridge:media-passthrough v1"), "adapter sentinel");
  assert.ok(manager.includes("@openclaw-bridge:media-passthrough v1"), "manager sentinel");
  assert.ok(routes.includes("@openclaw-bridge:media-passthrough v1"),  "routes sentinel");

  // adapter: extraction + returned field
  assert.ok(adapter.includes("export function extractMediaBlocks"), "adapter exports extractMediaBlocks");
  assert.ok(adapter.includes("mediaBlocks: _mediaBlocks.length > 0 ? _mediaBlocks : undefined"), "adapter returns mediaBlocks");
  assert.ok(adapter.includes('media_type: "application/pdf"'), "adapter maps pdf -> document block");

  // manager: stream-json argv switch + stdin envelope
  assert.ok(manager.includes("const useStreamJson = Array.isArray(options.mediaBlocks)"), "manager derives useStreamJson");
  assert.ok(manager.includes('useStreamJson ? ["--input-format", "stream-json"] : [prompt]'), "manager swaps positional prompt for stream-json");
  assert.ok(manager.includes('JSON.stringify(__obUserMsg)'), "manager writes user envelope to stdin");
  assert.ok(manager.includes('"--no-session-persistence"'), "manager base argv preserved");

  // routes: BOTH call sites forward mediaBlocks
  const routesMatches = (routes.match(/mediaBlocks: cliInput\.mediaBlocks/g) || []).length;
  assert.equal(routesMatches, 2, `routes forwards cliInput.mediaBlocks at both call sites (saw ${routesMatches})`);

  // patched files must stay valid JS
  for (const rel of ["adapter/openai-to-cli.js", "subprocess/manager.js", "server/routes.js"]) {
    execFileSync("node", ["--check", path.join(d, "dist", rel)]);
  }
});

test("patch-proxy-media-passthrough: re-run is byte-identical (idempotent)", () => {
  const d = mkFakeProxy();
  execFileSync("node", [patcher, d]);
  const a1 = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const m1 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const r1 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  execFileSync("node", [patcher, d]);
  const a2 = fs.readFileSync(path.join(d, "dist", "adapter", "openai-to-cli.js"));
  const m2 = fs.readFileSync(path.join(d, "dist", "subprocess", "manager.js"));
  const r2 = fs.readFileSync(path.join(d, "dist", "server", "routes.js"));
  assert.ok(a1.equals(a2), "openai-to-cli.js byte-identical");
  assert.ok(m1.equals(m2), "manager.js byte-identical");
  assert.ok(r1.equals(r2), "routes.js byte-identical");
});

test("patch-proxy-media-passthrough: refuses if system-prompt patch hasn't run", () => {
  const d = mkFakeProxy();
  // strip the system-prompt sentinel from the adapter to simulate wrong ordering
  const p = path.join(d, "dist", "adapter", "openai-to-cli.js");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("@openclaw-bridge:systemPrompt v1", "x"));
  assert.throws(() => execFileSync("node", [patcher, d], { stdio: "pipe" }), /system-prompt/);
});
