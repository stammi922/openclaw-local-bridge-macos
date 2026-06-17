#!/usr/bin/env node
// Idempotent patcher: makes the proxy forward image/file attachments to the
// Claude CLI instead of silently dropping them.
//
// Background: the OpenAI-compatible adapter flattens every message to a TEXT
// prompt (extractContent keeps only type:"text" parts), so image_url / file
// parts vanished before Claude ever saw them — inbound Mattermost/webchat
// images produced "I can't see images via the API". This patch routes real
// media through to the CLI via its stream-json input format.
//
// Three files patched (depends on patch-proxy-system-prompt having run first,
// because the adapter anchors reference its `_nonSystem` binding):
//  1. dist/adapter/openai-to-cli.js — add parseDataUrl/mediaBlockFromUrl/
//     extractMediaBlocks(); return a `mediaBlocks` array of Anthropic content
//     blocks (image/* -> image, application/pdf -> document, http(s) -> url,
//     other -> text note).
//  2. dist/subprocess/manager.js — when mediaBlocks are present, switch argv to
//     `--input-format stream-json` (dropping the positional text prompt) and
//     write a {type:"user", message:{role:"user", content:[text, ...blocks]}}
//     envelope to the CLI's stdin.
//  3. dist/server/routes.js — thread cliInput.mediaBlocks into both the
//     streaming and non-streaming subprocess.start() option objects.
//
// Sentinel: @openclaw-bridge:media-passthrough v1
//
// Usage: node patch-proxy-media-passthrough.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:media-passthrough v1";

// ---- adapter (openai-to-cli.js) -------------------------------------------
// Edit 1: insert the media helpers immediately before messagesToPrompt().
const ADAPTER_HELPERS_ANCHOR = `export function messagesToPrompt(messages) {`;
const ADAPTER_HELPERS_REPLACEMENT = `${SENTINEL}
// Parse a data: URL into { mime, isBase64, data }. Returns null if not a data URL.
function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;[^,]*)?,([\\s\\S]*)$/.exec(url || "");
  if (!m) return null;
  return {
    mime: m[1] || "application/octet-stream",
    isBase64: (m[2] || "").includes("base64"),
    data: m[3] || "",
  };
}

${SENTINEL}
// Convert one OpenAI image_url / file URL into an Anthropic content block.
// Routes by MIME: image/* -> image block, application/pdf -> document block,
// other binaries -> a text note so the model is at least aware. http(s) URLs are
// passed through as a url image source.
function mediaBlockFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  if (/^https?:\\/\\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  const parsed = parseDataUrl(url);
  if (!parsed || !parsed.isBase64) return null;
  const { mime, data } = parsed;
  if (mime.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: mime, data } };
  }
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  return { type: "text", text: \`[attachment: \${mime} — not inlined by proxy]\` };
}

${SENTINEL}
// Collect non-text content parts (images/files) from non-system messages and
// convert them to Anthropic content blocks for the Claude CLI stream-json input.
export function extractMediaBlocks(messages) {
  const blocks = [];
  for (const msg of messages || []) {
    if (!msg || msg.role === "system") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || part.type === "text") continue;
      let url;
      if (part.type === "image_url") {
        url = part.image_url && part.image_url.url;
      } else if (part.type === "file" || part.type === "input_file") {
        url = part.file && (part.file.file_data || part.file.url);
      }
      const block = mediaBlockFromUrl(url);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

export function messagesToPrompt(messages) {`;

// Edit 2: compute _mediaBlocks alongside _nonSystem (added by system-prompt patch).
const ADAPTER_VAR_ANCHOR = `    const _nonSystem = _all.filter(m => m.role !== "system");
    return {`;
const ADAPTER_VAR_REPLACEMENT = `    const _nonSystem = _all.filter(m => m.role !== "system");
    ${SENTINEL}
    const _mediaBlocks = extractMediaBlocks(_nonSystem);
    return {`;

// Edit 3: surface mediaBlocks on the returned object.
const ADAPTER_FIELD_ANCHOR = `        sessionId: request.user, // Use OpenAI's user field for session mapping
    };`;
const ADAPTER_FIELD_REPLACEMENT = `        sessionId: request.user, // Use OpenAI's user field for session mapping
        ${SENTINEL} — Anthropic content blocks for images/files
        mediaBlocks: _mediaBlocks.length > 0 ? _mediaBlocks : undefined,
    };`;

// ---- subprocess (manager.js) ----------------------------------------------
// Edit 1: derive useStreamJson before assembling argv.
const MANAGER_FLAG_ANCHOR = `    const mcp = mcpConfigPath();
    const args = [`;
const MANAGER_FLAG_REPLACEMENT = `    const mcp = mcpConfigPath();
    ${SENTINEL} — when media blocks are present, feed a
    // stream-json user message over stdin (carries real image/document content blocks)
    // instead of passing the prompt as a positional text argument.
    const useStreamJson = Array.isArray(options.mediaBlocks) && options.mediaBlocks.length > 0;
    const args = [`;

// Edit 2: replace the positional prompt with the stream-json input flag when media present.
const MANAGER_ARGV_ANCHOR = `        prompt,
    ];`;
const MANAGER_ARGV_REPLACEMENT = `        ${SENTINEL}
        ...(useStreamJson ? ["--input-format", "stream-json"] : [prompt]),
    ];`;

// Edit 3: write the stream-json user envelope to stdin when media present.
const MANAGER_STDIN_ANCHOR = `                // Close stdin since we pass prompt as argument
                this.process.stdin?.end();`;
