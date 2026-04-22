import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runOpenclawDetached, runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({
  task: z.string().min(1),
  wait_ms: z.number().int().min(0).max(600_000).optional().default(15_000),
  model: z.string().optional(),
});

export const sessionsSpawnTool = {
  definition: {
    name: "sessions_spawn",
    description:
      "Spawn a new subagent under `main` to run `task`. Waits up to `wait_ms` (default 15s); if the subagent completes within that window, returns status=done with its final message. Otherwise the subagent keeps running in the background and this returns status=running — poll with session_status or watch via openclaw-watch.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Prompt for the subagent" },
        wait_ms: { type: "number", description: "Max wait before returning running (default 15000, max 600000)" },
        model: { type: "string", description: "Optional model override (e.g. google/gemini-2.5-flash)" },
      },
      required: ["task"],
    },
  },
  async handler(rawArgs: unknown): Promise<unknown> {
    const { task, wait_ms, model } = InputSchema.parse(rawArgs);
    const sessionId = randomUUID();
    const args = ["agent", "--agent", "main", "--session-id", sessionId, "--message", task];
    if (model) args.push("--model", model);

    const child = runOpenclawDetached(args);

    const closePromise = new Promise<number>((resolve) => {
      child.once("close", (code: number | null) => resolve(code ?? -1));
    });
    const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), wait_ms));

    const winner = await Promise.race([closePromise, timeoutPromise]);

    if (winner === "timeout") {
      return { session_id: sessionId, status: "running" as const };
    }

    // Child finished. Fetch its terminal state from the CLI.
    try {
      const sessions = await runOpenclawJson<Array<{ session_id: string; status: string; last_message?: string }>>(
        ["sessions", "list", "--json"],
      );
      const row = Array.isArray(sessions) ? sessions.find(s => s.session_id === sessionId) : undefined;
      return {
        session_id: sessionId,
        status: "done" as const,
        result: row?.last_message,
        exit_code: winner,
      };
    } catch (err) {
      return {
        session_id: sessionId,
        status: "done" as const,
        exit_code: winner,
        warning: `subagent exited ${winner} but session lookup failed: ${(err as Error).message}`,
      };
    }
  },
};
