import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({ session_id: z.string().min(1) });

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
    },
  },
  async handler(rawArgs: unknown): Promise<SessionStatusResult> {
    const { session_id } = InputSchema.parse(rawArgs);
    const list = await runOpenclawJson<SessionRow[]>(["sessions", "list", "--json"]);
    const row = (Array.isArray(list) ? list : []).find(s => s.session_id === session_id);
    if (!row) return { error: `session ${session_id} not found`, code: "NOT_FOUND" };
    const preview = row.last_message ? row.last_message.slice(0, 200) : undefined;
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
