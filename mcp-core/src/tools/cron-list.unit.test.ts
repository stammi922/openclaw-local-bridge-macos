import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { cronListTool } from "./cron-list.js";

vi.mock("../cli-wrapper.js");

describe("cronListTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns full list by default", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      jobs: [
        { id: "daily", enabled: true, schedule: "0 9 * * *" },
        { id: "weekly", enabled: false, schedule: "0 9 * * 1" },
      ],
    });
    const result = await cronListTool.handler({});
    expect(result).toHaveLength(2);
  });

  it("filters to enabled_only=true", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      jobs: [
        { id: "daily", enabled: true },
        { id: "weekly", enabled: false },
      ],
    });
    const result = await cronListTool.handler({ enabled_only: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("daily");
  });

  it("returns empty array when CLI payload is malformed", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ oops: "wrong shape" } as never);
    const result = await cronListTool.handler({});
    expect(result).toEqual([]);
  });

  it("accepts a bare array payload from CLI (forward-compat)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { id: "daily", enabled: true },
    ] as never);
    const result = await cronListTool.handler({});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("daily");
  });
});
