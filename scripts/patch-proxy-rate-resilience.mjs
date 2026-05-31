#!/usr/bin/env node
// Idempotent installer-patcher: adds CLI rate-limit detection, differentiated
// 429 responses, a rate-aware concurrency cap, and restores the subprocess
// event emitter. Ships logic as standalone modules in dist/rate-resilience/
// and injects thin hooks into manager.js + routes.js. Runs LAST in the proxy
// patch chain. Guarded by `@openclaw-bridge:rate-resilience v1`.
// See docs/superpowers/specs/2026-05-31-bridge-resilience-pacing-design.md
//
// Usage: node patch-proxy-rate-resilience.mjs <proxy-root> [--dry-run]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:rate-resilience v1";
const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function die(msg, code = 1) { console.error(`patch-proxy-rate-resilience: ${msg}`); process.exit(code); }

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find((a) => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-rate-resilience.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const distDir = path.join(proxyRoot, "dist");
const managerPath = path.join(distDir, "subprocess", "manager.js");
const routesPath = path.join(distDir, "server", "routes.js");
const modSrcDir = path.join(repoRoot, "rate-resilience");
const modDestDir = path.join(distDir, "rate-resilience");
const MODULES = ["classify.js", "backoff.js", "cap.js", "events.js"];
for (const p of [managerPath, routesPath]) if (!fs.existsSync(p)) die(`expected file not found: ${p}`);

// ---- manager.js edits ----
const MGR_IMPORT = `import { classifyRateLimit } from "../rate-resilience/classify.js";
import { appendBridgeEvent } from "../rate-resilience/events.js";`;

const MGR_CLOSE_ANCHOR = `                // Handle process close
                this.process.on("close", (code) => {`;
const MGR_CLOSE_REPLACE = `                // ${SENTINEL.replace("// ", "")}
                const __obStartedAt = Date.now();
                // Handle process close
                this.process.on("close", (code) => {
                    this.rateLimit = classifyRateLimit(this.stderrTail, code);
                    appendBridgeEvent({ type: this.rateLimit ? "subprocess.rate_limited" : "subprocess.close", code, signal: null, durationMs: Date.now() - __obStartedAt, sawOutput: !!this.__obSawOutput, killed: this.isKilled, subtype: this.rateLimit?.subtype, retryAfterMs: this.rateLimit?.retryAfterMs });`;

const MGR_TIMEOUT_ANCHOR = `                        this.process?.kill("SIGTERM");
                        this.emit("error", new Error(\`Request timed out after \${timeout}ms\`));`;
const MGR_TIMEOUT_REPLACE = `                        this.process?.kill("SIGTERM");
                        appendBridgeEvent({ type: "subprocess.timeout", timeoutMs: timeout });
                        this.emit("error", new Error(\`Request timed out after \${timeout}ms\`));`;

const MGR_SAWOUTPUT_ANCHOR = `                    this.buffer += data;`;
const MGR_SAWOUTPUT_REPLACE = `                    this.__obSawOutput = true;
                    this.buffer += data;`;

// ---- routes.js edits ----
const ROUTES_IMPORT = `import { createRateAwareCap } from "../rate-resilience/cap.js";`;

const ROUTES_CAP_ANCHOR = `function __obAcquire() {
  if (__OB_active < __OB_MAX) { __OB_active++; return Promise.resolve(); }
  return new Promise((resolve) => __OB_waiters.push(() => { __OB_active++; resolve(); }));
}`;
const ROUTES_CAP_REPLACE = `${SENTINEL}
const __obRateCap = createRateAwareCap({ baseMax: __OB_MAX, cooldownMs: 60000 });
globalThis.__OB_TEST_rateCap = __obRateCap;
function __obAcquire() {
  if (__OB_active < __obRateCap.currentMax()) { __OB_active++; return Promise.resolve(); }
  return new Promise((resolve) => __OB_waiters.push(() => { __OB_active++; resolve(); }));
}`;

const ROUTES_CLOSE_ANCHOR = `        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: \`Claude CLI exited with code \${code} without response\`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });`;
const ROUTES_CLOSE_REPLACE = `        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (subprocess.rateLimit && !res.headersSent) {
                // ${SENTINEL.replace("// ", "")}
                __obRateCap.onRateLimited(subprocess.rateLimit.subtype);
                const retryMs = subprocess.rateLimit.retryAfterMs;
                if (typeof retryMs === "number" && retryMs > 0) res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
                res.status(429).json({ error: { type: "rate_limited", code: subprocess.rateLimit.subtype, message: "claude CLI " + subprocess.rateLimit.subtype + " limit" } });
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: \`Claude CLI exited with code \${code} without response\`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });`;

const ROUTES_RELEASE_ANCHOR = `function __obRelease() {
  __OB_active--;
  const next = __OB_waiters.shift();
  if (next) next();
}`;
const ROUTES_RELEASE_REPLACE = `function __obRelease() {
  __OB_active--;
  // ${SENTINEL.replace("// ", "")} — drain only up to the (possibly shrunk) effective max; new arrivals ramp back via __obAcquire's fast path after cooldown
  if (__OB_active < __obRateCap.currentMax()) {
    const next = __OB_waiters.shift();
    if (next) next();
  }
}`;

const ROUTES_STREAM_CLOSE_ANCHOR = `        subprocess.on("close", (code) => { __obStopKeepAlive();
            // Subprocess exited - ensure response is closed`;
const ROUTES_STREAM_CLOSE_REPLACE = `        subprocess.on("close", (code) => { __obStopKeepAlive();
            // ${SENTINEL.replace("// ", "")} — react to rate limits on the streaming path (cannot send 429 after headers, but shrink the cap)
            if (subprocess.rateLimit) __obRateCap.onRateLimited(subprocess.rateLimit.subtype);
            // Subprocess exited - ensure response is closed`;

function patchFile(p, edits) {
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(SENTINEL)) return { changed: false };
  for (const [anchor] of edits) if (!src.includes(anchor)) die(`anchor not found in ${path.basename(p)} — upstream/patch-order changed; update patcher`);
  for (const [anchor, replacement] of edits) src = src.replace(anchor, replacement);
  return { changed: true, src };
}

