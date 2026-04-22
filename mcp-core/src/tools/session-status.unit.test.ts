import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionStatusTool } from "./session-status.js";

vi.mock("../cli-wrapper.js");

describe("sessionStatusTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns the matching session row normalized from camelCase", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [
        { sessionId: "abc", agentId: "main", updatedAt: 1_700_000_000_000, model: "claude-sonnet-4", totalTokens: 42, abortedLastRun: false },
        { sessionId: "def", agentId: "main", updatedAt: 1_700_000_001_000, abortedLastRun: true },
      ],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result).toEqual({
      session_id: "abc",
      status: "completed",
      agent: "main",
      updated_at: new Date(1_700_000_000_000).toISOString(),
      model: "claude-sonnet-4",
      tokens: 42,
    });
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--all-agents", "--json"]);
  });

  it("derives status=aborted when abortedLastRun is true", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ sessionId: "abc", agentId: "main", abortedLastRun: true }],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result.status).toBe("aborted");
  });

  it("returns NOT_FOUND when session missing", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ sessions: [] });
    const result = await sessionStatusTool.handler({ session_id: "missing" });
    if (!("error" in result)) throw new Error("expected error shape");
    expect(result.error).toBeTruthy();
    expect(result.code).toBe("NOT_FOUND");
  });

  it("falls back to NOT_FOUND when CLI returns a non-envelope payload", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if (!("error" in result)) throw new Error("expected error shape");
    expect(result.code).toBe("NOT_FOUND");
  });

  it("accepts legacy snake_case fields (test mock compat)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ session_id: "abc", agent: "main", updated_at: "2026-04-21T10:00:00Z" }],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result.updated_at).toBe("2026-04-21T10:00:00Z");
    expect(result.status).toBe("completed");
  });
});
