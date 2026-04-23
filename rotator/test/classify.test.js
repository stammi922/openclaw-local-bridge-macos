import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRequest } from "../classify.js";

const cfg = { heartbeatModels: ["claude-haiku-4", "claude-haiku-4-20250514"] };

test("classifyRequest: model in heartbeatModels → 'heartbeat'", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, cfg), "heartbeat");
  assert.equal(classifyRequest({ model: "claude-haiku-4-20250514" }, cfg), "heartbeat");
});

test("classifyRequest: model NOT in heartbeatModels → 'main'", () => {
  assert.equal(classifyRequest({ model: "claude-sonnet-4" }, cfg), "main");
  assert.equal(classifyRequest({ model: "claude-opus-4" }, cfg), "main");
});

test("classifyRequest: missing .model → 'main' (conservative)", () => {
  assert.equal(classifyRequest({}, cfg), "main");
  assert.equal(classifyRequest(null, cfg), "main");
  assert.equal(classifyRequest(undefined, cfg), "main");
});

test("classifyRequest: empty heartbeatModels → always 'main'", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, { heartbeatModels: [] }), "main");
});

test("classifyRequest: non-array heartbeatModels → 'main' (defensive)", () => {
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, { heartbeatModels: null }), "main");
  assert.equal(classifyRequest({ model: "claude-haiku-4" }, {}), "main");
});
