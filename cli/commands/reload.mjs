#!/usr/bin/env node
// openclaw-bridge reload — kickstarts the proxy so live accounts.json changes
// take effect immediately (otherwise the rotator's 1-second cache picks them
// up within a second anyway, but operators want a hard trigger sometimes).

import { spawnSync } from "node:child_process";

const uid = process.getuid();
const target = `gui/${uid}/ai.claude-max-api-proxy`;

const out = spawnSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
if (out.status !== 0) {
  console.error(`launchctl kickstart ${target} failed with exit ${out.status}.`);
  process.exit(out.status ?? 1);
}
console.log(`reloaded ${target}`);
