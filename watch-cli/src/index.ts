#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

const { values } = parseArgs({
  options: {
    "session-id": { type: "string" },
    filter: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write([
    "openclaw-watch v0.1 — live subagent viewer",
    "",
    "Usage:",
    "  openclaw-watch                    follow all sessions under agent main",
    "  openclaw-watch --session-id X     follow a specific session",
    "  openclaw-watch --filter=subagent  only subagent-spawned children",
    "  openclaw-watch --json             machine-readable event stream",
    "",
  ].join("\n"));
  process.exit(0);
}

type RawSessionRow = {
  sessionId?: string;
  agentId?: string;
  updatedAt?: number;
  totalTokens?: number;
  abortedLastRun?: boolean;
  model?: string;
};

type DisplaySession = {
  session_id: string;
  agent?: string;
  status: "aborted" | "completed";
  updated_at?: string;
  tokens?: number;
  model?: string;
};

function normalize(raw: RawSessionRow): DisplaySession | undefined {
  if (!raw.sessionId) return undefined;
  return {
    session_id: raw.sessionId,
    agent: raw.agentId,
    status: raw.abortedLastRun === true ? "aborted" : "completed",
    updated_at:
      typeof raw.updatedAt === "number"
        ? new Date(raw.updatedAt).toISOString()
        : undefined,
    tokens: raw.totalTokens,
    model: raw.model,
  };
}

function matches(
  event: { session_id?: string } & Record<string, unknown>,
): boolean {
  const sid = typeof event.session_id === "string" ? event.session_id : "";
  if (values["session-id"] && sid !== values["session-id"]) return false;
  if (values.filter === "subagent" && !sid.startsWith("agent:main:subagent:"))
    return false;
  return true;
}

function printInitialTable(sessions: DisplaySession[]) {
  if (values.json) {
    process.stdout.write(
      JSON.stringify({ event: "snapshot", sessions }) + "\n",
    );
    return;
  }
  process.stdout.write(
    "openclaw-watch v0.1 — watching sessions (Ctrl-C to stop)\n\n",
  );
  process.stdout.write(
    "SESSION".padEnd(42) +
      "AGENT".padEnd(12) +
      "STATUS".padEnd(12) +
      "UPDATED".padEnd(12) +
      "TOKENS\n",
  );
  for (const s of sessions) {
    process.stdout.write(
      s.session_id.padEnd(42) +
        (s.agent || "-").padEnd(12) +
        s.status.padEnd(12) +
        (s.updated_at || "").slice(11, 19).padEnd(12) +
        `${s.tokens ?? 0}\n`,
    );
  }
  process.stdout.write("\n────── live events ──────\n");
}

function printEvent(e: Record<string, unknown>) {
  if (values.json) {
    process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  const ts = new Date().toISOString().slice(11, 19);
  const kind =
    typeof e.kind === "string"
      ? e.kind
      : typeof e.type === "string"
        ? e.type
        : "event";
  const sid = typeof e.session_id === "string" ? e.session_id.slice(-6) : "?";
  const body =
    typeof e.message === "string"
      ? e.message
      : typeof e.body === "string"
        ? e.body
        : JSON.stringify(e.body ?? e).slice(0, 120);
  process.stdout.write(
    `[${ts}] ${sid} ▸ ${kind.padEnd(8)} ▸ ${body.slice(0, 120)}\n`,
  );
}

async function main() {
  // --- Initial snapshot: openclaw sessions --all-agents --json → {sessions: [...]}
  const initial: DisplaySession[] = [];
  try {
    if (!values.json) {
      process.stderr.write("openclaw-watch: loading sessions…\n");
    }
    const out = execFileSync(
      "openclaw",
      ["sessions", "--all-agents", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const parsed: unknown = JSON.parse(out.trim() || "{}");
    const raw =
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: RawSessionRow[] }).sessions
        : [];
    for (const row of raw) {
      const n = normalize(row);
      if (n) initial.push(n);
    }
  } catch (err) {
    process.stderr.write(
      `openclaw-watch: sessions list failed: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
  printInitialTable(initial);

  // --- Live events: openclaw logs --follow --json (NDJSON on stdout)
  const child = spawn("openclaw", ["logs", "--follow", "--json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  child.on("error", (err) => {
    process.stderr.write(
      `openclaw-watch: logs stream failed: ${err.message}\n`,
    );
    process.exit(1);
  });

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (
      matches(event as { session_id?: string } & Record<string, unknown>)
    ) {
      printEvent(event);
    }
  });

  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    process.stdout.write("openclaw-watch: bye.\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  child.on("exit", (code) => {
    if (exiting) return;
    process.stderr.write(
      `openclaw-watch: logs stream exited (code ${code ?? "null"})\n`,
    );
    process.exit(code === 0 ? 0 : 1);
  });
}

main().catch((err: Error) => {
  process.stderr.write(`openclaw-watch: fatal: ${err.message}\n`);
  process.exit(1);
});
