import { z } from "zod";
import { runOpenclawDetached, runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({
  session_id: z.string().min(1),
  message: z.string().min(1),
  wait_ms: z.number().int().min(0).max(600_000).optional().default(15_000),
}).strict();

export type SessionsSendResult =
  | { session_id: string; status: "running" }
  | { session_id: string; status: "done"; exit_code: number; last_message?: string }
  | { session_id: string; status: "done"; exit_code: number; warning: string };

export const sessionsSendTool = {
  definition: {
    name: "sessions_send",
    description:
      "Send a message to an existing session by `session_id`. Waits up to `wait_ms` (default 15s); if the session closes within that window, returns status=done with its final message. Otherwise the session keeps running and this returns status=running — poll with session_status.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Target session UUID", minLength: 1 },
        message: { type: "string", description: "Message to send to the session", minLength: 1 },
        wait_ms: {
          type: "integer",
          description: "Max wait before returning running (default 15000, max 600000)",
          minimum: 0,
          maximum: 600_000,
          default: 15_000,
        },
      },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
  },
  async handler(rawArgs: unknown): Promise<SessionsSendResult> {
    const { session_id, message, wait_ms } = InputSchema.parse(rawArgs);
    const args = ["agent", "--agent", "main", "--session-id", session_id, "--message", message];

    const child = runOpenclawDetached(args);

    const closePromise = new Promise<number>((resolve) => {
      child.once("close", (code: number | null) => resolve(code ?? -1));
    });
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), wait_ms);
    });

    let winner: number | "timeout";
    try {
      winner = await Promise.race([closePromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (winner === "timeout") {
      return { session_id, status: "running" as const };
    }

    // Child finished. Fetch its terminal state from the CLI.
    // `openclaw sessions --json` returns an envelope `{sessions: [...]}`.
    try {
      const raw = await runOpenclawJson<{ sessions?: Array<{ session_id: string; status: string; last_message?: string }> }>(
        ["sessions", "--all-agents", "--json"],
      );
      const rows = raw && typeof raw === "object" && Array.isArray((raw as { sessions?: unknown }).sessions)
        ? (raw as { sessions: Array<{ session_id: string; status: string; last_message?: string }> }).sessions
        : [];
      const row = rows.find(s => s.session_id === session_id);
      return {
        session_id,
        status: "done" as const,
        last_message: row?.last_message,
        exit_code: winner,
      };
    } catch (err) {
      return {
        session_id,
        status: "done" as const,
        exit_code: winner,
        warning: `session lookup failed: ${(err as Error).message}`,
      };
    }
  },
};
