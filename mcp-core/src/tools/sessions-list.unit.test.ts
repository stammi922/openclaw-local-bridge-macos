import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionsListTool } from "./sessions-list.js";

vi.mock("../cli-wrapper.js");

describe("sessionsListTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns all sessions by default", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_id: "a", status: "done", agent: "main" },
      { session_id: "b", status: "running", agent: "main" },
    ]);
    const result = await sessionsListTool.handler({});
    expect(result).toHaveLength(2);
  });

  it("filters by agent_id when provided", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_id: "a", status: "done", agent: "main" },
      { session_id: "b", status: "running", agent: "other" },
    ]);
    const result = await sessionsListTool.handler({ agent_id: "main" });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("a");
  });

  it("filters running only when active_only=true", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_id: "a", status: "done", agent: "main" },
      { session_id: "b", status: "running", agent: "main" },
    ]);
    const result = await sessionsListTool.handler({ active_only: true });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("b");
  });

  it("combines agent_id and active_only with AND semantics", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_id: "a", status: "done", agent: "main" },
      { session_id: "b", status: "running", agent: "main" },
      { session_id: "c", status: "running", agent: "other" },
    ]);
    const result = await sessionsListTool.handler({ agent_id: "main", active_only: true });
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("b");
  });

  it("returns empty array when CLI returns a non-array payload", async () => {
    // Parallel to the guard added in session-status: if the CLI ever emits an object
    // envelope or null, the tool must not throw — it treats it as an empty result.
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await sessionsListTool.handler({});
    expect(result).toEqual([]);
  });
});
