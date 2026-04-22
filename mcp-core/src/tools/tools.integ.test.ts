import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { sessionsListTool } from "./sessions-list.js";
import { agentsListTool } from "./agents-list.js";
import { cronListTool } from "./cron-list.js";

// Detect whether the real `openclaw` binary is on PATH. If not, every test in
// this file is skipped (the unit tests in *.unit.test.ts still cover these
// handlers with a mocked CLI wrapper).
const hasOpenclaw = (() => {
  try {
    execSync("command -v openclaw", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const suite = hasOpenclaw ? describe : describe.skip;

let stateDir: string;
let gatewayProc: ChildProcess | undefined;
const ORIG_STATE = process.env.OPENCLAW_STATE_DIR;
// `openclaw` 2026.4.15 detects `process.env.VITEST` and silences its stdout,
// which breaks the CLI wrapper (it reads stdout to parse JSON). We scrub this
// (and a couple of related vitest vars) inside beforeAll and restore them in
// afterAll. This only affects the in-process env seen by child processes
// spawned through `execFile`; vitest itself has already finished any init
// that depends on these vars before our beforeAll fires.
const SCRUB_KEYS = ["VITEST", "VITEST_MODE", "VITEST_WORKER_ID", "VITEST_POOL_ID"] as const;
const ORIG_SCRUB: Record<string, string | undefined> = {};

suite("mcp-core integration (real openclaw CLI, ephemeral state dir)", () => {
  beforeAll(async () => {
    for (const k of SCRUB_KEYS) {
      ORIG_SCRUB[k] = process.env[k];
      delete process.env[k];
    }
    stateDir = mkdtempSync(join(tmpdir(), "oc-integ-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    // Minimal gateway token so any tool that honours it doesn't reject the
    // ephemeral state dir out of hand.
    writeFileSync(join(stateDir, "gateway-token"), "test-token-12345", "utf8");

    // `openclaw init --state-dir` doesn't exist in 2026.4.15 (plugins.allow
    // excludes "init"). The try/catch falls through to writing a stub config.
    try {
      execSync(`openclaw init --state-dir ${stateDir}`, {
        stdio: "pipe",
        timeout: 20_000,
      });
    } catch {
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({ version: 1, agents: {} }),
        "utf8",
      );
    }

    // Best-effort gateway boot on a random high port. If this fails (port
    // collision, unsupported flag, missing subcommand) we simply continue —
    // sessions_list and agents_list read local state and don't require a
    // live gateway. cron_list does require it but is .skip'd below because
    // wiring a matching gateway.remote.token into the ephemeral config isn't
    // worth the fragility for a smoke test.
    //
    // Enable by setting OPENCLAW_INTEG_SPAWN_GATEWAY=1. Leaving it off avoids
    // lock contention on OPENCLAW_STATE_DIR that would otherwise hang
    // subsequent `openclaw sessions`/`openclaw agents list` invocations.
    if (process.env.OPENCLAW_INTEG_SPAWN_GATEWAY === "1") {
      const port = 20000 + Math.floor(Math.random() * 1000);
      try {
        gatewayProc = spawn("openclaw", ["gateway", "--port", String(port)], {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          stdio: "ignore",
          detached: false,
        });
        gatewayProc.on("error", () => {
          /* swallow spawn errors so beforeAll always resolves */
        });
      } catch {
        gatewayProc = undefined;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30_000);

  afterAll(() => {
    if (gatewayProc?.pid) {
      try {
        process.kill(gatewayProc.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (stateDir && existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
    }
    if (ORIG_STATE === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIG_STATE;
    }
    for (const k of SCRUB_KEYS) {
      if (ORIG_SCRUB[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG_SCRUB[k];
    }
  });

  // Per-test timeouts are generous (20s) because `openclaw` is a node CLI
  // that loads a plugin surface on every invocation; sessions_list against
  // the real live state observed cold-start timings in the 5–10s range on
  // this machine. Raising well above the default 5s avoids flake without
  // hiding genuine hangs.
  it("sessions_list returns an array (possibly empty)", async () => {
    const result = await sessionsListTool.handler({});
    expect(Array.isArray(result)).toBe(true);
  }, 20_000);

  it("agents_list returns an array (possibly empty)", async () => {
    const result = await agentsListTool.handler({});
    expect(Array.isArray(result)).toBe(true);
  }, 20_000);

  // cron_list goes through the gateway in openclaw 2026.4.15; a bare
  // `openclaw cron list --json` against an ephemeral state dir fails with
  // `unauthorized: gateway token missing (set gateway.remote.token to match
  // gateway.auth.token)`. Wiring a matching token pair into the ephemeral
  // gateway config is more integration scaffolding than a smoke test
  // warrants — the unit test in cron-list.unit.test.ts covers the parse
  // path with a mocked CLI.
  it.skip("cron_list returns an array (requires live gateway with matching remote token)", async () => {
    const result = await cronListTool.handler({});
    expect(Array.isArray(result)).toBe(true);
  });
});
