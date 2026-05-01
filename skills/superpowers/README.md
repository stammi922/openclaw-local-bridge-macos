# Superpowers (vendored subset)

This directory is a curated, mechanically fix-upped vendor of skills from
https://github.com/obra/superpowers — pinned at the SHA in `VENDOR.md`.

## What is included

- brainstorming
- executing-plans
- finishing-a-development-branch
- receiving-code-review
- requesting-code-review
- systematic-debugging
- test-driven-development
- verification-before-completion
- writing-plans
- writing-skills

## What is excluded

The four meta-skills that reference Claude Code's tool inventory directly
(`using-superpowers`, `dispatching-parallel-agents`,
`subagent-driven-development`, `using-git-worktrees`) are intentionally
not vendored. See `docs/superpowers/specs/2026-05-01-openclaw-orchestration-control-design.md`.

## Sync from upstream

```bash
# run from the openclaw-local-bridge-macos repo root
git clone --depth 1 --branch main https://github.com/obra/superpowers.git /tmp/sp
node scripts/vendor-superpowers.mjs --upstream-clone /tmp/sp
git diff skills/superpowers/
```
