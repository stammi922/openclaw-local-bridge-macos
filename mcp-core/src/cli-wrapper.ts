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
          const tail = (stderr || "").trim().split("\n").slice(-5).join(" | ");
          reject(new Error(`openclaw ${args.join(" ")} failed: ${tail || err.message}`));
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
  if (!trimmed) return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (parseErr) {
    throw new Error(`openclaw ${args.join(" ")} returned non-JSON stdout: ${trimmed.slice(0, 200)}`);
  }
}

export function runOpenclawDetached(args: string[]): ChildProcess {
  const child = spawn(OPENCLAW_BIN, args, { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return child;
}
