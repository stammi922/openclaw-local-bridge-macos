import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic, requireRiskPhrase } from "./_common.mjs";

function statePath() { return path.join(bridgeDir(), "state.json"); }

function cmdStatus() {
  const state = readJson(statePath(), null);
  if (!state || !state.circuitTrippedAt) {
    console.log("Circuit: clean (not tripped)");
    return;
  }
  console.log(`Circuit:         TRIPPED`);
  console.log(`Tripped at:      ${new Date(state.circuitTrippedAt).toISOString()}`);
  console.log(`Probe attempts:  ${state.probeAttempts || 0}`);
  if (state.nextProbeAt) {
    console.log(`Next probe:      ${new Date(state.nextProbeAt).toISOString()}`);
  } else {
    console.log(`Next probe:      (none — auto-probe disabled or exhausted)`);
  }
}

async function cmdProbe() {
  const { probeOnce, scheduleProbeTimer } = await import("../../rotator/index.js");
  const result = await probeOnce();
  console.log(JSON.stringify(result, null, 2));
  // Re-arm in case state.nextProbeAt changed
  try { scheduleProbeTimer(); } catch {}
}

async function cmdClear(...flags) {
  const skipProbe = flags.includes("--skip-probe");
  await requireRiskPhrase(`Manually clearing the circuit breaker — type:  I accept the risk\n> `);
  if (!skipProbe) {
    console.log("Running probe before clearing…");
    await cmdProbe();
    // If probe cleared, we're done
    const state = readJson(statePath(), {});
    if (!state.circuitTrippedAt) return;
    console.log("Probe did not succeed — clearing manually anyway.");
  }
  const state = readJson(statePath(), {});
  state.circuitTrippedAt = null;
  state.nextProbeAt = null;
  state.probeAttempts = 0;
  // Clear indefinite cooldowns on auth-cooled accounts
  for (const [label, a] of Object.entries(state.accounts || {})) {
    if (a.cooling_until === Number.MAX_SAFE_INTEGER) a.cooling_until = 0;
  }
  writeJsonAtomic(statePath(), state);
  console.log("Circuit cleared.");
}

export default async function circuitCmd(args) {
  const [verb, ...rest] = args;
  switch (verb) {
    case "status": return cmdStatus();
    case "probe":  return cmdProbe();
    case "clear":  return cmdClear(...rest);
    default:
      console.error("usage: openclaw-bridge circuit {status|probe|clear [--skip-probe]}");
      process.exit(2);
  }
}
