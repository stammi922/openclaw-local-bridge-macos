import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import * as cli from "../cli-wrapper.js";
import { sessionsSendTool } from "./sessions-send.js";

vi.mock("../cli-wrapper.js");

function makeFakeChild(closeDelayMs: number, exitCode = 0) {
  const ee = new EventEmitter();
  setTimeout(() => ee.emit("close", exitCode), closeDelayMs);
  return ee;
}

describe("sessionsSendTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns status=done with last_message when child closes before wait_ms", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_id: "sess-123", status: "done", last_message: "ack" },
    ]);

    const result = await sessionsSendTool.handler({ session_id: "sess-123", message: "hello", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect("last_message" in result ? result.last_message : undefined).toBe("ack");
    expect(result.session_id).toBe("sess-123");
  });

  it("returns status=running when wait_ms elapses first", async () => {
    const child = makeFakeChild(1000); // will not close in time
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSendTool.handler({ session_id: "sess-456", message: "hello", wait_ms: 50 });
    expect(result.status).toBe("running");
    if (result.status === "running") {
      expect(result.session_id).toBe("sess-456");
    } else {
      throw new Error("expected running");
    }
  });

  it("returns status=done with warning when session lookup fails after close", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockRejectedValue(new Error("boom"));

    const result = await sessionsSendTool.handler({ session_id: "sess-789", message: "hello", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status === "done" && "warning" in result) {
      expect(result.warning).toMatch(/session lookup failed: boom/);
    } else {
      throw new Error("expected done+warning shape");
    }
  });

  it("returns status=done with last_message=undefined when runOpenclawJson returns unexpected shape", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" });

    const result = await sessionsSendTool.handler({ session_id: "sess-abc", message: "hello", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect("last_message" in result ? result.last_message : undefined).toBeUndefined();
  });
});
