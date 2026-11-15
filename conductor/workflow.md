# SpendTrack — Development Workflow

## Session protocol
1. Read `conductor/product.md` + `conductor/tech-stack.md` before starting
2. Upgrade existing code — never rebuild unless structurally broken
3. Every change must improve functionality AND UX in the same pass
4. Run `npm run verify` before declaring done (it includes `build` and `typecheck`)

## Task state machine
- `[ ]` pending
- `[~]` in-progress  
- `[x]` complete
- `[!]` blocked — reason noted inline

## Branch + PR convention
- Branch: `<type>/<short-description>`, e.g. `feat/`, `fix/`, `perf/`, `docs/`, `ci/`, `db/`, `chore/`
- PR title: Conventional Commits with a scope, e.g. `feat(sync): ...`, `fix(ux): ...`, `docs(sync): ...`; PRs are squash-merged
- Branch protection requires the `Validate` CI check; the data-engine simulation and E2E jobs run on every PR too and must be green
- After a merge, read the CI run on `main` before tagging a release (`docs/brain/overhaul/LEDGER.md`, 14–15 Nov 2026)
- A release bumps `version` in `package.json`, adds a `CHANGELOG.md` entry and is tagged `v<version>`

## Change approval gates (require manual confirmation)
- New Zustand store or store structural change
- New route / route parameter changes
- Breaking change to Expense data model
- Any change to service worker or PWA manifest

## Review checklist (run before every PR)
- [ ] `npm run verify` clean (backup guard, typecheck, lint, format, tests, build, size, size:relay, smoke)
- [ ] `npm run a11y` for UI changes; `npm run e2e:data` for changes to the data or sync path
- [ ] No `any`, no dead code, no console.log left in
- [ ] Mobile UX tested (or manually verified in devtools mobile mode)
- [ ] `npm audit --omit=dev --audit-level=high` clean (CI runs it)
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
