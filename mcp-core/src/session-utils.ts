// Normalization layer between raw `openclaw sessions --json` rows (which use
// camelCase, epoch-ms timestamps, and carry `abortedLastRun` rather than an
// explicit status) and the snake_case shape the MCP tools declare to clients.
//
// `last_message` is intentionally absent: the CLI's sessions endpoint returns
// metadata only. Surfacing the final model reply would require reading the
// per-session message log, which is deferred to a follow-up.

export type SessionStatus = "aborted" | "completed";

export type NormalizedSessionRow = {
  session_id: string;
  status: SessionStatus;
  agent?: string;
  updated_at?: string;
  model?: string;
  tokens?: number;
};

export function normalizeSessionRow(raw: unknown): NormalizedSessionRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  // Accept camelCase (real CLI) or snake_case (legacy spec / test mocks).
  const sessionId =
    (typeof r.sessionId === "string" && r.sessionId) ||
    (typeof r.session_id === "string" && r.session_id) ||
    undefined;
  if (!sessionId) return undefined;

  const updatedAt = (() => {
    if (typeof r.updated_at === "string") return r.updated_at;
    if (typeof r.updatedAt === "number") return new Date(r.updatedAt).toISOString();
    return undefined;
  })();

  const agent =
    (typeof r.agentId === "string" && r.agentId) ||
    (typeof r.agent === "string" && r.agent) ||
    undefined;

  const tokens = (() => {
    if (typeof r.tokens === "number") return r.tokens;
    if (typeof r.totalTokens === "number") return r.totalTokens;
    return undefined;
  })();

  return {
    session_id: sessionId,
    status: r.abortedLastRun === true ? "aborted" : "completed",
    agent,
    updated_at: updatedAt,
    model: typeof r.model === "string" ? r.model : undefined,
    tokens,
  };
}
