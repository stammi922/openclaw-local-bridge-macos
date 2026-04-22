import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { agentsListTool } from "./agents-list.js";

vi.mock("../cli-wrapper.js");

describe("agentsListTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns array from openclaw agents list --json", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { id: "main", agentDir: "/Users/jonasjames/.openclaw/agents/main" },
    ]);
    const result = await agentsListTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("main");
  });

  it("returns empty array when CLI returns empty list", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([]);
    const result = await agentsListTool.handler({});
    expect(result).toEqual([]);
  });

  it("returns empty array when CLI returns non-array (fallback)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ oops: true });
    const result = await agentsListTool.handler({});
    expect(result).toEqual([]);
  });
});
