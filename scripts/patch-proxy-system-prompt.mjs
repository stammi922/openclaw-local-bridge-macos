#!/usr/bin/env node
// Idempotent patcher: makes openclaw fully own the system prompt when
// claude CLI is invoked from the proxy.
//
// Three files patched (one anchor each):
//  1. dist/adapter/openai-to-cli.js — replace openaiToCli() body so it
//     filters role:"system" messages out of messagesToPrompt input and
//     returns them as a separate `systemPrompt` field.
//  2. dist/server/routes.js — forward cliInput.systemPrompt to
//     subprocess.start(prompt, options).
//  3. dist/subprocess/manager.js — add --disable-slash-commands and
//     --setting-sources project to claude argv, plus --system-prompt
//     when options.systemPrompt is set.
//
// Together these strip Claude Code's default system prompt + plugin
// auto-load, leaving openclaw's role:"system" content as Claude CLI's
// actual system prompt.
//
// Sentinel: @openclaw-bridge:systemPrompt v1
//
// Usage: node patch-proxy-system-prompt.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:systemPrompt v1";

// Single anchor: replace whole openaiToCli function body.
const ADAPTER_ANCHOR = `export function openaiToCli(request) {
    return {
        prompt: messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
    };
}`;

const ADAPTER_REPLACEMENT = `${SENTINEL}
export function openaiToCli(request) {
    const _all = request.messages || [];
    const _systemMsgs = _all.filter(m => m.role === "system");
    const _nonSystem = _all.filter(m => m.role !== "system");
    return {
        prompt: messagesToPrompt(_nonSystem),
        systemPrompt: _systemMsgs.map(m => extractContent(m.content)).join("\\n\\n") || undefined,
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
    };
}`;

// Two anchors: routes.js has both a streaming and a non-streaming
// subprocess.start call site, with different formatting. Both must be
// patched or non-streaming requests silently lose the system prompt.
const ROUTES_ANCHOR_STREAMING = `        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        }).catch((err) => {`;

const ROUTES_REPLACEMENT_STREAMING = `        ${SENTINEL}
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
        }).catch((err) => {`;

const ROUTES_ANCHOR_NONSTREAMING = `        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        })
            .catch((error) => {`;

const ROUTES_REPLACEMENT_NONSTREAMING = `        ${SENTINEL}
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
        })
            .catch((error) => {`;

// Single anchor: --no-session-persistence line in buildArgsImpl.
const MANAGER_ANCHOR = `        "--no-session-persistence",`;
const MANAGER_REPLACEMENT = `        "--no-session-persistence",
        ${SENTINEL}
        "--disable-slash-commands",
        "--setting-sources", "project",
        ...(options.systemPrompt ? ["--system-prompt", options.systemPrompt] : []),`;

function die(msg, code = 1) {
  console.error(`patch-proxy-system-prompt: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-system-prompt.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const adapterPath = path.join(proxyRoot, "dist", "adapter", "openai-to-cli.js");
const routesPath  = path.join(proxyRoot, "dist", "server", "routes.js");
const managerPath = path.join(proxyRoot, "dist", "subprocess", "manager.js");
for (const p of [adapterPath, routesPath, managerPath]) {
  if (!fs.existsSync(p)) die(`expected file not found: ${p}`);
}

const adapterOrig = fs.readFileSync(adapterPath, "utf8");
const routesOrig  = fs.readFileSync(routesPath, "utf8");
const managerOrig = fs.readFileSync(managerPath, "utf8");
const adapterPatched = adapterOrig.includes(SENTINEL);
const routesPatched  = routesOrig.includes(SENTINEL);
const managerPatched = managerOrig.includes(SENTINEL);

let adapterUpdated = adapterOrig;
let routesUpdated  = routesOrig;
let managerUpdated = managerOrig;

if (!adapterPatched) {
  // The adapter replacement references extractContent() — bail loudly if
  // patch-adapter.mjs hasn't run first, otherwise post-patch JS is broken.
  if (!adapterOrig.includes("@openclaw-bridge:extractContent v1")) {
    die("openai-to-cli.js missing @openclaw-bridge:extractContent v1 sentinel — run patch-adapter.mjs first");
  }
  if (!adapterOrig.includes(ADAPTER_ANCHOR)) die("openai-to-cli.js openaiToCli anchor changed — upstream bumped");
  adapterUpdated = adapterOrig.replace(ADAPTER_ANCHOR, ADAPTER_REPLACEMENT);
}
if (!routesPatched) {
  if (!routesOrig.includes(ROUTES_ANCHOR_STREAMING)) die("routes.js streaming subprocess.start anchor changed — upstream bumped");
  if (!routesOrig.includes(ROUTES_ANCHOR_NONSTREAMING)) die("routes.js non-streaming subprocess.start anchor changed — upstream bumped");
  routesUpdated = routesOrig
    .replace(ROUTES_ANCHOR_STREAMING, ROUTES_REPLACEMENT_STREAMING)
    .replace(ROUTES_ANCHOR_NONSTREAMING, ROUTES_REPLACEMENT_NONSTREAMING);
}
if (!managerPatched) {
  if (!managerOrig.includes(MANAGER_ANCHOR)) die("manager.js --no-session-persistence anchor changed — upstream bumped");
  managerUpdated = managerOrig.replace(MANAGER_ANCHOR, MANAGER_REPLACEMENT);
}

if (dryRun) {
  console.log(`patch-proxy-system-prompt: dry-run against ${proxyRoot}`);
  console.log(`  openai-to-cli.js : ${adapterPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  routes.js        : ${routesPatched  ? "already patched" : "WOULD patch"}`);
  console.log(`  manager.js       : ${managerPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!adapterPatched) fs.writeFileSync(adapterPath, adapterUpdated);
if (!routesPatched)  fs.writeFileSync(routesPath, routesUpdated);
if (!managerPatched) fs.writeFileSync(managerPath, managerUpdated);

console.log(`patch-proxy-system-prompt:`);
console.log(`  openai-to-cli.js : ${adapterPatched ? "unchanged (already patched)" : "patched"}`);
console.log(`  routes.js        : ${routesPatched  ? "unchanged (already patched)" : "patched"}`);
console.log(`  manager.js       : ${managerPatched ? "unchanged (already patched)" : "patched"}`);
