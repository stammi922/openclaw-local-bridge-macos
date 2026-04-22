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

  it("returns status=done with exit_code when child closes before wait_ms", async () => {
    const child = makeFakeChild(10);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.exit_code).toBe(0);
    expect(cli.runOpenclawJson).not.toHaveBeenCalled();
  });

  it("returns status=running when wait_ms elapses first", async () => {
    const child = makeFakeChild(1000);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 50 });
    expect(result.status).toBe("running");
    if (result.status !== "running") throw new Error("expected running");
    expect(result.session_id).toBeTruthy();
  });

  it("passes --model when model override provided", async () => {
    const child = makeFakeChild(10);
    const detachedSpy = vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500, model: "google/gemini-2.5-flash" });
    const args = detachedSpy.mock.calls[0][0];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-2.5-flash");
  });

  it("surfaces non-zero exit codes in exit_code", async () => {
    const child = makeFakeChild(10, 2);
    vi.mocked(cli.runOpenclawDetached).mockReturnValue(child as never);

    const result = await sessionsSpawnTool.handler({ task: "ping", wait_ms: 500 });
    if (result.status !== "done") throw new Error("expected done");
    expect(result.exit_code).toBe(2);
  });
});
