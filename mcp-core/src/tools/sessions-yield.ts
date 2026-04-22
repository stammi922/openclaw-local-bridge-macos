import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";

const InputSchema = z.object({
  session_id: z.string().min(1),
  handoff_message: z.string().optional(),
});

export type SessionsYieldResult = { yielded: true };

export const sessionsYieldTool = {
  definition: {
    name: "sessions_yield",
    description: "Yield (end) a session cooperatively with an optional handoff message.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Target session UUID", minLength: 1 },
        handoff_message: { type: "string", description: "Optional message to pass to the next actor" },
      },
      required: ["session_id"],
    },
  },
  async handler(rawArgs: unknown): Promise<SessionsYieldResult> {
    const { session_id, handoff_message } = InputSchema.parse(rawArgs);
    const args = ["sessions", "yield", "--session-id", session_id];
    if (handoff_message) args.push("--handoff-message", handoff_message);
    await runOpenclawJson(args);
    return { yielded: true };
  },
};
