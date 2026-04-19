#!/usr/bin/env node
// openclaw-bridge tail — pretty-prints the JSONL rotator log, live.

import fs from "node:fs";
import { LOG_PATH } from "./_common.mjs";
import { spawn } from "node:child_process";

if (!fs.existsSync(LOG_PATH)) {
  console.error(`no rotator log yet at ${LOG_PATH} (rotator is idle or in single mode)`);
  process.exit(0);
}

console.log(`tailing ${LOG_PATH}  (Ctrl+C to stop)`);
const t = spawn("tail", ["-n", "20", "-F", LOG_PATH], { stdio: ["ignore", "pipe", "inherit"] });

let buf = "";
t.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const parts = [e.ts, e.event];
      if (e.label) parts.push(`label=${e.label}`);
      if (e.kind) parts.push(`kind=${e.kind}`);
      if (e.outcome) parts.push(`outcome=${e.outcome}`);
      if (e.exitCode != null) parts.push(`exit=${e.exitCode}`);
      if (e.mode) parts.push(`mode=${e.mode}`);
      if (e.model) parts.push(`model=${e.model}`);
      process.stdout.write(parts.join("  ") + "\n");
    } catch {
      process.stdout.write(line + "\n");
    }
  }
});

t.on("close", (code) => process.exit(code ?? 0));
