// Pure function: no I/O, safe to unit-test in isolation.
export function classifyRequest(body, cfg) {
  const models = Array.isArray(cfg?.heartbeatModels) ? cfg.heartbeatModels : [];
  const model = body?.model;
  if (typeof model !== "string" || model.length === 0) return "main";
  return models.includes(model) ? "heartbeat" : "main";
}
