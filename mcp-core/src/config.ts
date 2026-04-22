import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  stateDir: string;
  gatewayTokenPath: string;
  gatewayToken: string;
  lcmDbPath: string;
}

export function loadConfig(): Config {
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME ?? "", ".openclaw");
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
