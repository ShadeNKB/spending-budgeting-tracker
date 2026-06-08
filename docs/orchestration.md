# Orchestration Playbook

How Claude Code should plan work on this repo. Distilled from VoltAgent/awesome-claude-code-subagents, tuned for SpendTrack.

## When to fan out (parallel subagents)

Fan out only when **all** of these hold:
- Task touches 3+ independent files or workstreams
- Clear role separation (e.g. logic / UI / tests / review)
- Sequential time would exceed one context window

Otherwise: do it inline. Spawning an agent has overhead — it should buy back more than it costs.

## Standard pipelines

**Feature work (non-trivial)**
1. `tdd` skill — failing test first
2. `react-specialist` — implement
3. Parallel: `code-reviewer` + `perf-reviewer` if bundle-affecting
4. `security-auditor` if storage/export/input-parsing touched

**Refactor pass**
1. `refactoring-specialist` — execute the change
2. `code-reviewer` — sign-off

**UI surface change**
1. `ui-ux-pro-max` skill — design pass
2. `react-specialist` — implement
3. `design-taste` — anti-slop review against [`design-anti-patterns.md`](./design-anti-patterns.md)
4. Browser smoke check + screenshot (mobile + desktop) before PR

**Pre-release**
1. `code-reviewer` + `security-auditor` + `perf-reviewer` in parallel
2. Aggregate findings, fix highest-severity first

## Subagent inventory

Project-scoped (`.claude/agents/`):
- `react-specialist` — React 18 + Zustand + TS strict
- `refactoring-specialist` — safe behavior-preserving refactors
- `agent-organizer` — planner only, returns delegation plans
- `design-taste` — anti-slop UI review (rules in `docs/design-anti-patterns.md`)

Global skills (see `~/.claude/CLAUDE.md`): `code-reviewer`, `security-auditor`, `perf-reviewer`, `tdd`, `ui-ux-pro-max`.

## Anti-patterns (avoid)

- Spawning agents to do work the parent could finish in 2 tool calls
- Running `code-reviewer` on trivial doc/typo changes
- Parallel tracks that touch the same files (merge conflicts)
- Ignoring `agent-organizer` output and fanning out anyway
- Treating subagent reports as ground truth — verify their diffs

## Verification gates

Before any PR:
- `npm run typecheck && npm run lint && npm run test:run && npm run build` all pass
- For UI: browser smoke check
- For storage/data changes: manual export/import round-trip
