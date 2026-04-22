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
    expect((result as any).status).toBe("done");
    expect((result as any).session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns status=running when wait_ms elapses first", async () => {
    const child = makeFakeChild(1000); // will not close in time
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 50 });
    expect((result as any).status).toBe("running");
    expect((result as any).session_id).toBeTruthy();
    expect((result as any).result).toBeUndefined();
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
});
