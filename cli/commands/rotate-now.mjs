#!/usr/bin/env node
// openclaw-bridge rotate-now — clears lastMainLabel so the next main request
// re-picks based on in_flight/LRU rather than stickiness. Useful to force a
// spread when you suspect an account is about to hit its limit.

import { loadState, saveState } from "./_common.mjs";

const s = loadState();
const prev = s.lastMainLabel;
s.lastMainLabel = null;
saveState(s);
console.log(`cleared lastMainLabel (was: ${prev ?? "(none)"}). Next main request will re-pick.`);
