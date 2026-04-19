#!/usr/bin/env node
// openclaw-bridge status — one-shot overview.

import fs from "node:fs";
import {
  loadRegistry, loadState, LOG_PATH, CONFIG_PATH, healthOf,
} from "./_common.mjs";

const reg = loadRegistry();
const state = loadState();

console.log(`mode:              ${reg.mode}`);
console.log(`accounts:          ${reg.accounts.length}`);
console.log(`rotator config:    ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : "(defaults)"}`);
console.log(`rotator log:       ${LOG_PATH}`);
console.log(`last main label:   ${state.lastMainLabel ?? "(none)"}`);
console.log("");

if (reg.accounts.length > 0) {
  const rows = [["LABEL", "HEALTH", "IN_FLIGHT", "OK", "RATE", "USAGE", "AUTH", "OTHER"]];
  let authBlocked = [];
  for (const a of reg.accounts) {
    const s = state.accounts?.[a.label] ?? {};
    const c = s.counters ?? {};
    const h = healthOf(state, a.label);
    if (h === "auth-blocked") authBlocked.push(a.label);
    rows.push([
      a.label, h, String(s.in_flight ?? 0),
      String(c.ok ?? 0), String(c.rate_limit ?? 0),
      String(c.usage_limit ?? 0), String(c.auth ?? 0), String(c.other ?? 0),
    ]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => String(r[col]).length)));
  for (const r of rows) console.log(r.map((v, i) => String(v).padEnd(widths[i])).join("  "));
  if (authBlocked.length) {
    console.log("");
    console.log(`  auth-blocked accounts need a manual re-login:`);
    for (const lbl of authBlocked) {
      console.log(`    openclaw-bridge accounts test ${lbl}`);
      console.log(`      → if still failing: re-run 'openclaw-bridge accounts add ${lbl}' after 'rm --purge'`);
    }
  }
}

// Last 10 decisions from rotator.log.
if (fs.existsSync(LOG_PATH)) {
  console.log("");
  console.log("last decisions:");
  const tail = readTailLines(LOG_PATH, 10);
  for (const line of tail) {
    try {
      const evt = JSON.parse(line);
      const parts = [evt.ts, evt.event];
      if (evt.label) parts.push(`label=${evt.label}`);
      if (evt.kind) parts.push(`kind=${evt.kind}`);
      if (evt.outcome) parts.push(`outcome=${evt.outcome}`);
      if (evt.exitCode != null) parts.push(`exit=${evt.exitCode}`);
      console.log(`  ${parts.join(" ")}`);
    } catch {
      console.log(`  ${line}`);
    }
  }
}

function readTailLines(p, n) {
  try {
    const buf = fs.readFileSync(p, "utf8");
    const lines = buf.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}
