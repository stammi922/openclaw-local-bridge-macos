// rate-resilience/cap.js
// Rate-aware concurrency-cap controller. Time injectable for tests.
export function createRateAwareCap({ baseMax, cooldownMs = 60000, now = Date.now } = {}) {
  const base = Math.max(1, baseMax | 0);
  const shrunk = Math.max(1, Math.floor(base / 2));
  let cooldownUntil = 0;
  return {
    currentMax() {
      return now() < cooldownUntil ? shrunk : base;
    },
    onRateLimited(_subtype) {
      cooldownUntil = now() + cooldownMs;
      return shrunk;
    },
    _base: base,
    _shrunk: shrunk,
  };
}
