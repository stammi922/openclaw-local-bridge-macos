import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  stateDir: string;
  gatewayTokenPath: string;
  /**
   * Gateway token if we managed to read one, otherwise undefined. None of the
   * tool handlers actually need it today — they all shell out to the
   * `openclaw` CLI which picks up its own auth — but we still surface it so
   * future HTTP-direct callers can opt in without another file-read dance.
   */
  gatewayToken: string | undefined;
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
  let gatewayToken: string | undefined;
  if (existsSync(gatewayTokenPath)) {
    const raw = readFileSync(gatewayTokenPath, "utf8").trim();
    if (raw) gatewayToken = raw;
  }
  return {
    stateDir,
    gatewayTokenPath,
    gatewayToken,
    lcmDbPath: join(stateDir, "lcm.db"),
  };
}
