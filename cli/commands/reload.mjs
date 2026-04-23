import { spawnSync } from "node:child_process";

export default async function reloadCmd() {
  const uid = process.getuid ? process.getuid() : 501;
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/ai.claude-max-api-proxy`], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`launchctl kickstart failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
  console.log("Proxy restarted.");
}
