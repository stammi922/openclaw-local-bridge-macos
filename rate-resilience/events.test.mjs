import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendBridgeEvent } from "./events.js";

test("no-op when OPENCLAW_BRIDGE_EVENT_LOG unset (no throw)", () => {
  const prev = process.env.OPENCLAW_BRIDGE_EVENT_LOG;
  delete process.env.OPENCLAW_BRIDGE_EVENT_LOG;
  assert.doesNotThrow(() => appendBridgeEvent({ type: "x" }));
  if (prev !== undefined) process.env.OPENCLAW_BRIDGE_EVENT_LOG = prev;
});

test("appends one JSON line with type + t timestamp", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ev-")), "events.jsonl");
  process.env.OPENCLAW_BRIDGE_EVENT_LOG = f;
  appendBridgeEvent({ type: "subprocess.rate_limited", subtype: "burst" });
  appendBridgeEvent({ type: "subprocess.close", code: 0 });
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const o = JSON.parse(lines[0]);
  assert.equal(o.type, "subprocess.rate_limited");
  assert.equal(o.subtype, "burst");
  assert.ok(typeof o.t === "string" && o.t.endsWith("Z"));
});

test("never throws on bad path", () => {
  process.env.OPENCLAW_BRIDGE_EVENT_LOG = "/nonexistent-dir-xyz/events.jsonl";
  assert.doesNotThrow(() => appendBridgeEvent({ type: "x" }));
});
