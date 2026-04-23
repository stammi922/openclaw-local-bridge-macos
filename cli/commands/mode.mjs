import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic, requireRiskPhrase } from "./_common.mjs";

export default async function modeCmd(args) {
  const target = args[0];
  if (!target || !["single", "multi"].includes(target)) {
    console.error("usage: openclaw-bridge mode {single|multi}");
    process.exit(2);
  }
  const p = path.join(bridgeDir(), "accounts.json");
  const reg = readJson(p, { mode: "single", accounts: [] });
  if (reg.mode === target) {
    console.log(`Mode already ${target}. No change.`);
    return;
  }
  if (target === "multi") {
    if ((reg.accounts || []).length < 2) {
      console.error("Refusing to flip to multi: register at least 2 accounts first.");
      console.error("  openclaw-bridge accounts add <label>");
      process.exit(1);
    }
    await requireRiskPhrase();
  }
  reg.mode = target;
  writeJsonAtomic(p, reg);
  console.log(`Mode set to ${target}.`);
  console.log("Run: openclaw-bridge reload (optional, takes effect within 1s anyway)");
}
