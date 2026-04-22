import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { memorySearchTool } from "./memory-search.js";

vi.mock("../cli-wrapper.js");

describe("memorySearchTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes query and limit to openclaw memory search", async () => {
    const spy = vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { path: "user_role.md", score: 0.9, snippet: "data scientist" },
    ]);
    const result = await memorySearchTool.handler({ query: "role", limit: 5 });
    const call = spy.mock.calls[0][0];
    expect(call).toContain("--query");
    expect(call[call.indexOf("--query") + 1]).toBe("role");
    expect(call).toContain("--limit");
    expect(call[call.indexOf("--limit") + 1]).toBe("5");
    expect(result).toHaveLength(1);
  });

  it("works without a limit", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([]);
    await memorySearchTool.handler({ query: "anything" });
    const call = vi.mocked(cli.runOpenclawJson).mock.calls[0][0];
    expect(call).not.toContain("--limit");
  });

  it("returns empty array when CLI returns a non-array payload", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await memorySearchTool.handler({ query: "x" });
    expect(result).toEqual([]);
  });
});
