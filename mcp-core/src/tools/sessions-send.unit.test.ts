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

  it("returns status=done with exit_code when child closes before wait_ms", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSendTool.handler({ session_id: "sess-123", message: "hello", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.session_id).toBe("sess-123");
    expect(result.exit_code).toBe(0);
    expect(cli.runOpenclawJson).not.toHaveBeenCalled();
  });

  it("returns status=running when wait_ms elapses first", async () => {
    const child = makeFakeChild(1000);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSendTool.handler({ session_id: "sess-456", message: "hello", wait_ms: 50 });
    expect(result.status).toBe("running");
    if (result.status !== "running") throw new Error("expected running");
    expect(result.session_id).toBe("sess-456");
  });

  it("surfaces non-zero exit codes in exit_code", async () => {
    const child = makeFakeChild(10, 7);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSendTool.handler({ session_id: "sess-789", message: "hello", wait_ms: 500 });
    if (result.status !== "done") throw new Error("expected done");
    expect(result.exit_code).toBe(7);
  });

  it("passes --session-id and --message through to the CLI", async () => {
    const child = makeFakeChild(1000);
    const detachedSpy = vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    await sessionsSendTool.handler({ session_id: "sess-abc", message: "hello world", wait_ms: 10 });
    const args = detachedSpy.mock.calls[0][0];
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-abc");
    expect(args).toContain("--message");
    expect(args[args.indexOf("--message") + 1]).toBe("hello world");
  });
});
