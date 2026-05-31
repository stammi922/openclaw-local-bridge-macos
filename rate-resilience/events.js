// rate-resilience/events.js
// Restores the subprocess event emitter that earlier proxy builds wrote to
// OPENCLAW_BRIDGE_EVENT_LOG (regressed by the 2026-05-31 vendor reinstall).
// Append-only JSONL; best-effort, never throws into the request path.
import fs from "node:fs";

export function appendBridgeEvent(obj) {
  try {
    const file = process.env.OPENCLAW_BRIDGE_EVENT_LOG;
    if (!file) return;
    const line = JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n";
    fs.appendFileSync(file, line);
  } catch {
    // best-effort instrumentation; swallow all errors
  }
}
