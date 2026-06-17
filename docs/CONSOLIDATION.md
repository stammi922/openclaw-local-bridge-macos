# Source-of-truth consolidation (2026-06-17)

## Decision

**`openclaw-local-bridge-macos` is the single source of truth** for the local
bridge + proxy. It is what runs on this machine. Verified by file-level
provenance audit on 2026-06-17: every file in the live deploy
(`~/.openclaw/bridge/claude-max-api-proxy/dist`) is either byte-identical to
`vendor/claude-max-api-proxy` or the exact output of this repo's
`scripts/patch-proxy-*.mjs` chain (rotator/ and rate-resilience/ trees match
`0 files differing`). The running proxy contains **zero** code from any other
repo.

## What was retired and why

- **`stammi922/openclaw-local-bridge-parallel`** (branch
  `feat/parallel-subagents-overhaul`) — a clean `src/`-based rewrite of the
  proxy (`@openclaw-local-bridge/proxy@0.1.0`). Better architecture (real
  source instead of vendored-dist + install-time patches), but **not deployed**
  and missing production features this repo ships: rotator (multi-account),
  rate-resilience (429 classify/backoff), system-prompt isolation, MCP
  injection/bypass, and the media passthrough fix. Adopting it would be a
  migration *project*, not a cleanup. **Archived** on GitHub (reversible) so it
  remains a head-start for a future clean migration.
- **`~/GitProjects/openclaw-local-bridge`** — an upstream clone
  (`ulmeanuadrian/openclaw-local-bridge`) whose only purpose was hosting the
  parallel worktree. Removed locally; re-clonable from upstream if needed.

## Idea worth keeping from the parallel rewrite

`proxy/src/workdir/manager.js` — **per-request working-directory isolation**, so
concurrent subagent turns don't collide on a shared cwd. Not in the running
proxy today. If/when parallel-subagent throughput needs it, port it here as a
new `patch-proxy-workdir.mjs` (sentinel-guarded, same convention) and verify
before deploy. Tracked here so the idea isn't lost with the archived repo.

## If you ever reconsider migrating to the `src`-based rewrite

The honest long-term win is dropping the "vendored dist + 18 install-time
monkey-patches" model for an editable source tree. That migration must first
reach feature parity with this repo's patch ledger (see `PROXY-LEARNINGS.md`)
and re-verify end-to-end against a live Mattermost image + multi-account +
rate-limit path. Until then, this repo stays canonical.
