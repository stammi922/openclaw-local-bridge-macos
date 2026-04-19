// Classify a completed claude spawn into one of:
//   ok | rate_limit | usage_limit | auth | other
//
// Patterns are configurable via rotator.config.json.outcomePatterns;
// defaults cover the strings the Claude Code CLI emits as of 2.1.x.

export const DEFAULT_PATTERNS = {
  rate_limit: [
    /rate[\s_-]?limit/i,
    /429/,
    /too many requests/i,
    /retry[\s-]?after/i,
  ],
  usage_limit: [
    /usage limit/i,
    /5[\s-]?hour/i,
    /quota/i,
    /usage cap/i,
    /session limit/i,
  ],
  auth: [
    /not (logged in|authenticated)/i,
    /login expired/i,
    /invalid (oauth|token|credentials)/i,
    /unauthorized/i,
    /401/,
    /please run.*login/i,
  ],
};

function compile(patterns) {
  const out = {};
  for (const [k, arr] of Object.entries(patterns)) {
    out[k] = arr.map((p) => (p instanceof RegExp ? p : new RegExp(p, "i")));
  }
  return out;
}

export function classifyOutcome(exitCode, stderrTail, overrides = null) {
  if (exitCode === 0) return "ok";
  const patterns = overrides ? compile({ ...DEFAULT_PATTERNS, ...overrides }) : compile(DEFAULT_PATTERNS);
  const hay = String(stderrTail ?? "");
  // Order matters: auth > usage_limit > rate_limit (auth hides behind generic "unauthorized"
  // strings we shouldn't misclassify as rate limits).
  for (const kind of ["auth", "usage_limit", "rate_limit"]) {
    if (patterns[kind].some((re) => re.test(hay))) return kind;
  }
  return "other";
}
