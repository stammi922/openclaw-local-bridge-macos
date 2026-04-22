import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  stateDir: string;
  gatewayTokenPath: string;
  gatewayToken: string;
  lcmDbPath: string;
}

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR || join(process.env.HOME ?? "", ".openclaw");
}

/**
 * Resolve the lcm.db path from state dir alone — does NOT require the
 * gateway token. Used by read-only sqlite fallbacks where the CLI is
 * unavailable (which is often exactly when the token is missing).
 */
export function resolveLcmDbPath(): string {
  return join(resolveStateDir(), "lcm.db");
}

export function loadConfig(): Config {
  const stateDir = resolveStateDir();
  const gatewayTokenPath = join(stateDir, "gateway-token");
  if (!existsSync(gatewayTokenPath)) {
    throw new Error(`gateway token not found at ${gatewayTokenPath}; is OpenClaw running?`);
  }
  const gatewayToken = readFileSync(gatewayTokenPath, "utf8").trim();
  if (!gatewayToken) {
    throw new Error(`gateway token file at ${gatewayTokenPath} is empty`);
  }
  return {
    stateDir,
    gatewayTokenPath,
    gatewayToken,
    lcmDbPath: join(stateDir, "lcm.db"),
  };
}
