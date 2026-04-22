import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runOpenclawDetached } from "../cli-wrapper.js";

const InputSchema = z.object({
  task: z.string().min(1),
  wait_ms: z.number().int().min(0).max(600_000).optional().default(15_000),
}).strict();

export type SessionsSpawnResult =
  | { session_id: string; status: "running" }
  | { session_id: string; status: "done"; exit_code: number };

export const sessionsSpawnTool = {
  definition: {
    name: "sessions_spawn",
    description:
      "Spawn a new subagent under `main` to run `task`. Waits up to `wait_ms` (default 15s); if the subagent closes within that window, returns status=done with its exit_code. Otherwise the subagent keeps running in the background and this returns status=running — poll with session_status or watch via openclaw-watch. The final model reply is not returned inline; read the session log separately if needed.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Prompt for the subagent", minLength: 1 },
        wait_ms: {
          type: "integer",
          description: "Max wait before returning running (default 15000, max 600000)",
          minimum: 0,
          maximum: 600_000,
          default: 15_000,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  async handler(rawArgs: unknown): Promise<SessionsSpawnResult> {
    const { task, wait_ms } = InputSchema.parse(rawArgs);
    const sessionId = randomUUID();
    const args = ["agent", "--agent", "main", "--session-id", sessionId, "--message", task];

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
      return { session_id: sessionId, status: "running" as const };
    }
    return { session_id: sessionId, status: "done" as const, exit_code: winner };
  },
};
