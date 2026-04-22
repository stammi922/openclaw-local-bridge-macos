import { execFile, spawn, type ChildProcess } from "node:child_process";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 20 * 1024 * 1024; // 20 MB — sessions list can be large

export async function runOpenclawRaw(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      OPENCLAW_BIN,
      args,
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          const nodeErr = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
          const tail = (stderr || "").trim().split("\n").slice(-5).join(" | ");
          const timedOut = nodeErr.killed === true && nodeErr.signal === "SIGTERM";
          const prefix = timedOut ? "timed out" : "failed";
          const wrapped = new Error(
            `openclaw ${args.join(" ")} ${prefix}: ${tail || err.message}`,
            { cause: err },
          );
          (wrapped as Error & { exitCode?: number; timedOut?: boolean }).exitCode =
            typeof nodeErr.code === "number" ? nodeErr.code : undefined;
          (wrapped as Error & { exitCode?: number; timedOut?: boolean }).timedOut = timedOut;
          reject(wrapped);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function runOpenclawJson<T = unknown>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  const stdout = await runOpenclawRaw(args, opts);
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`openclaw ${args.join(" ")} returned empty stdout; expected JSON`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (parseErr) {
    throw new Error(`openclaw ${args.join(" ")} returned non-JSON stdout: ${trimmed.slice(0, 200)}`, { cause: parseErr });
  }
}

export function runOpenclawDetached(args: string[]): ChildProcess {
  // openclaw.json uses `"agentDir": "./agents/main"` — a relative path that
  // resolves against cwd. When we inherit cwd from launchd (which defaults
  // to "/"), openclaw tries to mkdir '/agents' and dies with ENOENT. Anchor
  // the child at HOME so `./agents/main` resolves to the canonical
  // ~/.openclaw/agents/main directory that the real openclaw state lives in.
  const cwd = process.env.HOME || undefined;
  const child = spawn(OPENCLAW_BIN, args, { detached: true, stdio: "ignore", env: process.env, cwd });
  child.unref();
  return child;
}
