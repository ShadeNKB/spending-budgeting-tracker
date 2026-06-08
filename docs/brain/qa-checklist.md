# QA Checklist

Gates to run before merging or releasing. Copy the relevant list into your PR body so the work is verifiable.

## Every PR (≈2 min)
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run test:run` clean
- [ ] `npm run build` clean
- [ ] `npm run size` within budget (or budget raised in same commit with a note)
- [ ] `npm run format:check` clean (run `npm run format` if not)
- [ ] No new `any`, no `console.log`, no dead code
- [ ] Diff fits the PR title — no scope creep

## UI changes (add to above)
- [ ] Mobile viewport check via DevTools (375×667)
- [ ] Keyboard-only navigation works
- [ ] Focus rings visible
- [ ] Run `design-taste` agent on the diff
- [ ] Screenshot before + after in PR body

## Storage / data model changes
- [ ] `safeSet()` used, never raw `localStorage.setItem`
- [ ] Date strings stored as `T12:00:00` ISO
- [ ] Validation at store boundary, not just UI
- [ ] Backup → clear all → restore round-trip works
- [ ] Migration path for existing persisted state (if shape changed)

## Supabase / sync changes
- [ ] `supabase-migration-safety` agent run on any new `.sql`
- [ ] RLS explicitly enabled-with-policies OR explicitly disabled
- [ ] Sync still optional — app works fully offline
- [ ] In-flight lock not bypassed
- [ ] Payload size guard not bypassed
- [ ] Tested with realtime channel dropped + reconnected

## Cross-device sync QA (manual)
- [ ] Device A: add expense → appears on Device B within ~3 s
- [ ] Device A offline → add expense → reconnect → syncs without dupes
- [ ] Edit same expense on A and B near-simultaneously → last-write-wins is sensible, no data loss
- [ ] Logout + re-login on B → state restored cleanly

## Pre-release (version bump)
- [ ] All "Every PR" gates pass on `main`
- [ ] `CHANGELOG.md` updated with Added / Fixed / Changed / Removed
- [ ] `package.json` version bumped (semver: fixes = patch, features = minor)
- [ ] `npm audit` reports 0 vulnerabilities
- [ ] Smoke test passes on production URL after Vercel deploy
- [ ] Service worker cache version handled — installed clients update cleanly

## Accessibility spot-check (every UI release)
- [ ] `npm run preview` then `npm run a11y` (axe against `:4173`) — 0 violations
- [ ] Tap targets ≥ 44×44 px on mobile
- [ ] WCAG AA contrast on every text+bg pairing
- [ ] No hover-only affordances

## Production readiness (before promoting a new feature)
- [ ] Works on iOS Safari + Android Chrome + desktop Chrome/Firefox
- [ ] Undo works for every new destructive action
- [ ] Error states have a user-visible toast (never silent failure)
- [ ] PWA install still works, install banner not regressed
