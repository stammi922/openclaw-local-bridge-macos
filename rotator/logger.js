// Append a JSONL line per rotation decision. Rotates at 10 MB, keeps 3 gens.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_LOG = path.join(os.homedir(), ".openclaw", "logs", "rotator.log");
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;

let _target = process.env.OPENCLAW_BRIDGE_ROTATOR_LOG || DEFAULT_LOG;
let _enabled = true;

export function setLogPath(p) { _target = p; }
export function getLogPath()  { return _target; }
export function setEnabled(b) { _enabled = b; }

export function log(event) {
  if (!_enabled) return;
  try {
    ensureDir();
    maybeRotate();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFileSync(_target, line);
  } catch {
    // Logging must never break the request path. Swallow.
  }
}

function ensureDir() {
  fs.mkdirSync(path.dirname(_target), { recursive: true });
}

function maybeRotate() {
  let sz;
  try { sz = fs.statSync(_target).size; } catch { return; }
  if (sz < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    const older = `${_target}.${i}`;
    const newer = `${_target}.${i + 1}`;
    if (fs.existsSync(older)) {
      try { fs.renameSync(older, newer); } catch {}
    }
  }
  try { fs.renameSync(_target, `${_target}.1`); } catch {}
}
