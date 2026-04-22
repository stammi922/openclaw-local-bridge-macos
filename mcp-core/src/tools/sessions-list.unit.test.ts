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
});
