# OpenClaw Orchestration Control — Design

**Date:** 2026-05-01
**Status:** Approved (pending user review of this written spec)
**Tracks:** bridge installer + bundled skills

## Problem

The local bridge currently lets Anthropic's Claude Code orchestration leak through the proxy and stack on top of OpenClaw's intended orchestration. Two specific leakage paths:

1. **Proxy adapter inlines openclaw's system prompt as user-message text.** `dist/adapter/openai-to-cli.js` line 50–52 wraps `role: "system"` content in `<system>...</system>` tags inside the positional `prompt` argument to `claude --print`. Claude Code's *own* default system prompt — establishing identity, tool-use protocol, output formatting — sits above all of that, untouched. OpenClaw's system content arrives as user-visible text, layered under Claude Code's identity.
2. **Claude Code auto-loads `~/.claude/settings.json` plus its plugins.** `enabledPlugins.superpowers@claude-plugins-official: true` injects the entire Superpowers plugin (14 skills, agents, hooks) into the spawned `claude` subprocess on every request. When the agent inside the proxy "uses the TDD skill", that decision is Claude Code's plugin acting — not openclaw orchestrating.

OpenClaw is explicit about wanting to own the system prompt. From `docs/concepts/system-prompt.md` (openclaw 2026.4.29):

> *"OpenClaw builds a custom system prompt for every agent run. The prompt is OpenClaw-owned and does not use the pi-coding-agent default prompt."*

The proxy adapter is currently working against that intent.

## Goals

- **Goal A:** OpenClaw becomes the sole orchestrator of system instructions. Claude CLI sees only what openclaw chooses, with no Claude Code default prompt and no plugin auto-load.
- **Goal B:** The agent retains Superpowers' methodology behaviors (TDD, debugging, verification, brainstorming, planning, code review, writing-plans, writing-skills) — but loaded *natively* through openclaw's skill registry, not Claude Code's plugin system.
- **Goal C:** Both changes are durable across `openclaw update` cycles, idempotent, and revertable independently via git.

## Non-goals (YAGNI)

- **Not** porting Superpowers `agents/`, `commands/`, or `hooks/` directories. OpenClaw has its own subagent / slash-command / hook systems with different semantics; that translation is a separate design pass if it ever proves needed.
- **Not** vendoring Superpowers' four meta-skills (`using-superpowers`, `dispatching-parallel-agents`, `subagent-driven-development`, `using-git-worktrees`). They are tightly coupled to Claude Code's tool inventory (`Skill`, `Agent`/`TaskCreate`, `EnterWorktree`) and would teach the openclaw agent to invoke tools it doesn't have.
- **Not** switching Claude CLI auth to `ANTHROPIC_API_KEY` / `--bare` mode. We preserve Claude Max OAuth/keychain auth — billing-critical.
- **Not** maintaining a fork of Superpowers. We vendor a curated subset and bump the upstream SHA manually when releases warrant.
- **Not** writing openclaw-native replacements for the four dropped meta-skills now. Future work, if needed.

## Architecture

Two independent halves shipping under one design but committed separately so either can be reverted on its own:

