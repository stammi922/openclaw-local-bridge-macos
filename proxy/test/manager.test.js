import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildArgs } from "../dist/subprocess/manager.js";

describe("buildArgs", () => {
  const basePrompt = "hello";
  const baseOpts = { model: "sonnet", sessionId: undefined };
  const origEnv = process.env.OPENCLAW_MCP_CONFIG;
  const origMode = process.env.OPENCLAW_MCP_PERMISSION_MODE;

  beforeEach(() => {
    delete process.env.OPENCLAW_MCP_CONFIG;
    delete process.env.OPENCLAW_MCP_PERMISSION_MODE;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.OPENCLAW_MCP_CONFIG;
    else process.env.OPENCLAW_MCP_CONFIG = origEnv;
    if (origMode === undefined) delete process.env.OPENCLAW_MCP_PERMISSION_MODE;
    else process.env.OPENCLAW_MCP_PERMISSION_MODE = origMode;
  });

  it("omits --mcp-config, --strict-mcp-config and --permission-mode when OPENCLAW_MCP_CONFIG is unset", () => {
    const args = buildArgs(basePrompt, baseOpts);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--permission-mode");
  });

  it("includes --mcp-config, --strict-mcp-config, and --permission-mode when OPENCLAW_MCP_CONFIG is set", () => {
    process.env.OPENCLAW_MCP_CONFIG = "/tmp/mcp.json";
    const args = buildArgs(basePrompt, baseOpts);
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("honours OPENCLAW_MCP_PERMISSION_MODE override", () => {
    process.env.OPENCLAW_MCP_CONFIG = "/tmp/mcp.json";
    process.env.OPENCLAW_MCP_PERMISSION_MODE = "acceptEdits";
    const args = buildArgs(basePrompt, baseOpts);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
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

  it("places --mcp-config before prompt and --session-id after, together", () => {
    process.env.OPENCLAW_MCP_CONFIG = "/tmp/mcp.json";
    const args = buildArgs("hello", { model: "sonnet", sessionId: "abc" });
    const promptIdx = args.indexOf("hello");
    expect(args.indexOf("--mcp-config")).toBeLessThan(promptIdx);
    expect(args.indexOf("--strict-mcp-config")).toBeLessThan(promptIdx);
    expect(args.indexOf("--session-id")).toBeGreaterThan(promptIdx);
  });
});
