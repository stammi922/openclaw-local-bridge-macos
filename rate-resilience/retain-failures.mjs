#!/usr/bin/env node
// Appends NEW gateway WARN/ERROR lines and subprocess.timeout/rate_limited
// events into a size-capped retained file. Tracks per-source byte offsets in
// a marker file so each run only appends new content. Best-effort.
import fs from "node:fs";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const src = arg("--src"); const events = arg("--events"); const out = arg("--out"); const mark = arg("--mark");
const MAX_BYTES = Number(arg("--max-bytes", String(20 * 1024 * 1024)));

const marks = (() => { try { return JSON.parse(fs.readFileSync(mark, "utf8")); } catch { return {}; } })();
function newTail(file, key) {
  try {
    const size = fs.statSync(file).size;
    let from = marks[key] || 0;
    if (from > size) from = 0; // file rotated/truncated
    if (from === size) return "";
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    marks[key] = size;
    return buf.toString("utf8");
  } catch { return ""; }
}
const append = [];
for (const line of newTail(src, "src").split("\n")) {
  if (/\bWARN\b|\bERROR\b/.test(line) && line.trim()) append.push(line);
}
for (const line of newTail(events, "events").split("\n")) {
  if (/subprocess\.timeout|subprocess\.rate_limited/.test(line) && line.trim()) append.push(line);
}
if (append.length && out) {
  try {
    // size-capped rotation
    let existing = "";
    try { existing = fs.readFileSync(out, "utf8"); } catch {}
    if (existing.length > MAX_BYTES) {
      try { fs.renameSync(out, out + ".1"); existing = ""; } catch {}
    }
    fs.appendFileSync(out, append.join("\n") + "\n");
  } catch {}
}
try { fs.writeFileSync(mark, JSON.stringify(marks)); } catch {}
