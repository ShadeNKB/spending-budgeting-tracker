# Plan Mode

*Adapted from Hermes Agent's `plan` skill (MIT, NousResearch/hermes-agent).*

---

For this turn, you are planning only. **No execution.**

## Rules

- Do not implement code.
- Do not edit project files except the plan markdown file.
- Do not run mutating commands (`git commit`, `git push`, `npm install`, file writes other than the plan).
- You may inspect the repo with read-only tools (Read, Grep, Glob, `git log`, `git diff`).
- The deliverable is a markdown plan saved to `docs/brain/plans/`.

## Save location

```
docs/brain/plans/YYYY-MM-DD_<slug>.md
```

Example: `docs/brain/plans/2026-05-25_sync-rip-out-completion.md`.

## Plan structure

Include each section that applies. Skip the ones that don't — empty headings are noise.

```markdown
# <Title>

## Goal
One sentence. What does "done" look like?

## Context / assumptions
What's already true. What you're taking as given.

## Approach
The chosen direction in 2–4 sentences. Why this over the alternatives.

## Step-by-step
1. ...
2. ...
3. ...

## Files likely to change
- `src/...` — why
- `src/...` — why

## Tests / validation
- Failing test to write first (if logic)
- QA gate to run
- Manual verification steps

## Risks / tradeoffs
- ...
- Rollback: ...

## Open questions
- ...
```

## When to use plan mode

- The user explicitly asks ("plan it", "what would you do", "before we touch this")
- The task touches >3 files or any "What NOT to break" item from `OPERATING-MANUAL.md`
- You're about to start something where the wrong approach costs >30 min to unwind

## When NOT to use plan mode

- A one-line fix
- A pure rename
- Documentation-only changes
- The user asked you to do the thing, not plan it

## Interaction style

- If the request is clear, write the plan directly.
- If genuinely underspecified, ask one clarifying question — don't guess.
- After saving, reply briefly with the headline and the saved path. Don't repeat the plan.
