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
    try {
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

      vi.mocked(cfg.resolveLcmDbPath).mockReturnValue(dbPath);

      const result = await lcmGrepTool.handler({ pattern: "hello" });
      expect(result).toHaveLength(1);
      expect(result[0].session_key).toBe("agent:main:main");
      expect(result[0].snippet).toContain("hello");
      // Gateway-token-dependent loadConfig must NOT be called on the fallback path —
      // that coupling would turn "CLI down" into a hard fail.
      expect(cfg.loadConfig).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes LIKE wildcards so user pattern is treated as a literal substring", async () => {
    vi.mocked(cli.runOpenclawJson).mockRejectedValue(new Error("cli unavailable"));

    const dir = mkdtempSync(join(tmpdir(), "lcm-"));
    try {
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
      const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
      // Literal "50%": only "discount: 50% off" should match — NOT "50 items" despite
      // raw LIKE '50%' matching anything starting with "50".
      insert.run("s", "m1", "discount: 50% off", "2026-04-21T10:00:00Z");
      insert.run("s", "m2", "50 items total",    "2026-04-21T10:00:01Z");
      db.close();

      vi.mocked(cfg.resolveLcmDbPath).mockReturnValue(dbPath);

      const result = await lcmGrepTool.handler({ pattern: "50%" });
      expect(result).toHaveLength(1);
      expect(result[0].message_id).toBe("m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when CLI succeeds with non-array payload (does not fall back)", async () => {
    vi.mocked(cli.runOpenclawJson).mockResolvedValue({ unexpected: "shape" } as never);
    const result = await lcmGrepTool.handler({ pattern: "x" });
    expect(result).toEqual([]);
    // sqlite path should NOT have been taken — we only fall back on error
    expect(cfg.resolveLcmDbPath).not.toHaveBeenCalled();
  });
});
