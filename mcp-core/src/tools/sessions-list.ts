import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";
import { coerceArray } from "../json-utils.js";

const InputSchema = z.object({
  agent_id: z.string().optional(),
  active_only: z.boolean().optional().default(false),
});

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
    },
  },
  async handler(rawArgs: unknown): Promise<SessionsListResult> {
    const { agent_id, active_only } = InputSchema.parse(rawArgs);
    const all = await runOpenclawJson<SessionRow[]>(["sessions", "list", "--json"]);
    let rows = coerceArray<SessionRow>(all);
    if (agent_id) rows = rows.filter(r => r.agent === agent_id);
    if (active_only) rows = rows.filter(r => r.status === "running");
    return rows;
  },
};
