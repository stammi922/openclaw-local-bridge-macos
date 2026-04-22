import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionsListTool } from "./sessions-list.js";

vi.mock("../cli-wrapper.js");

describe("sessionsListTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns all sessions by default (unwraps envelope)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      path: null,
      count: 2,
      sessions: [
        { session_id: "a", status: "done", agent: "main" },
        { session_id: "b", status: "running", agent: "main" },
      ],
    });
    const result = await sessionsListTool.handler({});
    expect(result).toHaveLength(2);
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--all-agents", "--json"]);
  });

  it("passes --agent when agent_id provided (no client-side filter)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ session_id: "a", status: "done", agent: "main" }],
    });
    const result = await sessionsListTool.handler({ agent_id: "main" });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("a");
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--agent", "main", "--json"]);
  });

  it("filters running only when active_only=true", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [
        { session_id: "a", status: "done", agent: "main" },
        { session_id: "b", status: "running", agent: "main" },
      ],
    });
    const result = await sessionsListTool.handler({ active_only: true });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("b");
  });

  it("combines agent_id (CLI-side) and active_only (tool-side)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [
        { session_id: "a", status: "done", agent: "main" },
        { session_id: "b", status: "running", agent: "main" },
      ],
    });
    const result = await sessionsListTool.handler({ agent_id: "main", active_only: true });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("b");
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--agent", "main", "--json"]);
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
});
