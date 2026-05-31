// rate-resilience/backoff.js
// Full-jitter exponential backoff. Pure except Math.random (fine at runtime).
export const MAX_BURST_ATTEMPTS = 3;

export function computeBackoffMs(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? 2000;
  const factor = opts.factor ?? 2;
  const capMs = opts.capMs ?? 30000;
  const ceiling = Math.min(capMs, baseMs * Math.pow(factor, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * ceiling);
}
