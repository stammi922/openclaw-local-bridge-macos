import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, "retain-failures.mjs");

test("appends only new WARN/ERROR + rate/timeout events, tracks offset", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ret-"));
  const src = path.join(d, "src.log"); const ev = path.join(d, "events.jsonl");
  const out = path.join(d, "bridge-failures.jsonl"); const mark = path.join(d, ".mark");
  fs.writeFileSync(src, 'INFO ok\nWARN stalled session\nERROR boom\n');
  fs.writeFileSync(ev, '{"type":"subprocess.close","code":0}\n{"type":"subprocess.timeout","timeoutMs":7200000}\n{"type":"subprocess.rate_limited","subtype":"burst"}\n');
  execFileSync("node", [script, "--src", src, "--events", ev, "--out", out, "--mark", mark]);
  let lines = fs.readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.filter((l) => l.includes("WARN") || l.includes("ERROR")).length, 2);
  assert.equal(lines.filter((l) => l.includes("subprocess.timeout") || l.includes("rate_limited")).length, 2);
  assert.ok(!lines.some((l) => l.includes('"code":0')), "plain close not retained");
  // second run with no new input appends nothing
  const before = fs.readFileSync(out, "utf8");
  execFileSync("node", [script, "--src", src, "--events", ev, "--out", out, "--mark", mark]);
  assert.equal(fs.readFileSync(out, "utf8"), before, "idempotent on no new lines");
});
