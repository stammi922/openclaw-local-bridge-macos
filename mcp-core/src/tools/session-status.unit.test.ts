import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionStatusTool } from "./session-status.js";

vi.mock("../cli-wrapper.js");

describe("sessionStatusTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns the matching session row (unwraps envelope)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [
        { session_id: "abc", status: "running", started_at: "2026-04-21T10:00:00Z", updated_at: "2026-04-21T10:00:10Z", last_message: "hi", model: "claude-sonnet-4", tokens: 42 },
        { session_id: "def", status: "done", started_at: "x", updated_at: "y", model: "claude-sonnet-4", tokens: 10 },
      ],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result.session_id).toBe("abc");
    expect(result.status).toBe("running");
    expect(result.last_message_preview).toBe("hi");
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(["sessions", "--all-agents", "--json"]);
  });

  it("returns NOT_FOUND when session missing", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ sessions: [] });
    const result = await sessionStatusTool.handler({ session_id: "missing" });
    if (!("error" in result)) throw new Error("expected error shape");
    expect(result.error).toBeTruthy();
    expect(result.code).toBe("NOT_FOUND");
  });

  it("truncates last_message to 200 chars in the preview", async () => {
    const long = "x".repeat(500);
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ session_id: "abc", status: "done", last_message: long }],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result.last_message_preview).toBe("x".repeat(200));
  });

  it("falls back to NOT_FOUND when CLI returns a non-envelope payload", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if (!("error" in result)) throw new Error("expected error shape");
    expect(result.code).toBe("NOT_FOUND");
  });

  it("omits last_message_preview when last_message is empty", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      sessions: [{ session_id: "abc", status: "running", last_message: "" }],
    });
    const result = await sessionStatusTool.handler({ session_id: "abc" });
    if ("error" in result) throw new Error("expected a row, got error");
    expect(result.last_message_preview).toBeUndefined();
  });
});
