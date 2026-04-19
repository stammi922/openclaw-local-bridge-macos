// Classify an incoming OpenAI request body as "heartbeat" or "main".
//
// v1 heuristic: if the request's model is in config.heartbeatModels, it's
// a heartbeat. OpenClaw heartbeats are configured to use a specific model
// (default claude-haiku-4), so matching on model is a cheap, deterministic
// signal without changing OpenClaw itself.
//
// Users who also use Haiku for non-heartbeat purposes can either:
//   - set heartbeatModels: [] to disable the cloak pool, or
//   - use a different model name for their real Haiku calls.

export function classifyRequest(body, config) {
  const models = Array.isArray(config?.heartbeatModels) ? config.heartbeatModels : [];
  if (models.length === 0) return "main";
  const m = String(body?.model ?? "").trim();
  return models.includes(m) ? "heartbeat" : "main";
}
