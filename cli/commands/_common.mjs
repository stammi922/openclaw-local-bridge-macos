import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const RISK_PHRASE = "I accept the risk";

export function bridgeDir() {
  return process.env.OPENCLAW_BRIDGE_ACCOUNTS_DIR
    || path.join(os.homedir(), ".openclaw", "bridge");
}

export function logPath() {
  return process.env.OPENCLAW_BRIDGE_ROTATOR_LOG
    || path.join(os.homedir(), ".openclaw", "logs", "rotator.log");
}

export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return fallback; }
}

export function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function printRiskBanner() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                    MULTI-ACCOUNT ROTATOR — RISK                    ║
╠════════════════════════════════════════════════════════════════════╣
║ Pooling multiple Claude Max accounts may be treated by Anthropic   ║
║ as abuse of the Services. Detection can cause SIMULTANEOUS         ║
║ TERMINATION of every account in the pool.                          ║
║ See docs/MULTI_ACCOUNT.md for the full risk breakdown.             ║
╚════════════════════════════════════════════════════════════════════╝
`);
}

export async function requireRiskPhrase(prompt = `Type exactly:  ${RISK_PHRASE}\n> `) {
  printRiskBanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(prompt, resolve));
  rl.close();
  if (answer.trim() !== RISK_PHRASE) {
    console.error(`Aborted: phrase did not match "${RISK_PHRASE}".`);
    process.exit(1);
  }
}

export function validateLabel(label) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(label)) {
    console.error(`Invalid label "${label}" — must match [a-z0-9][a-z0-9_-]{0,31}`);
    process.exit(2);
  }
}
