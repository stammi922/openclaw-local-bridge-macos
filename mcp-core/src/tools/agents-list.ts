import { runOpenclawJson } from "../cli-wrapper.js";

export type AgentRow = { id: string; agentDir: string };
export type AgentsListResult = AgentRow[];

export const agentsListTool = {
  definition: {
    name: "agents_list",
    description: "List registered OpenClaw agents.",
    inputSchema: { type: "object", properties: {} },
  },
  async handler(_args: unknown): Promise<AgentsListResult> {
    const raw = await runOpenclawJson<AgentRow[]>(["agents", "list", "--json"]);
    return Array.isArray(raw) ? raw : [];
  },
};
