import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { memorySearchTool } from "./memory-search.js";

vi.mock("../cli-wrapper.js");

describe("memorySearchTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes query via --query and limit via --max-results, unwraps results envelope", async () => {
    const spy = vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      results: [{ path: "user_role.md", score: 0.9, snippet: "data scientist" }],
    });
    const result = await memorySearchTool.handler({ query: "role", limit: 5 });
    const call = spy.mock.calls[0][0];
    expect(call).toContain("--query");
    expect(call[call.indexOf("--query") + 1]).toBe("role");
    expect(call).toContain("--max-results");
    expect(call[call.indexOf("--max-results") + 1]).toBe("5");
    expect(call).not.toContain("--limit");
    expect(result).toHaveLength(1);
  });

  it("works without a limit (no --max-results in CLI args)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ results: [] });
    await memorySearchTool.handler({ query: "anything" });
    const call = vi.mocked(cli.runOpenclawJson).mock.calls[0][0];
    expect(call).not.toContain("--max-results");
    expect(call).not.toContain("--limit");
  });

  it("returns empty array when envelope is missing results", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await memorySearchTool.handler({ query: "x" });
    expect(result).toEqual([]);
  });

  it("returns empty array when CLI returns a non-object payload", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue(null as never);
    const result = await memorySearchTool.handler({ query: "x" });
    expect(result).toEqual([]);
  });
});