```
┌──────────────────────────────────────────────────────────────────┐
│ Half 1 — Proxy isolation                                         │
│                                                                  │
│  scripts/patch-proxy-system-prompt.mjs                           │
│  ↳ patches the installed dist/adapter/openai-to-cli.js +         │
│     dist/subprocess/manager.js                                    │
│  ↳ sentinel: @openclaw-bridge:systemPrompt v1                    │
│  ↳ runs from install.sh as new step 9                            │
│                                                                  │
│  Effect:                                                         │
│   - role: "system" → claude --system-prompt <text>               │
│   - + --disable-slash-commands                                   │
│   - + --setting-sources project                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Half 2 — Skill vendoring                                         │
│                                                                  │
│  skills/superpowers/                                             │
│   ├── VENDOR.md (upstream SHA + date)                            │
│   ├── LICENSE  (copy of obra/superpowers' license)               │
│   ├── README.md (attribution + sync notes)                       │
│   └── <10 skill dirs>/SKILL.md                                   │
│                                                                  │
│  scripts/vendor-superpowers.mjs (one-off, run by maintainer)     │
│   ↳ clones obra/superpowers at a pinned SHA                      │
│   ↳ copies the 10 methodology skills                             │
│   ↳ applies mechanical fix-ups for tool-name renames             │
│   ↳ writes VENDOR.md                                             │
│                                                                  │
│  scripts/install-skills.mjs (run by install.sh as new step 10)   │
│   ↳ copies skills/superpowers/<each>/ → ~/.openclaw/skills/<each>/│
│   ↳ idempotent: skip if dest content matches                     │
└──────────────────────────────────────────────────────────────────┘
```

## Half 1 — Proxy isolation

### Adapter change (`dist/adapter/openai-to-cli.js`)

The current code (line 49–52 of the installed file):

```js
switch (msg.role) {
    case "system":
        // …
        parts.push(`<system>\n${extractContent(msg.content)}\n</system>\n`);
```

Patched: collect all `role: "system"` messages into a separate string returned alongside the prompt blob. The proxy `subprocess/manager.js` consumer takes that string and prepends `--system-prompt <text>` to claude's argv. System messages are dropped from the inline blob.

Behaviour: Claude CLI sees openclaw's system prompt as its actual system prompt, with no Claude Code default identity layered above. The `prompt` argument now contains only user-role content.

### Subprocess change (`dist/subprocess/manager.js`)

Always-on argv additions in `buildArgsImpl()`:

```js
const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", options.model,
    "--no-session-persistence",
    "--disable-slash-commands",                  // NEW
    "--setting-sources", "project",              // NEW: skip ~/.claude/settings.json (user)
    ...(systemPrompt ? ["--system-prompt", systemPrompt] : []), // NEW: from adapter
    ...(mcp ? [
        "--mcp-config", mcp,
        "--strict-mcp-config",
        "--permission-mode", mcpPermissionMode(),
    ] : []),
    prompt,
];
```

Note: `project` is the most restrictive valid setting source; the docs only allow `user, project, local`. Since the proxy spawns with `cwd=$HOME` and there is no `CLAUDE.md` in HOME, no project settings get loaded in practice — equivalent to "no settings". This avoids needing to test for `--setting-sources` accepting an empty value across Claude CLI versions.

### Patcher (`scripts/patch-proxy-system-prompt.mjs`)

Sibling of `patch-proxy-rotator.mjs` and `patch-proxy-timeout.mjs`. Sentinel: `@openclaw-bridge:systemPrompt v1`. Idempotent. Anchor patterns:
- In `manager.js` (`buildArgsImpl`): the existing `prompt` line at the end of the args array — anchor before it.
- In `openai-to-cli.js`: the existing `case "system":` block.

Tests (`scripts/patch-proxy-system-prompt.test.mjs`) — 5 cases mirroring rotator pattern:
1. Fresh patch succeeds; sentinels present in both files
2. Re-run is byte-identical
3. `--dry-run` makes no changes; reports plan
4. Missing anchor → non-zero exit with "anchor" in stderr
5. Missing proxy root → exits with error

Fixtures: minimal stubs of `manager.js` and `openai-to-cli.js` matching the live anchors, under `test/fixtures/system-prompt/`.

## Half 2 — Skill vendoring

### Layout

