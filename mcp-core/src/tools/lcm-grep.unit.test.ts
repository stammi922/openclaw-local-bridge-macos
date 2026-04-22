import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cli from "../cli-wrapper.js";
import * as cfg from "../config.js";
import { lcmGrepTool } from "./lcm-grep.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

vi.mock("../cli-wrapper.js");
vi.mock("../config.js");

describe("lcmGrepTool (CLI path)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("uses openclaw memory grep --json when CLI succeeds", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue([
      { session_key: "agent:main:main", message_id: "1", snippet: "hello" },
    ]);
    const result = await lcmGrepTool.handler({ pattern: "hello" });
    expect(result).toHaveLength(1);
    expect(cli.runOpenclawJson).toHaveBeenCalledWith(
      expect.arrayContaining(["memory", "grep", "--pattern", "hello", "--json"]),
    );
  });

  it("falls back to direct sqlite when CLI returns unsupported error", async () => {
    vi.mocked(cli.runOpenclawJson).mockRejectedValue(new Error("unknown subcommand: grep"));

    const dir = mkdtempSync(join(tmpdir(), "lcm-"));
    const dbPath = join(dir, "lcm.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messages (
        session_key TEXT,
        message_id TEXT PRIMARY KEY,
        content TEXT,
        created_at TEXT
      );
    `);
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run(
      "agent:main:main", "m1", "hello world", "2026-04-21T10:00:00Z",
    );
    db.close();

    vi.mocked(cfg.loadConfig).mockReturnValue({
      stateDir: dir,
      gatewayTokenPath: "unused",
      gatewayToken: "unused",
      lcmDbPath: dbPath,
    });

    const result = await lcmGrepTool.handler({ pattern: "hello" });
    expect(result).toHaveLength(1);
    expect(result[0].session_key).toBe("agent:main:main");
    expect(result[0].snippet).toContain("hello");

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array when CLI succeeds with non-array payload (does not fall back)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await lcmGrepTool.handler({ pattern: "x" });
    expect(result).toEqual([]);
    // config should NOT have been loaded — we only take the sqlite path on error
    expect(cfg.loadConfig).not.toHaveBeenCalled();
  });
});
