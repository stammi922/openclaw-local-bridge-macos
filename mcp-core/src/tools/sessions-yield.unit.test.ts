import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import { sessionsYieldTool } from "./sessions-yield.js";

vi.mock("../cli-wrapper.js");

describe("sessionsYieldTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("invokes `openclaw sessions yield --session-id X` and returns yielded:true", async () => {
    const spy = vi.mocked(cli.runOpenclawJson).mockResolvedValue({ ok: true });
    const result = await sessionsYieldTool.handler({ session_id: "abc" });
    expect(spy).toHaveBeenCalledWith(expect.arrayContaining(["sessions", "yield", "--session-id", "abc"]));
    expect(result).toEqual({ yielded: true });
  });

  it("passes --handoff-message when provided", async () => {
    const spy = vi.mocked(cli.runOpenclawJson).mockResolvedValue({ ok: true });
    await sessionsYieldTool.handler({ session_id: "abc", handoff_message: "bye" });
    const call = spy.mock.calls[0][0];
    expect(call).toContain("--handoff-message");
    expect(call[call.indexOf("--handoff-message") + 1]).toBe("bye");
  });

  it("uses exact arg sequence without --handoff-message", async () => {
    const spy = vi.mocked(cli.runOpenclawJson).mockResolvedValue({ ok: true });
    await sessionsYieldTool.handler({ session_id: "abc" });
    expect(spy).toHaveBeenCalledWith(["sessions", "yield", "--session-id", "abc"]);
  });
});
