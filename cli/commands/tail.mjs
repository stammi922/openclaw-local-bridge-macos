import { spawn } from "node:child_process";
import { logPath } from "./_common.mjs";

export default async function tailCmd() {
  const p = logPath();
  const t = spawn("tail", ["-F", p], { stdio: ["ignore", "pipe", "inherit"] });
  t.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        console.log(`${e.ts || ""}  ${e.event.padEnd(22)}  ${e.label || ""}  ${e.outcome || e.reason || ""}`);
      } catch { console.log(line); }
    }
  });
  process.on("SIGINT", () => { t.kill("SIGTERM"); process.exit(0); });
}
