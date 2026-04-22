import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildArgs } from "../dist/subprocess/manager.js";

describe("buildArgs", () => {
  const basePrompt = "hello";
  const baseOpts = { model: "sonnet", sessionId: undefined };
  const origEnv = process.env.OPENCLAW_MCP_CONFIG;

  beforeEach(() => { delete process.env.OPENCLAW_MCP_CONFIG; });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OPENCLAW_MCP_CONFIG;
    else process.env.OPENCLAW_MCP_CONFIG = origEnv;
  });

  it("omits --mcp-config when OPENCLAW_MCP_CONFIG is unset", () => {
    const args = buildArgs(basePrompt, baseOpts);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("includes --mcp-config and --strict-mcp-config when OPENCLAW_MCP_CONFIG is set", () => {
    process.env.OPENCLAW_MCP_CONFIG = "/tmp/mcp.json";
    const args = buildArgs(basePrompt, baseOpts);
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("preserves --model and --no-session-persistence", () => {
    process.env.OPENCLAW_MCP_CONFIG = "/tmp/mcp.json";
    const args = buildArgs(basePrompt, baseOpts);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--no-session-persistence");
  });

  it("appends --session-id when provided", () => {
    const args = buildArgs(basePrompt, { model: "sonnet", sessionId: "abc" });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc");
  });
});