```
~/GitProjects/openclaw-local-bridge-macos/
└── skills/
    └── superpowers/
        ├── VENDOR.md            ← upstream SHA, vendored-at date
        ├── LICENSE              ← copied from obra/superpowers
        ├── README.md            ← attribution + sync recipe
        ├── brainstorming/SKILL.md
        ├── executing-plans/SKILL.md
        ├── finishing-a-development-branch/SKILL.md
        ├── receiving-code-review/SKILL.md
        ├── requesting-code-review/SKILL.md
        ├── systematic-debugging/SKILL.md
        ├── test-driven-development/SKILL.md
        ├── verification-before-completion/SKILL.md
        ├── writing-plans/SKILL.md
        └── writing-skills/SKILL.md
```

### Skills to vendor (10 methodology skills)

| Skill | Why we keep it |
|---|---|
| `brainstorming` | Idea-to-design dialogue. Pure methodology. |
| `executing-plans` | Plan execution discipline. Pure methodology. |
| `finishing-a-development-branch` | Merge/PR completion checklist. Pure methodology. |
| `receiving-code-review` | Review-feedback hygiene. Pure methodology. |
| `requesting-code-review` | When/how to ask for review. Pure methodology. |
| `systematic-debugging` | Phase-based debugging discipline. Pure methodology. |
| `test-driven-development` | Red-green-refactor enforcement. Pure methodology. |
| `verification-before-completion` | Evidence before claims. Pure methodology. |
| `writing-plans` | Spec-to-plan structuring. Pure methodology. |
| `writing-skills` | Skill authoring discipline. Pure methodology. |

### Skills explicitly skipped (4 meta-skills)

| Skill | Why we skip |
|---|---|
| `using-superpowers` | Entire content is "how to invoke skills via Claude Code's `Skill` tool" — semantically Claude-Code-specific. OpenClaw discovers and gates skills differently. |
| `dispatching-parallel-agents` | References Claude Code's `Agent` tool / `TaskCreate`. OpenClaw uses `sessions_spawn`. |
| `subagent-driven-development` | Same `Agent` / subagent_type assumption. |
| `using-git-worktrees` | References Claude Code's `EnterWorktree` tool. Not in openclaw. |

### Mechanical fix-up rules (run at vendor time)

`scripts/vendor-superpowers.mjs` applies these targeted text replacements after copying. They only touch references to *named tools* that openclaw also has under a different name; they do not rewrite skill structure or methodology.

| Pattern | Replacement |
|---|---|
| `the Skill tool` | `the openclaw skill loader` |
| ` Skill tool ` | ` openclaw skill loader ` |
| `superpowers:<skill-name>` | `<skill-name>` (drop plugin namespace prefix) |
| `Bash tool` | `exec tool` |

The script reports each match per file. If a target skill body has no matches, that's logged but not an error. Idempotent: re-running on already-vendored content is a no-op (replacements have already happened; second pass finds nothing new).

### Attribution

`skills/superpowers/LICENSE` is a verbatim copy of obra/superpowers' license file (MIT, per upstream — verified at vendor time).

`skills/superpowers/README.md` includes:
- Project name + upstream URL (`https://github.com/obra/superpowers`)
- Vendored commit SHA (also in `VENDOR.md` for easy diffing)
- List of 10 vendored skills
- Note that mechanical fix-ups have been applied
- Sync recipe

`skills/superpowers/VENDOR.md` is one line: the upstream SHA + ISO date, machine-readable.

### Install step (`scripts/install-skills.mjs`)

Walks `skills/superpowers/<*/SKILL.md>`, copies each skill's directory tree to `~/.openclaw/skills/<name>/`. Idempotent: if dest file matches source byte-for-byte, skip. Reports each install/skip/update on stdout. Honors `--dry-run`.

Tests (`scripts/install-skills.test.mjs`):
1. Fresh install: empty `~/.openclaw/skills/` → all 10 dirs created
2. Re-run: byte-identical (no rewrites)
3. Source-newer: dest gets updated
4. `--dry-run`: no filesystem changes; reports plan

## Install.sh integration

Current `TOTAL=15`. New `TOTAL=17` with two new steps inserted after the existing rotator/timeout patches:

