import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";
import { normalizeSessionRow, type NormalizedSessionRow } from "../session-utils.js";

const InputSchema = z.object({ session_id: z.string().min(1) }).strict();

export type SessionStatusResult =
  | NormalizedSessionRow
  | { error: string; code: "NOT_FOUND" };

export const sessionStatusTool = {
  definition: {
    name: "session_status",
    description:
      "Return normalized metadata for a session by id. Does not include the final agent reply — " +
      "the CLI's sessions endpoint returns metadata only, and surfacing message content is deferred.",
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
    // `--all-agents` so the lookup succeeds regardless of which agent owns it.
    const raw = await runOpenclawJson<{ sessions?: unknown }>(["sessions", "--all-agents", "--json"]);
    const envelope = raw && typeof raw === "object" ? raw : {};
    const rawRows = Array.isArray((envelope as { sessions?: unknown }).sessions)
      ? ((envelope as { sessions: unknown[] }).sessions)
      : [];
    for (const row of rawRows) {
      const n = normalizeSessionRow(row);
      if (n && n.session_id === session_id) return n;
    }
    return { error: `session ${session_id} not found`, code: "NOT_FOUND" };
  },
};
