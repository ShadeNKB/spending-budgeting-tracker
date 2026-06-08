# SpendTrack Brain

Local "second brain" for this repo. Everything an AI session (or future-you) needs to work effectively here, written in plain markdown. No external tools.

## Read order for a fresh session
1. **[OPERATING-MANUAL.md](OPERATING-MANUAL.md)** — start here. The single doc that orients you.
2. **[bugs-fixed.md](bugs-fixed.md)** — recurring failure patterns. Read before touching sync, navigation, or storage.
3. **[qa-checklist.md](qa-checklist.md)** — gates to run before any PR.
4. **[backlog.md](backlog.md)** — known issues and deferred improvements.

## Prompt templates (`prompts/`)
Paste these at the top of a task to anchor the session.

| File | Use when |
|---|---|
| [debug.md](prompts/debug.md) | A bug is reported — runs the 4-phase systematic-debugging loop |
| [plan.md](prompts/plan.md) | You want a written plan, not execution |
| [spike.md](prompts/spike.md) | Validating an idea before committing — disposable experiment |
| [dogfood-qa.md](prompts/dogfood-qa.md) | Exploratory web QA pass via Playwright MCP |
| [ui-polish.md](prompts/ui-polish.md) | Tightening a UI surface against `docs/design-anti-patterns.md` |
| [perf-pass.md](prompts/perf-pass.md) | Bundle size, render perf, or interaction lag |
| [pr-summary.md](prompts/pr-summary.md) | Drafting a PR title + body from a diff |

See [hermes-patterns.md](hermes-patterns.md) for the provenance of debug/plan/spike/dogfood-qa (ported from NousResearch/hermes-agent, MIT).

## Where other docs live (don't duplicate here)
| Topic | Location |
|---|---|
| Product vision, UX rules | `conductor/product.md` |
| Stack, data model, components | `conductor/tech-stack.md` |
| Branch / PR convention, workflow | `conductor/workflow.md` |
| Multi-agent orchestration playbook | `docs/orchestration.md` |
| Concrete UI anti-patterns to grep | `docs/design-anti-patterns.md` |
| User-facing docs | `docs/USER_GUIDE.md` |
| Skill + agent registry | `.claude/CLAUDE.md` |
| Release history | `CHANGELOG.md` |

## Maintenance rules
- Keep every file in this folder under ~80 lines. Split, don't sprawl.
- When you fix a recurring class of bug, add one bullet to `bugs-fixed.md` with a `Why:` line — not a postmortem.
- When you finish a session that taught you something durable, update the relevant file. Stale docs are worse than no docs.
- If a file hasn't been touched in 6 months and nothing references it, delete it.
