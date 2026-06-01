#!/usr/bin/env node
// Adds an idle-timeout to the proxy subprocess: resets on each stdout/stderr
// chunk (~40min default), alongside the existing absolute 2h wall cap.
// Supersedes the abandoned af1b6a6 (orphan path). See docs/PROXY-LEARNINGS.md.
import fs from "node:fs";
import path from "node:path";

const SENTINEL = "@openclaw-bridge:idle-timeout v1";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.env.PROXY_HOME;
if (!root) { console.error("missing --root or PROXY_HOME"); process.exit(2); }
const file = path.join(root, "dist/subprocess/manager.js");
let src;
try { src = fs.readFileSync(file, "utf8"); } catch (e) { console.error("cannot read", file, e.message); process.exit(2); }

if (src.includes(SENTINEL)) { console.log("[idle-timeout] already patched"); process.exit(0); }

function replaceOrDie(s, anchor, replacement, label) {
  if (!s.includes(anchor)) { console.error(`[idle-timeout] anchor MISSING (${label}) — upstream moved; aborting`); process.exit(1); }
  return s.replace(anchor, replacement);
}

const ANCHOR_ARM = `                }, timeout);`;
const ARM = `                }, timeout);
                // ${SENTINEL}
                const __obIdleMs = parseInt(process.env.OPENCLAW_BRIDGE_IDLE_TIMEOUT_MS || "2400000", 10); // 40min
                this.__obResetIdle = () => {
                    if (this.idleTimeoutId) clearTimeout(this.idleTimeoutId);
                    this.idleTimeoutId = setTimeout(() => {
                        if (!this.isKilled) {
                            this.isKilled = true;
                            this.process?.kill("SIGTERM");
                            appendBridgeEvent({ type: "subprocess.idle_timeout", idleMs: __obIdleMs });
                            this.emit("error", new Error(\`Request idle for \${__obIdleMs}ms (no output)\`));
                        }
                    }, __obIdleMs);
                };
                this.__obResetIdle();`;

const ANCHOR_STDOUT = `                this.process.stdout?.on("data", (chunk) => {`;
const STDOUT = `                this.process.stdout?.on("data", (chunk) => {
                    this.__obResetIdle?.(); // ${SENTINEL}`;

const ANCHOR_STDERR = `                this.process.stderr?.on("data", (chunk) => {`;
const STDERR = `                this.process.stderr?.on("data", (chunk) => {
                    this.__obResetIdle?.(); // ${SENTINEL}`;

const ANCHOR_CLEAR = `    clearTimeout() {`;
const CLEAR = `    clearTimeout() {
        // ${SENTINEL}
        if (this.idleTimeoutId) { clearTimeout(this.idleTimeoutId); this.idleTimeoutId = null; }`;

let out = src;
out = replaceOrDie(out, ANCHOR_ARM, ARM, "arm");
out = replaceOrDie(out, ANCHOR_STDOUT, STDOUT, "stdout-reset");
out = replaceOrDie(out, ANCHOR_STDERR, STDERR, "stderr-reset");
out = replaceOrDie(out, ANCHOR_CLEAR, CLEAR, "clearTimeout");

if (dryRun) { console.log("[idle-timeout] dry-run: would patch", file); process.exit(0); }
fs.writeFileSync(file, out);
console.log("[idle-timeout] patched", file);
