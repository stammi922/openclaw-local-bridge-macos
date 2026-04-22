import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionsListTool } from "./sessions-list.js";

vi.mock("../cli-wrapper.js");

describe("sessionsListTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns all sessions by default and normalizes camelCase rows", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      path: null,
      count: 2,
      sessions: [
        { sessionId: "a", agentId: "main", updatedAt: 1_700_000_000_000, model: "claude-sonnet-4", totalTokens: 10, abortedLastRun: false },
        { sessionId: "b", agentId: "main", updatedAt: 1_700_000_001_000, totalTokens: 5, abortedLastRun: true },
      ],
    });
    const result = await sessionsListTool.handler({});
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      session_id: "a",
      status: "completed",
      agent: "main",
      updated_at: new Date(1_700_000_000_000).toISOString(),
      model: "claude-sonnet-4",
      tokens: 10,
    });
    expect(result[1].status).toBe("aborted");
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--all-agents", "--json"]);
  });

  it("passes --agent when agent_id provided", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ sessionId: "a", agentId: "main", abortedLastRun: false }],
    });
    const result = await sessionsListTool.handler({ agent_id: "main" });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("a");
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--agent", "main", "--json"]);
  });

  it("pushes --active 60 to the CLI when active_only=true", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ sessionId: "b", agentId: "main", abortedLastRun: false }],
    });
    const result = await sessionsListTool.handler({ active_only: true });
    expect(result).toHaveLength(1);
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--all-agents", "--json", "--active", "60"]);
  });

  it("combines --agent and --active when both provided", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ sessionId: "b", agentId: "main", abortedLastRun: false }],
    });
    await sessionsListTool.handler({ agent_id: "main", active_only: true });
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--agent", "main", "--json", "--active", "60"]);
  });

  it("accepts legacy snake_case fields (test mock compat)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ session_id: "a", agent: "main", updated_at: "2026-04-21T10:00:00Z" }],
    });
    const result = await sessionsListTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      session_id: "a",
      status: "completed",
      agent: "main",
      updated_at: "2026-04-21T10:00:00Z",
      model: undefined,
      tokens: undefined,
    });
  });

  it("returns empty array when CLI returns a non-envelope payload", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await sessionsListTool.handler({});
    expect(result).toEqual([]);
  });

  it("returns empty array when envelope.sessions is missing", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ path: "/x", count: 0 } as never);
    const result = await sessionsListTool.handler({});
    expect(result).toEqual([]);
  });

  it("skips rows that lack a session id", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ agentId: "main" }, { sessionId: "ok", agentId: "main" }],
    });
    const result = await sessionsListTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("ok");
  });
});
