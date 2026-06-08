# SpendTrack — Development Workflow

## Session protocol
1. Read `conductor/product.md` + `conductor/tech-stack.md` before starting
2. Upgrade existing code — never rebuild unless structurally broken
3. Every change must improve functionality AND UX in the same pass
4. Run `npm run build` + `npm run typecheck` before declaring done

## Task state machine
- `[ ]` pending
- `[~]` in-progress  
- `[x]` complete
- `[!]` blocked — reason noted inline

## Branch + PR convention
- Feature: `feat/<short-description>`
- Fix: `fix/<short-description>`
- PR title: `feat: ...` / `fix: ...` / `chore: ...`
- All PRs require `Validate` CI check to pass

## Change approval gates (require manual confirmation)
- New Zustand store or store structural change
- New route / route parameter changes
- Breaking change to Expense data model
- Any change to service worker or PWA manifest

## Review checklist (run before every PR)
- [ ] TypeScript strict — `npm run typecheck` clean
- [ ] Build passes — `npm run build` clean
- [ ] No `any`, no dead code, no console.log left in
- [ ] Mobile UX tested (or manually verified in devtools mobile mode)
- [ ] npm audit 0 vulnerabilities
- [ ] Undo works for any destructive action added

## Orchestration pattern
For tasks touching 3+ independent areas, fan out:
- **Engineer A** → store / data layer changes
- **Engineer B** → UI component changes
- **Reviewer** → security, perf, arch, testing, a11y (5 dimensions)
File ownership: one engineer per file — no concurrent edits.

## Emergency rollback
```bash
git revert HEAD --no-edit
git push
```
Vercel auto-deploys the revert within ~60s.