```
step 7  Patch proxy to install rotator              [unchanged]
step 8  Patch proxy subprocess timeout              [unchanged]
step 9  Patch proxy system-prompt isolation         ← NEW
step 10 Install superpowers skills                  ← NEW
step 11 Scaffold rotator bridge state and link CLI  [was 9]
step 12 Patch ~/.openclaw/openclaw.json             [was 10]
step 13 Patch gateway plist (if present)            [was 11]
step 14 Render proxy plist & (re)load launchd       [was 12]
step 15 Claude Code permissions                     [was 13]
step 16 Verify                                      [was 14]
step 17 Install MCP bridge binaries                 [was 15]
```

## verify.sh additions

Two new checks:

```sh
check_sentinel "$ADAPTER" "@openclaw-bridge:systemPrompt v1" "system-prompt (adapter)"
check_sentinel "$MANAGER" "@openclaw-bridge:systemPrompt v1" "system-prompt (manager)"

skills_count=$(find "$HOME/.openclaw/skills" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
if [[ "$skills_count" -ge 10 ]]; then
  echo "  ✓ openclaw skills installed (count=$skills_count)"
else
  echo "  ✗ expected ≥10 skills in ~/.openclaw/skills/, found $skills_count"
fi
```

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenClaw's system prompt isn't actually comprehensive enough; agent loses tool-use discipline | Low — docs say it explicitly is | If observed, revert Half 1's commit and reopen the question. The skill changes (Half 2) are independent and stay. |
| Claude CLI rejects `--setting-sources project` or interprets it differently | Low | Tested at vendor time. Fallback: drop the flag, document the behavior tradeoff. |
| Skill name collision with bundled openclaw skills | Possible | OpenClaw's load precedence puts `~/.openclaw/skills/` (path 4) above bundled skills (path 5), so our copy wins. Document this. |
| Upstream Superpowers repo evolves with breaking changes to skill bodies | Possible over months | We vendor a pinned SHA; upgrades are a deliberate `vendor-superpowers.mjs` re-run, not automatic. |
| Mechanical fix-ups corrupt skill content | Low; targeted patterns | Tests cover the fix-ups against fixtures. Reviewer eyeballs `git diff` after vendor script run. |

## Sync with upstream

Procedure documented in `skills/superpowers/README.md`:

```bash
cd ~/GitProjects/openclaw-local-bridge-macos
git clone --depth 1 --branch main https://github.com/obra/superpowers.git /tmp/sp-clone
node scripts/vendor-superpowers.mjs --upstream-clone /tmp/sp-clone
git diff skills/superpowers/
git add skills/superpowers/
git commit -m "vendor: bump superpowers to <new-sha>"
```

The `vendor-superpowers.mjs` script reads upstream's commit SHA from the clone (`git rev-parse HEAD`), updates `VENDOR.md`, and applies the mechanical fix-ups.

## Future work (out of scope here)

- Native openclaw replacements for the four dropped meta-skills, referencing `/skill`, `sessions_spawn`, `update_plan`. Only if needed.
- Port Superpowers' `agents/` (subagent definitions) into openclaw's `agents.list[]` config. Only if those subagents prove valuable.
- Pin the upstream SHA via a git submodule + sync workflow if upstream churn picks up enough that manual vendoring becomes friction.

## References

- `/opt/homebrew/lib/node_modules/openclaw/docs/concepts/system-prompt.md` — openclaw owns the system prompt
- `/opt/homebrew/lib/node_modules/openclaw/docs/tools/skills.md` — AgentSkills-compatible skill loader, precedence, allowlist
- `/opt/homebrew/lib/node_modules/openclaw/docs/concepts/agent-loop.md` — full agent lifecycle
- `claude --help` — `--system-prompt`, `--disable-slash-commands`, `--setting-sources`, `--bare`
- `obra/superpowers@v5.0.7` — the upstream we vendor from (https://github.com/obra/superpowers)
