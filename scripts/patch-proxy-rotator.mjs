#!/usr/bin/env node
// Installs the multi-account rotator into an installed claude-max-api-proxy tree:
//   1. Copies this repo's rotator/*.js into <proxy>/dist/rotator/
//   2. Patches dist/server/routes.js so handleChatCompletions calls
//      rotator.prepare(body) before spawn and rotator.complete(ctx, ...) on close.
//   3. Patches dist/subprocess/manager.js so the spawn env merges
//      this.envOverrides (set by routes.js from rotator.prepare's result).
//
// Idempotent: re-runs are no-ops thanks to sentinel comments.
// Backward-compatible: when accounts.json.mode !== "multi", rotator.prepare()
// returns { env: {}, label: null } so the spawn env is unchanged.
//
// Usage:
//   node patch-proxy-rotator.mjs <proxy-install-root> [--dry-run]
//
// <proxy-install-root> is typically "$HOME/.openclaw/bridge/claude-max-api-proxy".

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:rotator v1";
const SENTINEL_END = "// @openclaw-bridge:rotator-end v1";

const ROUTES_ANCHOR = `        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();`;

const ROUTES_REPLACEMENT = `        const cliInput = openaiToCli(body);
        ${SENTINEL}
        const { prepare: __rotatorPrepare, complete: __rotatorComplete } = await import("../rotator/index.js");
        const __rotatorCtx = await __rotatorPrepare(body);
        const subprocess = new ClaudeSubprocess();
        subprocess.envOverrides = __rotatorCtx.env;
        subprocess.once("close", (__code) => {
            __rotatorComplete(__rotatorCtx, { exitCode: __code, stderrTail: subprocess.stderrTail });
        });
        ${SENTINEL_END}`;

const MANAGER_ENV_FROM = `                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });`;

const MANAGER_ENV_TO = `                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    ${SENTINEL}
                    env: { ...process.env, ...(this.envOverrides || {}) },
                    stdio: ["pipe", "pipe", "pipe"],
                });`;

const MANAGER_STDERR_FROM = `                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });`;

const MANAGER_STDERR_TO = `                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        ${SENTINEL}
                        this.stderrTail = ((this.stderrTail || "") + errorText + "\\n").slice(-4096);
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });`;

const ROTATOR_FILES = [
  "index.js",
  "pool.js",
  "policy.js",
  "detector.js",
  "classify.js",
  "logger.js",
];

function die(msg, code = 1) {
  console.error(`patch-proxy-rotator: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find((a) => !a.startsWith("--"));

if (!proxyRoot) {
  die("usage: patch-proxy-rotator.mjs <proxy-install-root> [--dry-run]", 2);
}
if (!fs.existsSync(proxyRoot)) {
  die(`proxy root not found: ${proxyRoot}`);
}

const distDir = path.join(proxyRoot, "dist");
const routesPath = path.join(distDir, "server", "routes.js");
const managerPath = path.join(distDir, "subprocess", "manager.js");
const rotatorDestDir = path.join(distDir, "rotator");

for (const p of [routesPath, managerPath]) {
  if (!fs.existsSync(p)) die(`expected file not found: ${p}`);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const rotatorSrcDir = path.join(repoRoot, "rotator");
if (!fs.existsSync(rotatorSrcDir)) die(`rotator/ source not found: ${rotatorSrcDir}`);

// ---- 1. Build the planned file-copy set ----
const copyPlan = ROTATOR_FILES.map((f) => {
  const src = path.join(rotatorSrcDir, f);
  const dest = path.join(rotatorDestDir, f);
  if (!fs.existsSync(src)) die(`missing rotator source: ${src}`);
  return { src, dest };
});

// ---- 2. Plan source patches ----
const routesOrig = fs.readFileSync(routesPath, "utf8");
const managerOrig = fs.readFileSync(managerPath, "utf8");

let routesUpdated = routesOrig;
let managerUpdated = managerOrig;

const routesAlreadyPatched = routesOrig.includes(SENTINEL);
const managerAlreadyPatched = managerOrig.includes(SENTINEL);

if (!routesAlreadyPatched) {
  if (!routesOrig.includes(ROUTES_ANCHOR)) {
    die(`routes.js anchor not found — upstream shape changed.\nLooking for:\n${ROUTES_ANCHOR}`);
  }
  routesUpdated = routesOrig.replace(ROUTES_ANCHOR, ROUTES_REPLACEMENT);
}

if (!managerAlreadyPatched) {
  if (!managerOrig.includes(MANAGER_ENV_FROM)) {
    die(`manager.js env anchor not found — upstream shape changed.`);
  }
  if (!managerOrig.includes(MANAGER_STDERR_FROM)) {
    die(`manager.js stderr anchor not found — upstream shape changed.`);
  }
  managerUpdated = managerOrig
    .replace(MANAGER_ENV_FROM, MANAGER_ENV_TO)
    .replace(MANAGER_STDERR_FROM, MANAGER_STDERR_TO);
}

// ---- 3. Dry-run report ----
if (dryRun) {
  console.log(`patch-proxy-rotator: dry-run against ${proxyRoot}`);
  console.log(`  routes.js : ${routesAlreadyPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  manager.js: ${managerAlreadyPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  rotator/  : WOULD copy ${copyPlan.length} files → ${rotatorDestDir}`);
  process.exit(0);
}

// ---- 4. Apply file copies ----
fs.mkdirSync(rotatorDestDir, { recursive: true });
for (const { src, dest } of copyPlan) {
  fs.copyFileSync(src, dest);
}

// ---- 5. Apply patches ----
if (!routesAlreadyPatched) fs.writeFileSync(routesPath, routesUpdated);
if (!managerAlreadyPatched) fs.writeFileSync(managerPath, managerUpdated);

console.log(`patch-proxy-rotator: rotator installed at ${rotatorDestDir}`);
console.log(`  routes.js : ${routesAlreadyPatched ? "unchanged (already patched)" : "patched"}`);
console.log(`  manager.js: ${managerAlreadyPatched ? "unchanged (already patched)" : "patched"}`);
