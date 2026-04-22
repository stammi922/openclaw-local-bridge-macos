import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({ session_id: z.string().min(1) }).strict();

type SessionRow = {
  session_id: string;
  status: string;
  started_at?: string;
  updated_at?: string;
  last_message?: string;
  model?: string;
  tokens?: number;
};

export type SessionStatusResult =
  | {
      session_id: string;
      status: string;
      started_at?: string;
      updated_at?: string;
      last_message_preview?: string;
      model?: string;
      tokens?: number;
    }
  | { error: string; code: "NOT_FOUND" };

export const sessionStatusTool = {
  definition: {
    name: "session_status",
    description: "Return current status and preview of a session by id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, description: "Session UUID" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  async handler(rawArgs: unknown): Promise<SessionStatusResult> {
    const { session_id } = InputSchema.parse(rawArgs);
    // `openclaw sessions --json` returns an envelope `{sessions: [...]}`; use
    // `--all-agents` so we can locate a session regardless of which agent owns it.
    const raw = await runOpenclawJson<{ sessions?: unknown }>(["sessions", "--all-agents", "--json"]);
    const envelope = raw && typeof raw === "object" ? raw : {};
    const rows = Array.isArray((envelope as { sessions?: unknown }).sessions)
      ? (envelope as { sessions: SessionRow[] }).sessions
      : [];
    const row = rows.find(s => s.session_id === session_id);
    if (!row) return { error: `session ${session_id} not found`, code: "NOT_FOUND" };
    const preview = row.last_message ? row.last_message.slice(0, 200) : undefined;
    // `last_message_preview` (truncated to 200) is semantically distinct from
    // `last_message` returned by sessions_spawn / sessions_send (untruncated final
    // message on a finished session). Kept separate names on purpose.
    return {
      session_id: row.session_id,
      status: row.status,
      started_at: row.started_at,
      updated_at: row.updated_at,
      last_message_preview: preview,
      model: row.model,
      tokens: row.tokens,
    };
  },
};
