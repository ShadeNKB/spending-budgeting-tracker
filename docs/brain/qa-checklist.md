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

## Accessibility (every UI release)

- [ ] `npm run build` then `npm run a11y` (Playwright + axe-core 4.13, `e2e/a11y.spec.ts` + `e2e/keyboard.spec.ts`; the same specs run in the CI e2e job; set `E2E_PORT` when port 4173 is taken) — 0 violations:
  - axe (WCAG 2.0–2.2 A/AA + best practices) on every route and open state — Pulse month/year/empty, Ledger grouped/virtual/no results/custom range with the picker, Insights and empty, Add sheet (a chosen chip, invalid, picker), Edit sheet (a chosen chip) and its delete question, each Settings tab and its confirmations, palette results and the large-amount question, a toast, the shortcuts sheet, both error cards — in both themes, Chromium 1280 px and WebKit 375 px
  - phone: every control has a 44 × 44 px hit area no neighbour overlaps, text fields fill their boxes, nothing scrolls sideways at 320 px (the page, open dialogs, and any scroller inside them or the screen; rows built to scroll are marked `data-scroll-x`)
  - keyboard spec green: focus ring solid, ≥ 3:1 and uncut on every stop (both themes, forced colours), focus never under the header or tab bar, the modal layer stack (trap, Escape, focus return), date picker grid, palette combobox, ledger rows, confirmations, live regions, heatmap and charts, reduced motion
- [ ] `src/__tests__/a11y-guards.test.ts` green (part of `npm run test:run`): no ad-hoc focus styles, reduced motion honoured by every framer-motion module, nothing focusable under `aria-hidden`
- [ ] `e2e/double-press.spec.ts` green (part of `npm run e2e`): the second press of a double click or double tap on Save, Add, Cancel, Close, a backdrop, a palette option or a calendar day lands nowhere (no row deleted, no tab or chip pressed, no Undo)
- [ ] No hover-only affordances

## Production readiness (before promoting a new feature)

- [ ] Works on iOS Safari + Android Chrome + desktop Chrome/Firefox
- [ ] Undo works for every new destructive action
- [ ] Error states have a user-visible toast (never silent failure)
- [ ] PWA install still works, install banner not regressed
