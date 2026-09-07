# AGENTS.md

## Project

Claudian is an Obsidian plugin that embeds provider-backed coding agents in a sidebar and inline-edit flow. Claude is the default provider. Codex, OpenCode, and Pi are optional providers that plug into the same conversation model through `Conversation.providerId` and opaque provider-owned `providerState`.

Do not assume provider parity. Check each provider's `capabilities.ts`, `registration.ts`, and UI config before wiring shared behavior.

## Instruction Map

- This file is the canonical cross-agent guide. Keep shared instructions here.
- `CLAUDE.md` files should import the nearest `AGENTS.md`; do not duplicate shared guidance there.
- Before editing a scoped area, read its nearest scoped guide:
  - `src/core/AGENTS.md`
  - `src/features/chat/AGENTS.md`
  - `src/providers/claude/AGENTS.md`
  - `src/providers/codex/AGENTS.md`
  - `src/providers/opencode/AGENTS.md`
  - `src/providers/pi/AGENTS.md`
  - `src/style/AGENTS.md`

## Commands

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run lint:fix
npm run test
npm run test:watch
npm run test:coverage
```

Use focused commands while iterating. Before handing off code changes, run the narrowest meaningful verification plus broader checks when the change touches shared behavior. The default full check is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Tests mirror `src/` under `tests/unit/` and `tests/integration/`.

### Sandbox-aware verification

- Some existing tests require listening on a local port or writing fixtures under the user home directory. Sandbox restrictions can block these operations.
- When failure output confirms a sandbox denial (for example, `EPERM` or `EACCES` on those operations), rerun the same test command through the tool's supported permission escalation mechanism, subject to the active approval policy. No separate conversational confirmation is needed when the verification is already authorized. This guide does not grant permissions or override sandbox policy.
- If the same command is already known to require these permissions in the current session, request the appropriate execution permissions directly instead of repeating a known blocked run.
- Do not classify assertion failures or unrelated errors as sandbox issues, skip affected tests, or report a blocked run as passing. If escalation is unavailable or denied, report the affected tests and the verification gap.
- Keep routine retry updates brief; report the actual rerun result and any remaining failures in the final handoff. Do not modify real user data or provider-native files to make tests pass.

## Git Workflow

- `origin` is the fork (`chuan92/claudian`); `upstream` is the source repo (`YishenTu/claudian`), read-only (push disabled).
- Work happens on `integration`. Push only to `origin`; do not open PRs against upstream for fork-local features.
- Sync upstream fixes regularly from `integration`:

```bash
git fetch upstream
git merge upstream/main
npm run typecheck && npm run lint && npm run test
git push origin integration
```

- `main` (local and `origin`) is reference only; `upstream/main` is the sync source of truth. Refresh the fork's main without checkout: `git push origin upstream/main:main`.
- To contribute a fix upstream: branch from `upstream/main`, cherry-pick the commit, push to `origin`, and open a PR against `YishenTu/claudian`.

## Architecture

| Area | Ownership |
| --- | --- |
| `src/app/` | Shared settings defaults and plugin-level storage helpers |
| `src/core/` | Provider-neutral runtime, registry, storage, tool, and type contracts |
| `src/providers/*/` | Provider adaptors, provider-owned runtime protocol, history, storage, settings, and UI |
| `src/features/chat/` | Sidebar chat orchestration against provider-neutral contracts |
| `src/features/inline-edit/` | Inline edit modal and provider-backed edit services |
| `src/features/settings/` | Shared settings shell and provider tab assembly |
| `src/shared/` | Reusable UI components |
| `src/style/` | Modular CSS built into `styles.css` |

The feature layer depends on `core/` contracts, not provider internals. Provider-specific session fields belong behind typed helpers in the owning provider directory.

## Provider Rules

- Prefer provider-native behavior over local reimplementation. Adapt provider output at the boundary instead of shadowing provider features.
- Keep live streaming and history replay responsibilities separate. Live output should come from the provider runtime protocol when available; provider transcript files are the replay source.
- New provider behavior must be expressed through registries and capabilities: `ProviderRegistry`, `ProviderWorkspaceRegistry`, `ProviderChatUIConfig`, provider capabilities, and provider-owned settings reconciliation.
- Model, permission, plan-mode, command, MCP, skill, and subagent behavior is provider-specific unless the core contract explicitly makes it shared.
- When provider behavior is uncertain, inspect real runtime output first. Put throwaway scripts, traces, and handoff notes in `.context/`.

## Storage

| Path | Contents |
| --- | --- |
| `.claudian/claudian-settings.json` | Shared Claudian settings and provider-specific configuration |
| `.claudian/sessions/*.meta.json` | Provider-neutral session metadata |
| `.claude/settings.json` | Claude Code-compatible project settings, permissions, and plugin overrides |
| `.claude/mcp.json` | Claudian-managed MCP servers for Claude |
| `.claude/commands/**/*.md` | Claude slash commands |
| `.claude/skills/*/SKILL.md` | Claude skills |
| `.claude/agents/*.md` | Claude vault agents |
| `.codex/skills/*/SKILL.md` | Codex vault skills |
| `.agents/skills/*/SKILL.md` | Alternate Codex vault skill root |
| `.codex/agents/*.toml` | Codex vault subagent definitions |
| `.opencode/agent`, `.opencode/agents` | OpenCode agent definitions |
| `.pi/agent/sessions/` | Pi vault-local sessions |
| `~/.claude/projects/{vault}/*.jsonl` | Claude-native transcripts |
| `~/.codex/sessions/**/*.jsonl` | Codex-native transcripts |
| `~/.pi/agent/sessions/` | Pi user-level sessions |

## Development Rules

- Use `rg` or `rg --files` for repo searches.
- Write code, comments, identifiers, commit messages, and code blocks in English.
- Keep comments sparse. Explain non-obvious intent, protocol constraints, or invariants; do not narrate obvious code.
- Do not use `console.*` in production code.
- Preserve user data and provider-native files. Settings writers should merge with existing provider-owned data instead of clobbering it.
- Put non-committed notes, handoff files, traces, and throwaway scripts in `.context/`.
- Do not add new production dependencies without a clear need and an explicit tradeoff.

## TDD Workflow

- For new behavior or bug fixes, write or update the failing test first in the mirrored `tests/` path.
- Make the narrowest implementation change that passes the focused test.
- Refactor after the test is green, preserving the provider and feature ownership boundaries above.
- If a change cannot be tested directly, document why and cover the closest stable contract instead.

## Review Expectations

- Findings first: correctness, regression risk, API or contract ambiguity, and missing tests.
- Treat maintainability issues as real findings when they increase future change cost or failure risk.
- Call out duplicated logic, unclear ownership, and tight coupling with a concrete refactoring direction.
