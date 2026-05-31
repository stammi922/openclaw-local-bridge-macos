// rate-resilience/classify.js
// Pure classifier for Claude Code CLI rate-limit signals. No external deps.
// Returns { subtype: "usage"|"burst", retryAfterMs: number|null } or null.

const BURST_RE = /Server is temporarily limiting requests|temporarily limiting requests \(not your usage limit\)|·\s*Rate limited/i;
const USAGE_RE = /usage limit reached|usage limit for this period|rate_limit_error|HTTP 429|too many requests/i;
const RESET_AT_RE = /reset(?:s)?\s+at\s+([^\n.]+)/i;
const RESET_IN_RE = /reset(?:s)?\s+in:?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i;
const EPOCH_RE = /usage limit reached\|(\d{9,})/i;

export function classifyRateLimit(stderrTail, exitCode) {
  // Exit code 0 means the turn succeeded; never treat as rate-limited.
  if (exitCode === 0) return null;
  const s = typeof stderrTail === "string" ? stderrTail : "";
  if (!s) return null;

  if (BURST_RE.test(s)) {
    return { subtype: "burst", retryAfterMs: null };
  }
  if (USAGE_RE.test(s)) {
    return { subtype: "usage", retryAfterMs: parseUsageRetryMs(s) };
  }
  return null;
}

function parseUsageRetryMs(s) {
  const epoch = s.match(EPOCH_RE);
  if (epoch) {
    const ms = Number(epoch[1]) * 1000 - Date.now();
    return ms > 0 ? ms : null;
  }
  const rin = s.match(RESET_IN_RE);
  if (rin && (rin[1] || rin[2])) {
    const h = Number(rin[1] || 0);
    const m = Number(rin[2] || 0);
    const ms = (h * 3600 + m * 60) * 1000;
    return ms > 0 ? ms : null;
  }
  // "resets at <clock>" is timezone-ambiguous; do not guess a duration.
  return null;
}
