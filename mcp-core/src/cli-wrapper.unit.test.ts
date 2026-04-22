import { describe, it, expect, vi } from "vitest";
import { runOpenclawJson, runOpenclawDetached } from "./cli-wrapper.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process");

describe("runOpenclawJson", () => {
  it("parses JSON stdout on zero exit", async () => {
    const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd, _args, _opts, cb) => {
        (cb as any)(null, '{"ok": true}', "");
        return {} as any;
      }) as any,
    );
    const result = await runOpenclawJson(["sessions", "list", "--json"]);
    expect(result).toEqual({ ok: true });
    expect(execFileSpy).toHaveBeenCalledWith(
      "openclaw",
      ["sessions", "list", "--json"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("throws wrapped error on non-zero exit", async () => {
    vi.spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd, _args, _opts, cb) => {
        const err = Object.assign(new Error("exit 1"), { code: 1 });
        (cb as any)(err, "", "boom on stderr");
        return {} as any;
      }) as any,
    );
    await expect(runOpenclawJson(["bogus"])).rejects.toThrow(/openclaw bogus failed.*boom on stderr/);
  });

  it("throws when stdout is empty", async () => {
    vi.spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd, _args, _opts, cb) => {
        (cb as any)(null, "", "");
        return {} as any;
      }) as any,
    );
    await expect(runOpenclawJson(["sessions", "list", "--json"])).rejects.toThrow(/empty stdout.*expected JSON/);
  });

  it("throws when stdout is not valid JSON, preserving first 200 chars", async () => {
    const garbage = "not json: " + "x".repeat(300);
    vi.spyOn(childProcess, "execFile").mockImplementation(
      ((_cmd, _args, _opts, cb) => {
        (cb as any)(null, garbage, "");
        return {} as any;
      }) as any,
    );
    await expect(runOpenclawJson(["weird"])).rejects.toThrow(/returned non-JSON stdout: not json: x+/);
  });
});

describe("runOpenclawDetached", () => {
  it("spawns detached, unrefs, and returns the child handle", () => {
    const fakeChild = { unref: vi.fn(), on: vi.fn(), pid: 1234 };
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockReturnValue(fakeChild as any);
    const child = runOpenclawDetached(["agent", "--message", "hi"]);
    expect(spawnSpy).toHaveBeenCalledWith(
      "openclaw",
      ["agent", "--message", "hi"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(child.pid).toBe(1234);
  });

  it("anchors cwd at $HOME so openclaw's relative state paths resolve", () => {
    const fakeChild = { unref: vi.fn(), on: vi.fn(), pid: 1 };
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockReturnValue(fakeChild as any);
    const origHome = process.env.HOME;
    process.env.HOME = "/Users/fakeuser";
    try {
      runOpenclawDetached(["agent", "--message", "hi"]);
      expect(spawnSpy).toHaveBeenCalledWith(
        "openclaw",
        expect.anything(),
        expect.objectContaining({ cwd: "/Users/fakeuser" }),
      );
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});
