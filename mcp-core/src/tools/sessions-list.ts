import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";
import { normalizeSessionRow, type NormalizedSessionRow } from "../session-utils.js";

const ACTIVE_WINDOW_MINUTES = 60;

const InputSchema = z.object({
  agent_id: z.string().optional(),
  active_only: z.boolean().optional().default(false),
}).strict();

export type SessionRow = NormalizedSessionRow;
export type SessionsListResult = SessionRow[];

export const sessionsListTool = {
  definition: {
    name: "sessions_list",
    description:
      "List sessions, optionally filtered by agent or recent activity. " +
      "`active_only: true` asks the CLI for sessions updated in the last hour (best-effort live signal; the CLI has no per-session running flag).",
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
    // `openclaw sessions --json` returns an envelope `{sessions: [...]}`
    // (not a bare array, and not `openclaw sessions list`). Push `--agent`,
    // `--all-agents`, and `--active <minutes>` down to the CLI so filtering
    // happens server-side.
    const args = agent_id
      ? ["sessions", "--agent", agent_id, "--json"]
      : ["sessions", "--all-agents", "--json"];
    if (active_only) args.push("--active", String(ACTIVE_WINDOW_MINUTES));
    const raw = await runOpenclawJson<{ sessions?: unknown }>(args);
    const envelope = raw && typeof raw === "object" ? raw : {};
    const rawRows = Array.isArray((envelope as { sessions?: unknown }).sessions)
      ? ((envelope as { sessions: unknown[] }).sessions)
      : [];
    const normalized: NormalizedSessionRow[] = [];
    for (const row of rawRows) {
      const n = normalizeSessionRow(row);
      if (n) normalized.push(n);
    }
    return normalized;
  },
};
