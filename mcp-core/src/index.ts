#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { sessionsSpawnTool } from "./tools/sessions-spawn.js";
import { sessionStatusTool } from "./tools/session-status.js";
import { sessionsListTool } from "./tools/sessions-list.js";
import { sessionsSendTool } from "./tools/sessions-send.js";

async function main() {
  const config = loadConfig();
  const server = new Server(
    { name: "openclaw-core", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Tool registry populated in Tasks 8–16.
  const tools: Record<string, {
    definition: { name: string; description: string; inputSchema: unknown };
    handler: (args: unknown) => Promise<unknown>;
  }> = {
    [sessionsSpawnTool.definition.name]: sessionsSpawnTool,
    [sessionStatusTool.definition.name]: sessionStatusTool,
    [sessionsListTool.definition.name]: sessionsListTool,
    [sessionsSendTool.definition.name]: sessionsSendTool,
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(tools).map(t => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools[req.params.name];
    if (!tool) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool", code: "NOT_FOUND" }) }], isError: true };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: JSON.stringify({ error: msg, code: "EXEC_FAILED" }) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[openclaw-core-mcp] connected; state_dir=${config.stateDir}\n`);
}

main().catch(err => {
  process.stderr.write(`[openclaw-core-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
