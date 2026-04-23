import path from "node:path";
import { bridgeDir, readJson, writeJsonAtomic } from "./_common.mjs";

export default async function rotateNowCmd() {
  const p = path.join(bridgeDir(), "state.json");
  const state = readJson(p, null);
  if (!state) {
    console.log("No state.json yet — nothing to rotate.");
    return;
  }
  state.lastMainLabel = null;
  writeJsonAtomic(p, state);
  console.log("Cleared lastMainLabel. Next main request will re-pick without sticky bias.");
}
