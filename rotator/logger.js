import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_GENERATIONS = 3;

let _logPath = null;

function resolveLogPath() {
  if (_logPath) return _logPath;
  return process.env.OPENCLAW_BRIDGE_ROTATOR_LOG
    || path.join(os.homedir(), ".openclaw", "logs", "rotator.log");
}

export function _setLogPathForTests(p) {
  _logPath = p;
}

function rotate(p) {
  // Shift: .2 → .3, .1 → .2, current → .1
  for (let i = MAX_GENERATIONS; i >= 1; i--) {
    const src = i === 1 ? p : `${p}.${i - 1}`;
    const dst = `${p}.${i}`;
    try {
      if (fs.existsSync(src)) {
        if (i === MAX_GENERATIONS && fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      }
    } catch {
      // best-effort; if rotation fails we continue and let append fail silently
    }
  }
}

export function log(obj) {
  const p = resolveLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_SIZE) rotate(p);
    } catch {
      // file doesn't exist yet — that's fine
    }
    const entry = { ts: new Date().toISOString(), ...obj };
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch (err) {
    try { console.error("[rotator.log] failed:", err?.message || err); } catch {}
  }
}
