import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";
import { coerceArray } from "../json-utils.js";

const InputSchema = z.object({
  agent_id: z.string().optional(),
  active_only: z.boolean().optional().default(false),
}).strict();

export type SessionRow = {
  session_id: string;
  status: string;
  agent?: string;
  [k: string]: unknown;
};

export type SessionsListResult = SessionRow[];

export const sessionsListTool = {
  definition: {
    name: "sessions_list",
    description: "List sessions, optionally filtered by agent or running-only.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        active_only: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  async handler(rawArgs: unknown): Promise<SessionsListResult> {
    const { agent_id, active_only } = InputSchema.parse(rawArgs);
    // `openclaw sessions --json` returns an envelope `{sessions: [...]}` (not a
    // bare array and not `openclaw sessions list`). Push `--agent` or
    // `--all-agents` down to the CLI so cross-agent filtering stays correct.
    const args = agent_id
      ? ["sessions", "--agent", agent_id, "--json"]
      : ["sessions", "--all-agents", "--json"];
    const raw = await runOpenclawJson<{ sessions?: unknown }>(args);
    const envelope = raw && typeof raw === "object" ? raw : {};
    let rows = coerceArray<SessionRow>((envelope as { sessions?: unknown }).sessions);
    if (active_only) rows = rows.filter(r => r.status === "running");
    return rows;
  },
};
