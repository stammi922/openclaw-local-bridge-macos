import { z } from "zod";
import Database from "better-sqlite3";
import { runOpenclawJson } from "../cli-wrapper.js";
import { loadConfig } from "../config.js";

const InputSchema = z.object({
  pattern: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

export type LcmGrepHit = { session_key: string; message_id: string; snippet: string };
export type LcmGrepResult = LcmGrepHit[];

async function viaCli(pattern: string, limit: number): Promise<LcmGrepResult> {
  const args = ["memory", "grep", "--pattern", pattern, "--json", "--limit", String(limit)];
  const raw = await runOpenclawJson<LcmGrepHit[]>(args);
  return Array.isArray(raw) ? raw : [];
}

function viaSqlite(pattern: string, limit: number, dbPath: string): LcmGrepResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        "SELECT session_key, message_id, content FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(`%${pattern}%`, limit) as Array<{ session_key: string; message_id: string; content: string }>;
    return rows.map(r => ({
      session_key: r.session_key,
      message_id: r.message_id,
      snippet: r.content.slice(0, 200),
    }));
  } finally {
    db.close();
  }
}

export const lcmGrepTool = {
  definition: {
    name: "lcm_grep",
    description:
      "Substring search across lcm.db messages. Uses openclaw memory grep if available; falls back to direct read-only sqlite.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Substring to search for (LIKE-escaped in sqlite fallback)",
          minLength: 1,
        },
        limit: {
          type: "integer",
          description: "Max matches to return (default 50, max 500)",
          minimum: 1,
          maximum: 500,
          default: 50,
        },
      },
      required: ["pattern"],
    },
  },
  async handler(rawArgs: unknown): Promise<LcmGrepResult> {
    const { pattern, limit } = InputSchema.parse(rawArgs);
    try {
      return await viaCli(pattern, limit);
    } catch (cliErr) {
      const msg = cliErr instanceof Error ? cliErr.message : String(cliErr);
      process.stderr.write(`[lcm_grep] CLI failed (${msg.slice(0, 80)}); falling back to sqlite\n`);
      const config = loadConfig();
      return viaSqlite(pattern, limit, config.lcmDbPath);
    }
  },
};
