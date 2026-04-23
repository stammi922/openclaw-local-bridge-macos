import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, _setLogPathForTests } from "../logger.js";

function mkTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotator-log-"));
  const p = path.join(dir, "rotator.log");
  _setLogPathForTests(p);
  return { dir, p };
}

test("log: appends one JSON line per call", () => {
  const { p } = mkTempLog();
  log({ event: "a" });
  log({ event: "b", x: 1 });
  const content = fs.readFileSync(p, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { event: "a", ts: JSON.parse(lines[0]).ts });
  assert.equal(JSON.parse(lines[1]).x, 1);
  assert.match(JSON.parse(lines[0]).ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("log: rotates when file exceeds 10MB", () => {
  const { p } = mkTempLog();
  const big = "x".repeat(1024 * 1024);
  fs.writeFileSync(p, big.repeat(11));
  log({ event: "trigger" });
  assert.ok(fs.existsSync(p + ".1"), "should have created .1");
  const current = fs.readFileSync(p, "utf8");
  assert.ok(current.includes('"event":"trigger"'), "new log should have the trigger event");
  assert.ok(current.length < 2 * 1024 * 1024, "new log should be small");
});

test("log: keeps max 3 generations", () => {
  const { dir, p } = mkTempLog();
  fs.writeFileSync(p + ".1", "one");
  fs.writeFileSync(p + ".2", "two");
  fs.writeFileSync(p + ".3", "three");
  const big = "x".repeat(11 * 1024 * 1024);
  fs.writeFileSync(p, big);
  log({ event: "force-rotate" });
  assert.equal(fs.readFileSync(p + ".2", "utf8"), "one");
  assert.equal(fs.readFileSync(p + ".3", "utf8"), "two");
  assert.equal(fs.existsSync(p + ".4"), false, "no .4 generation");
});

test("log: never throws even if parent dir missing", () => {
  _setLogPathForTests("/definitely/does/not/exist/rotator.log");
  assert.doesNotThrow(() => log({ event: "should-not-throw" }));
});
