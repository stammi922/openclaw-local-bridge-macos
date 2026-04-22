import { z } from "zod";
import Database from "better-sqlite3";
import { resolveLcmDbPath } from "../config.js";

const InputSchema = z.object({
  pattern: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(50),
}).strict();

export type LcmGrepHit = { session_key: string; message_id: string; snippet: string };
export type LcmGrepResult = LcmGrepHit[];

// Escape SQL LIKE wildcards so the user's pattern is treated as a literal
// substring rather than a LIKE pattern. Paired with `ESCAPE '\'` in the query.
function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function viaSqlite(pattern: string, limit: number, dbPath: string): LcmGrepResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // session_key lives on conversations in the real openclaw lcm.db schema;
    // messages reference it via conversation_id.
    const rows = db
      .prepare(
        `SELECT c.session_key AS session_key,
                m.message_id   AS message_id,
                m.content      AS content
           FROM messages m
           JOIN conversations c ON c.conversation_id = m.conversation_id
          WHERE m.content LIKE ? ESCAPE '\\'
          ORDER BY m.created_at DESC
          LIMIT ?`,
      )
      .all(`%${escapeLike(pattern)}%`, limit) as Array<{ session_key: string; message_id: number | string; content: string }>;
    return rows.map(r => ({
      session_key: r.session_key,
      message_id: String(r.message_id),
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
      "Substring search across lcm.db messages via direct read-only sqlite. " +
      "Upstream `openclaw memory grep` was removed in 2026.4.21; this tool " +
      "queries the database directly with a messages⋈conversations JOIN.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Substring to search for (LIKE wildcards are escaped)",
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
      additionalProperties: false,
    },
  },
  async handler(rawArgs: unknown): Promise<LcmGrepResult> {
    const { pattern, limit } = InputSchema.parse(rawArgs);
    return viaSqlite(pattern, limit, resolveLcmDbPath());
  },
};
