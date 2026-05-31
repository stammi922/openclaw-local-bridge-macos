#!/usr/bin/env node
// Idempotent installer-patcher: makes the claude-max-api-proxy HTTP server
// retry binding its port instead of exiting on the first EADDRINUSE. On
// launchd-driven restarts a slow-releasing previous instance can still hold
// :3460 for a moment; upstream's startServer() rejects immediately, standalone.js
// catches and process.exit(1)s, and launchd KeepAlive relaunches — producing the
// EADDRINUSE crash-loop observed 2026-05-31 (~6888 startup banners vs 146
// "Server ready" in claude-max-api-proxy.log). See project_bridge_debug_20260531
// memory and docs/PROXY-LEARNINGS.md. Guarded by `@openclaw-bridge:eaddrinuse-retry v1`.
//
// Usage: node patch-proxy-eaddrinuse.mjs <proxy-install-root> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTINEL = "// @openclaw-bridge:eaddrinuse-retry v1";

// Exact upstream block inside startServer() (4-space indent, dist build).
const ANCHOR = `    return new Promise((resolve, reject) => {
        serverInstance = createServer(app);
        serverInstance.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                reject(new Error(\`Port \${port} is already in use\`));
            }
            else {
                reject(err);
            }
        });
        serverInstance.listen(port, host, () => {
            console.log(\`[Server] Claude Code CLI provider running at http://\${host}:\${port}\`);
            console.log(\`[Server] OpenAI-compatible endpoint: http://\${host}:\${port}/v1/chat/completions\`);
            resolve(serverInstance);
        });
    });`;

const REPLACEMENT = `    ${SENTINEL}
    // On launchd-driven restarts a slow-releasing previous instance can still
    // hold the port for a moment. Retry the bind with backoff so we ride out
    // that race instead of exiting and relying on KeepAlive churn (which
    // historically produced an EADDRINUSE restart-loop).
    const maxAttempts = 10;
    const retryDelayMs = 1000;
    const attemptListen = () => new Promise((resolve, reject) => {
        const server = createServer(app);
        const onError = (err) => {
            server.removeListener("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            // Keep an error handler attached so post-startup errors don't crash
            // the process as an unhandled 'error' event.
            server.on("error", (err) => console.error("[Server] runtime error:", err));
            serverInstance = server;
            console.log(\`[Server] Claude Code CLI provider running at http://\${host}:\${port}\`);
            console.log(\`[Server] OpenAI-compatible endpoint: http://\${host}:\${port}/v1/chat/completions\`);
            resolve(server);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
    });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await attemptListen();
        }
        catch (err) {
            if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
                console.log(\`[Server] Port \${port} in use (attempt \${attempt}/\${maxAttempts}); retrying in \${retryDelayMs}ms…\`);
                await new Promise((r) => setTimeout(r, retryDelayMs));
                continue;
            }
            if (err.code === "EADDRINUSE") {
                throw new Error(\`Port \${port} is already in use after \${maxAttempts} attempts\`);
            }
            throw err;
        }
    }`;

function die(msg, code = 1) {
  console.error(`patch-proxy-eaddrinuse: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const proxyRoot = args.find(a => !a.startsWith("--"));
if (!proxyRoot) die("usage: patch-proxy-eaddrinuse.mjs <proxy-root> [--dry-run]", 2);
if (!fs.existsSync(proxyRoot)) die(`proxy root not found: ${proxyRoot}`);

const indexPath = path.join(proxyRoot, "dist", "server", "index.js");
if (!fs.existsSync(indexPath)) die(`expected file not found: ${indexPath}`);

const orig = fs.readFileSync(indexPath, "utf8");
const alreadyPatched = orig.includes(SENTINEL);

let updated = orig;
if (!alreadyPatched) {
  if (!orig.includes(ANCHOR)) die("index.js startServer() bind block changed — upstream moved; update patch-proxy-eaddrinuse.mjs");
  updated = orig.replace(ANCHOR, REPLACEMENT);
}

if (dryRun) {
  console.log(`patch-proxy-eaddrinuse: dry-run against ${proxyRoot}`);
  console.log(`  index.js: ${alreadyPatched ? "already patched" : "WOULD patch"}`);
  process.exit(0);
}

if (!alreadyPatched) fs.writeFileSync(indexPath, updated);

console.log(`patch-proxy-eaddrinuse:`);
console.log(`  index.js: ${alreadyPatched ? "unchanged (already patched)" : "patched"}`);
