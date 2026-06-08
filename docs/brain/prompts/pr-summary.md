# PR Summary Prompt

Paste when you have a diff and need a PR title + body.

---

You are drafting a PR for SpendTrack. Read the diff yourself (`git diff main...HEAD`) — don't guess.

**Title** — under 70 chars, conventional prefix:
- `feat:` new user-visible capability
- `fix:` bug fix (always include the symptom, not just the cause)
- `chore:` housekeeping, tooling, docs
- `perf:` measured perf improvement
- `refactor:` no behavior change

**Body template:**
```
## What
1–3 bullets — what changed at the user/system level, not file-by-file.

## Why
The motivation. If a bug fix, link to the symptom or reproduction.

## Test plan
- [ ] typecheck, lint, test, build, size, smoke all pass
- [ ] [feature-specific verification — e.g. "Add expense → appears in Ledger"]
- [ ] [mobile screenshot if UI]
- [ ] [cross-device sync round-trip if sync layer]

## Risk
One sentence. What could regress? What's the rollback?
```

**Rules:**
- No marketing language. No emoji unless the user uses them habitually.
- Don't claim things you didn't test.
- If the diff touches a "What NOT to break" item from `OPERATING-MANUAL.md`, call it out in Risk.
- If this is a bug fix and the bug isn't already in `bugs-fixed.md`, add it in the same PR if the pattern is likely to recur.
