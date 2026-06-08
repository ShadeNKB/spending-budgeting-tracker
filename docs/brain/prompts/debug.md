# Debug Prompt — Systematic Debugging

*Adapted from Hermes Agent's `systematic-debugging` skill (MIT, NousResearch/hermes-agent).*

---

You are debugging an issue in SpendTrack. Follow the 4 phases strictly. **You cannot propose a fix until Phase 1 is complete.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Symptom fixes are failure. If you find yourself reaching for `try/catch`, a feature flag, or a "just check if it's null" — stop. You haven't found the cause yet.

## Phase 1 — Root Cause Investigation

Before proposing ANY fix:

1. **Read the error carefully.** Stack trace end to end. Note file, line, code, message. Don't skim.
2. **Reproduce consistently.** `npm run dev` or `npm run preview`. Confirm exact steps. If you can't reproduce, gather data — don't guess.
3. **Check recent changes.** `git log --oneline -10`, `git diff`. What changed that could cause this?
4. **Check `docs/brain/bugs-fixed.md`.** If this matches a known class (sync RLS, route blank-render, localStorage quota) — apply the documented fix and skip to Phase 4 verify.
5. **Trace data flow.** For deep stacks, work *upstream* from the symptom to where the bad value originates. Fix at the source.
6. **Form a hypothesis.** State it: *"I think X is the cause because Y."* One sentence. Write it down.

**Phase 1 exit gate:** you can answer *why* it's happening. If you can only describe *what's* happening, you're not done.

## Phase 2 — Pattern Analysis

1. **Find working examples.** Grep for similar code in the codebase that works. What's different?
2. **List every difference.** Don't dismiss any as "couldn't matter."
3. **Check dependencies & assumptions.** What env, config, state does the broken path assume?

## Phase 3 — Hypothesis & Minimal Fix

1. **Write a failing test first** if the bug is in pure logic (utils, stores, services). Skip for pure UI bugs — visual confirm only.
2. **Smallest possible diff.** No drive-by refactors. No restyling adjacent code. One concern per commit.
3. **Predict the outcome.** "If my fix is right, then *X* will now happen and *Y* will stop."

## Phase 4 — Verify

1. Re-run the reproduction. Bug gone?
2. Run the QA gate: `npm run typecheck && npm run lint && npm run test:run && npm run build`.
3. If the bug touched a "What NOT to break" rule from `OPERATING-MANUAL.md`, run the full `qa-checklist.md` per-PR list.
4. **If the pattern is likely to recur, add one bullet to `docs/brain/bugs-fixed.md`** with a **Why:** line. Same PR.

## Anti-patterns (will be rejected)

- Adding `try/catch` to silence an error without understanding it
- Mocking the failing case in a test instead of fixing the cause
- Disabling a lint rule to silence the diagnostic
- "Refactoring while I'm in here" — separate PR
- Fixing the symptom upstream from where it actually breaks