// manager.js: prepend imports + two body edits
const mgrAlready = fs.readFileSync(managerPath, "utf8").includes(SENTINEL);
const mgr = patchFile(managerPath, [
  [MGR_CLOSE_ANCHOR, MGR_CLOSE_REPLACE],
  [MGR_TIMEOUT_ANCHOR, MGR_TIMEOUT_REPLACE],
  [MGR_SAWOUTPUT_ANCHOR, MGR_SAWOUTPUT_REPLACE],
]);
if (mgr.changed) mgr.src = MGR_IMPORT + "\n" + mgr.src;

const routesAlready = fs.readFileSync(routesPath, "utf8").includes(SENTINEL);
const rt = patchFile(routesPath, [
  [ROUTES_CAP_ANCHOR, ROUTES_CAP_REPLACE],
  [ROUTES_CLOSE_ANCHOR, ROUTES_CLOSE_REPLACE],
  [ROUTES_RELEASE_ANCHOR, ROUTES_RELEASE_REPLACE],
  [ROUTES_STREAM_CLOSE_ANCHOR, ROUTES_STREAM_CLOSE_REPLACE],
]);
if (rt.changed) rt.src = ROUTES_IMPORT + "\n" + rt.src;

if (dryRun) {
  console.log(`patch-proxy-rate-resilience: dry-run against ${proxyRoot}`);
  console.log(`  modules:    ${MODULES.join(", ")} → ${mgrAlready ? "already" : "WOULD copy"}`);
  console.log(`  manager.js: ${mgrAlready ? "already patched" : "WOULD patch"}`);
  console.log(`  routes.js:  ${routesAlready ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

fs.mkdirSync(modDestDir, { recursive: true });
for (const m of MODULES) fs.copyFileSync(path.join(modSrcDir, m), path.join(modDestDir, m));
if (mgr.changed) fs.writeFileSync(managerPath, mgr.src);
if (rt.changed) fs.writeFileSync(routesPath, rt.src);

console.log("patch-proxy-rate-resilience:");
console.log(`  modules:    copied (${MODULES.length})`);
console.log(`  manager.js: ${mgr.changed ? "patched" : "unchanged (already patched)"}`);
console.log(`  routes.js:  ${rt.changed ? "patched" : "unchanged (already patched)"}`);