const MANAGER_STDIN_REPLACEMENT = `                ${SENTINEL} — when media blocks are present we
                // pass a stream-json user message (text + image/document blocks) over stdin
                // instead of the positional text prompt that buildArgs omits in this mode.
                const __obMediaBlocks = Array.isArray(options.mediaBlocks) ? options.mediaBlocks : null;
                if (__obMediaBlocks && __obMediaBlocks.length > 0) {
                    const __obUserMsg = {
                        type: "user",
                        message: {
                            role: "user",
                            content: [
                                ...(typeof prompt === "string" && prompt.length > 0 ? [{ type: "text", text: prompt }] : []),
                                ...__obMediaBlocks,
                            ],
                        },
                    };
                    try { this.process.stdin?.write(JSON.stringify(__obUserMsg) + "\\n"); }
                    catch (e) { if (process.env.OPENCLAW_BRIDGE_DEBUG === "1") console.error("[Subprocess] stdin write failed:", e); }
                    this.process.stdin?.end();
                }
                else {
                    // Close stdin since we pass prompt as argument
                    this.process.stdin?.end();
                }`;

// ---- routes (routes.js) ----------------------------------------------------
// Two call sites; both forward cliInput.mediaBlocks (after system-prompt patch
// added the systemPrompt line each).
const ROUTES_STREAMING_ANCHOR = `            systemPrompt: cliInput.systemPrompt,
        }).catch((err) => {`;
const ROUTES_STREAMING_REPLACEMENT = `            systemPrompt: cliInput.systemPrompt,
            ${SENTINEL}
            mediaBlocks: cliInput.mediaBlocks,
        }).catch((err) => {`;

const ROUTES_NONSTREAMING_ANCHOR = `            systemPrompt: cliInput.systemPrompt,
        })
            .catch((error) => {`;
const ROUTES_NONSTREAMING_REPLACEMENT = `            systemPrompt: cliInput.systemPrompt,
            ${SENTINEL}
            mediaBlocks: cliInput.mediaBlocks,
        })
            .catch((error) => {`;

function die(msg, code = 1) {
  console.error(`patch-proxy-media-passthrough: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-media-passthrough.mjs <proxy-root> [--dry-run]", 2);
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
  // Edits 2 & 3 reference `_nonSystem`, introduced by patch-proxy-system-prompt.
  if (!adapterOrig.includes("@openclaw-bridge:systemPrompt v1")) {
    die("openai-to-cli.js missing @openclaw-bridge:systemPrompt v1 — run patch-proxy-system-prompt.mjs first");
  }
  for (const [name, anchor] of [
    ["helpers", ADAPTER_HELPERS_ANCHOR],
    ["mediaBlocks var", ADAPTER_VAR_ANCHOR],
    ["mediaBlocks field", ADAPTER_FIELD_ANCHOR],
  ]) {
    if (!adapterUpdated.includes(anchor)) die(`openai-to-cli.js ${name} anchor changed — upstream bumped`);
  }
  adapterUpdated = adapterUpdated
    .replace(ADAPTER_HELPERS_ANCHOR, ADAPTER_HELPERS_REPLACEMENT)
    .replace(ADAPTER_VAR_ANCHOR, ADAPTER_VAR_REPLACEMENT)
    .replace(ADAPTER_FIELD_ANCHOR, ADAPTER_FIELD_REPLACEMENT);
}
if (!managerPatched) {
  for (const [name, anchor] of [
    ["useStreamJson flag", MANAGER_FLAG_ANCHOR],
    ["argv prompt", MANAGER_ARGV_ANCHOR],
    ["stdin close", MANAGER_STDIN_ANCHOR],
  ]) {
    if (!managerUpdated.includes(anchor)) die(`manager.js ${name} anchor changed — upstream bumped`);
  }
  managerUpdated = managerUpdated
    .replace(MANAGER_FLAG_ANCHOR, MANAGER_FLAG_REPLACEMENT)
    .replace(MANAGER_ARGV_ANCHOR, MANAGER_ARGV_REPLACEMENT)
    .replace(MANAGER_STDIN_ANCHOR, MANAGER_STDIN_REPLACEMENT);
}
if (!routesPatched) {
  if (!routesOrig.includes("@openclaw-bridge:systemPrompt v1")) {
    die("routes.js missing @openclaw-bridge:systemPrompt v1 — run patch-proxy-system-prompt.mjs first");
  }
  if (!routesUpdated.includes(ROUTES_STREAMING_ANCHOR)) die("routes.js streaming anchor changed — upstream bumped");
  if (!routesUpdated.includes(ROUTES_NONSTREAMING_ANCHOR)) die("routes.js non-streaming anchor changed — upstream bumped");
  routesUpdated = routesUpdated
    .replace(ROUTES_STREAMING_ANCHOR, ROUTES_STREAMING_REPLACEMENT)
    .replace(ROUTES_NONSTREAMING_ANCHOR, ROUTES_NONSTREAMING_REPLACEMENT);
}

if (dryRun) {
  console.log(`patch-proxy-media-passthrough: dry-run against ${proxyRoot}`);
  console.log(`  openai-to-cli.js : ${adapterPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  manager.js       : ${managerPatched ? "already patched" : "WOULD patch"}`);
  console.log(`  routes.js        : ${routesPatched  ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!adapterPatched) fs.writeFileSync(adapterPath, adapterUpdated);
if (!managerPatched) fs.writeFileSync(managerPath, managerUpdated);
if (!routesPatched)  fs.writeFileSync(routesPath, routesUpdated);

console.log(`patch-proxy-media-passthrough:`);
console.log(`  openai-to-cli.js : ${adapterPatched ? "unchanged (already patched)" : "patched"}`);
console.log(`  manager.js       : ${managerPatched ? "unchanged (already patched)" : "patched"}`);
console.log(`  routes.js        : ${routesPatched  ? "unchanged (already patched)" : "patched"}`);
