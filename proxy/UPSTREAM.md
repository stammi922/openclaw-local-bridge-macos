# Upstream Tracking

**Upstream:** https://github.com/atalovesyou/claude-max-api-proxy.git (404 as of 2026-04-22 — repo deleted/private)
**Base version:** v1.0.0
**Base commit SHA:** eae54779fc21a8b3224c192c14e6b63490fd56d8 (from npm `gitHead` metadata)
**Source used for this fork:** npm tarball (`npm pack claude-max-api-proxy@1.0.0`) — git repo unavailable at fork time. Installed node_modules copy was inspected but was also dist-only, so the tarball was used as the canonical clean upstream artifact.
**Forked on:** 2026-04-22

## Source layout caveat

Upstream v1.0.0 on npm ships **dist-only** — there is no `src/` TypeScript tree in the published tarball. The `files` array in upstream `package.json` only includes `dist`, `docs`, `README.md`, `CONTRIBUTING.md`. Consequently:

- `proxy/src/` does not exist in this fork.
- `npm run build` (which runs `tsc`) has no sources to compile and will fail or no-op; the pre-built `dist/` is already present and is what we ship.
- Patches described below must be applied to the compiled JS in `dist/`, not to TS sources. This is handled in Task 5.

## Local patches

1. `dist/subprocess/manager.js` — `buildArgs()` (or its JS equivalent) injects `--mcp-config <path> --strict-mcp-config` when `OPENCLAW_MCP_CONFIG` env is set. See Task 5. (Originally specified against `src/subprocess/manager.ts`; retargeted to `dist/subprocess/manager.js` because no `src/` is published.)
2. `mcp-config.json.template` — new file, rendered by `install.sh`. See Task 5.
3. Carry-forward of existing user patch to `dist/adapter/openai-to-cli.js` (content-array message extraction). Recorded here for reference; no additional change made in this fork. Upstream v1.0.0 does NOT include this fix — confirmed by diffing the clean npm tarball against the user's `.bak.20260419-090833` backup of the installed copy: they are byte-identical. The patch adds an `extractContent()` helper and wraps three `msg.content` references in the system / user / assistant message branches.

## Upstream bin name

Upstream v1.0.0 exposes the binary as `claude-max-api` (mapped to `dist/server/standalone.js`), not `claude-max-api-proxy`. `install.sh` (Task 19) references this name.

## Rebase procedure

Since upstream git is unavailable as of 2026-04-22, rebasing against a new npm release works like this:
1. `npm pack claude-max-api-proxy@<new-version>`; extract.
2. Diff against our current `proxy/` tree to identify upstream changes.
3. Re-apply our local patches (items 1-3 above) on top. Note: while upstream ships dist-only, patches must be reapplied to `dist/*.js`. If a future release starts shipping `src/`, migrate patches to TS sources and rebuild.
4. Update this file's Base version and Base commit SHA (from `gitHead`).
5. Re-run unit tests and full E2E.
