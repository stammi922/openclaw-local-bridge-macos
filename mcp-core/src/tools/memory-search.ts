import { z } from "zod";
import { runOpenclawJson } from "../cli-wrapper.js";
import { coerceArray } from "../json-utils.js";

const InputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

export type MemoryHit = { path: string; score: number; snippet: string };
export type MemorySearchResult = MemoryHit[];

export const memorySearchTool = {
  definition: {
    name: "memory_search",
    description: "Semantic search over auto-memory files. Returns ranked matches with path, score, snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query", minLength: 1 },
        limit: {
          type: "integer",
          description: "Max results (default uses CLI default; cap 100)",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["query"],
    },
  },
  async handler(rawArgs: unknown): Promise<MemorySearchResult> {
    const { query, limit } = InputSchema.parse(rawArgs);
    const args = ["memory", "search", "--query", query, "--json"];
    if (limit !== undefined) args.push("--limit", String(limit));
    const raw = await runOpenclawJson<MemoryHit[]>(args);
    return coerceArray<MemoryHit>(raw);
  },
};
