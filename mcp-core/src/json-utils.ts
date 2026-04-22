// Narrow an unknown JSON payload (as returned by a CLI call) to an array of T,
// defaulting to [] when the payload is missing, null, or the wrong shape.
// Kept separate from cli-wrapper.ts so tests that `vi.mock("../cli-wrapper.js")`
// don't auto-mock this helper into returning undefined.
export function coerceArray<T>(raw: T[] | unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}
