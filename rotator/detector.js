// Pure function. No I/O. Classifies subprocess outcome from exit code + tail of stderr.
//
// Exit code wins: successful CLI runs (exit 0) are ALWAYS "ok" even if stderr mentions
// rate-limit-ish strings (the CLI sometimes warns on successful turns).

export const DEFAULT_PATTERNS = {
  rate_limit: /\b(rate[_ ]limit|rate_limit_error|HTTP[:\s]*429|too many requests)\b/i,
  usage_limit: /\b(usage[_ ]limit|5[-\s]?hour usage|usage window (exhausted|reached)|quota exhausted)\b/i,
  auth: /\b(authentication failed|unauthori[sz]ed|invalid_grant|oauth token (invalid|expired)|401|please run ['"]?claude login)\b/i,
};

export function classifyOutcome(exitCode, stderrTail, patterns) {
  if (exitCode === 0) return "ok";
  if (exitCode === null || exitCode === undefined) return "other";
  const p = patterns || DEFAULT_PATTERNS;
  const s = typeof stderrTail === "string" ? stderrTail : "";
  if (p.rate_limit && p.rate_limit.test(s)) return "rate_limit";
  if (p.usage_limit && p.usage_limit.test(s)) return "usage_limit";
  if (p.auth && p.auth.test(s)) return "auth";
  return "other";
}
