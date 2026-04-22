import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import * as cli from "../cli-wrapper.js";
import { sessionsSpawnTool } from "./sessions-spawn.js";

vi.mock("../cli-wrapper.js");

function makeFakeChild(closeDelayMs: number, exitCode = 0) {
  const ee = new EventEmitter() as EventEmitter & { pid?: number };
  ee.pid = 4242;
  setTimeout(() => ee.emit("close", exitCode), closeDelayMs);
  return ee;
}

describe("sessionsSpawnTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns status=done when child closes before wait_ms", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({
      session_id: "abc",
      status: "done",
      last_message: "SUB-PONG",
    });

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status === "done") {
      expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/);
    } else {
      throw new Error("expected done");
    }
  });

  it("returns status=running when wait_ms elapses first", async () => {
    const child = makeFakeChild(1000); // will not close in time
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 50 });
    expect(result.status).toBe("running");
    if (result.status === "running") {
      expect(result.session_id).toBeTruthy();
    } else {
      throw new Error("expected running");
    }
    expect("last_message" in result ? (result as { last_message?: unknown }).last_message : undefined).toBeUndefined();
  });

  it("passes --model when model override provided", async () => {
    const child = makeFakeChild(10);
    const detachedSpy = vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ status: "done" });

    await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500, model: "google/gemini-2.5-flash" });
    const args = detachedSpy.mock.calls[0][0];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-2.5-flash");
  });

  it("returns status=done with warning when session lookup fails after close", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);
    vi.mocked(cli.runOpenclawJson).mockRejectedValue(new Error("boom"));

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status === "done" && "warning" in result) {
      expect(result.warning).toMatch(/session lookup failed: boom/);
    } else {
      throw new Error("expected done+warning shape");
    }
    expect("last_message" in result ? (result as { last_message?: unknown }).last_message : undefined).toBeUndefined();
  });
});
