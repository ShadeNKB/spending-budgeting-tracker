# SpendTrack — Product Context

## What it is
A local-first personal finance PWA for tracking daily spending against monthly budgets. Mobile-first, offline-capable, installable. The data lives on the device; cross-device sync through a Supabase relay is optional.

## Who it's for
The owner, logging daily on a phone. Sessions are short and unpredictable. The app must be fast to open, fast to add an entry, and instantly informative at a glance.

## Core value prop
Frictionless expense capture → instant budget awareness → no spreadsheet required.

## Live URLs
- https://spendtrack-demo.vercel.app
- https://spending-tracker-omega.vercel.app

## GitHub
- Repo: ShadeNKB/spending-budgeting-tracker
- Branch protection: `Validate` CI check required on `main`

## Version
The current version is `version` in `package.json`; every release is in `CHANGELOG.md` and tagged `v<version>`. What is planned and in progress is in `docs/brain/overhaul/LEDGER.md` (the overhaul's ledger) and `docs/brain/overhaul/PLAN.md`.

## User flows (priority order)
1. **Add an entry** — the quick bar on Pulse (`SmartInput`, one line of natural language), the Add sheet (TabBar Plus, Ctrl/⌘+N, Alt+N), or the palette (Ctrl/⌘+K). An entry is an Expense, Income (money in, no category) or a Refund (money back, off a category).
2. **Check budget** — Pulse: pace ring, month total, today, top categories, budget vs actual, heatmap, monthly bars, month in review.
3. **Browse history** — Ledger: date-grouped, filters in the URL, search, tap to edit, swipe or Delete to remove, each with Undo; virtualised past 150 rows.
4. **Understand patterns** — Insights: forecast, recurring charges and the ones due soon (one-tap Log).
5. **Settings** — Categories; Budgets (per category, one for the whole month, categories marked "not spending"); Backup (JSON and CSV export, import with a preview, the Recovery centre); Sync (generate or join a code, devices).

## Non-negotiable UX rules
- Every interaction must work with one hand on mobile
- Light, Dark and System themes (System is the default); both themes stay WCAG 2.2 AA (`npm run a11y`)
- Undo after every delete and every destructive change; nothing is deleted without a way back (snapshots, the journal, the Recovery centre)
- Nothing the app cannot read is thrown away: it is set aside under Needs attention
- Dates follow the date contract in `src/data/core/dates.ts` (an entry's `day` is the truth; new writes store `day + 'T12:00:00'`, no zone)
