import fs from "node:fs";
import path from "node:path";
import { bridgeDir, readJson, logPath } from "./_common.mjs";

export default async function statusCmd() {
  const reg = readJson(path.join(bridgeDir(), "accounts.json"), { mode: "single", accounts: [] });
  const state = readJson(path.join(bridgeDir(), "state.json"), { accounts: {}, recentOutcomes: [] });
  console.log(`mode:                 ${reg.mode}`);
  console.log(`accounts:             ${reg.accounts.length}`);
  if (state.circuitTrippedAt) {
    console.log(`CIRCUIT:              TRIPPED since ${new Date(state.circuitTrippedAt).toISOString()}`);
    if (state.nextProbeAt) {
      console.log(`next probe:           ${new Date(state.nextProbeAt).toISOString()}`);
    } else {
      console.log(`next probe:           (auto-probe disabled / exhausted)`);
    }
    console.log(`probe attempts:       ${state.probeAttempts || 0}`);
  } else {
    console.log(`CIRCUIT:              clean`);
  }
  if (state.poolQuietUntil && state.poolQuietUntil > Date.now()) {
    console.log(`pool quiet until:     ${new Date(state.poolQuietUntil).toISOString()}`);
  } else {
    console.log(`pool quiet:           no`);
  }
  console.log("");
  console.log("accounts:");
  for (const a of reg.accounts) {
    const s = state.accounts?.[a.label] || {};
    const cu = !s.cooling_until || s.cooling_until === 0 ? "-" :
               s.cooling_until === Number.MAX_SAFE_INTEGER ? "∞ (auth)" :
               new Date(s.cooling_until).toISOString().slice(0, 19);
    console.log(`  ${a.label.padEnd(10)} inflight=${s.inflight || 0} cooling=${cu} rlStreak=${s.rateLimitStreak || 0}`);
  }
  console.log("");
  console.log("last 10 decisions:");
  try {
    const lines = fs.readFileSync(logPath(), "utf8").trim().split("\n");
    for (const ln of lines.slice(-10)) {
      try { const e = JSON.parse(ln); console.log(`  ${e.ts || ""} ${e.event} ${e.label || ""} ${e.outcome || e.reason || ""}`); }
      catch { console.log(`  ${ln}`); }
    }
  } catch { console.log("  (no rotator.log yet)"); }
}
