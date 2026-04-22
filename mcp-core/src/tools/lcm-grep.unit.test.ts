import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cfg from "../config.js";
import { lcmGrepTool } from "./lcm-grep.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

vi.mock("../config.js");

// Mirrors the real openclaw 2026.4.21 lcm.db schema: session_key lives on
// `conversations`, messages reference it via conversation_id.
function seedLcmDb(dbPath: string, rows: Array<{ session_key: string; content: string; seq?: number }>) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const upsertConv = db.prepare(
    "INSERT INTO conversations (session_key) VALUES (?) ON CONFLICT(session_key) DO UPDATE SET session_key=session_key RETURNING conversation_id",
  );
  const insertMsg = db.prepare(
    "INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, 'assistant', ?)",
  );
  for (const r of rows) {
    const { conversation_id } = upsertConv.get(r.session_key) as { conversation_id: number };
    insertMsg.run(conversation_id, r.seq ?? 0, r.content);
  }
  db.close();
}

describe("lcmGrepTool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads session_key via JOIN on conversations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-"));
    try {
      const dbPath = join(dir, "lcm.db");
      seedLcmDb(dbPath, [
        { session_key: "agent:main:main", content: "hello world" },
      ]);
      vi.mocked(cfg.resolveLcmDbPath).mockReturnValue(dbPath);

      const result = await lcmGrepTool.handler({ pattern: "hello" });

      expect(result).toHaveLength(1);
      expect(result[0].session_key).toBe("agent:main:main");
      expect(result[0].snippet).toContain("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes LIKE wildcards so user pattern is treated as a literal substring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-"));
    try {
      const dbPath = join(dir, "lcm.db");
      // Literal "50%" should match "discount: 50% off" but NOT "50 items".
      // Raw LIKE '%50%%' would match both if we didn't escape the '%'.
      seedLcmDb(dbPath, [
        { session_key: "s", content: "discount: 50% off", seq: 0 },
        { session_key: "s", content: "50 items total",    seq: 1 },
      ]);
      vi.mocked(cfg.resolveLcmDbPath).mockReturnValue(dbPath);

      const result = await lcmGrepTool.handler({ pattern: "50%" });

      expect(result).toHaveLength(1);
      expect(result[0].snippet).toContain("50% off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects the limit parameter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-"));
    try {
      const dbPath = join(dir, "lcm.db");
      seedLcmDb(dbPath, [
        { session_key: "s", content: "ping one",   seq: 0 },
        { session_key: "s", content: "ping two",   seq: 1 },
        { session_key: "s", content: "ping three", seq: 2 },
      ]);
      vi.mocked(cfg.resolveLcmDbPath).mockReturnValue(dbPath);

      const result = await lcmGrepTool.handler({ pattern: "ping", limit: 2 });

      expect(result).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
