# SpendTrack — Product Context

## What it is
A personal finance PWA for tracking daily spending against monthly budgets. Mobile-first, offline-capable, installable.

## Who it's for
Shade — NSF on limited income. Sessions are short and unpredictable. The app must be fast to open, fast to add an entry, and instantly informative at a glance.

## Core value prop
Frictionless expense capture → instant budget awareness → no spreadsheet required.

## Live URLs
- https://spendtrack-demo.vercel.app
- https://spending-tracker-omega.vercel.app

## GitHub
- Repo: ShadeNKB/spending-budgeting-tracker
- Branch protection: `Validate` CI check required on `main`

## Current version: 0.3.0
All v3.x roadmap items closed via PRs #3–#6.

## User flows (priority order)
1. **Add expense** — SmartInput (natural language) or ⌘K → "Add expense" or ⌘N or TabBar Plus
2. **Check budget** — Pulse view: PaceRing + month total + category breakdown
3. **Browse history** — Ledger: date-grouped, swipe-delete, tap-to-edit
4. **Understand patterns** — Insights: week bar chart, heatmap, recurring detection, 14-day forecast

## Non-negotiable UX rules
- Every interaction must work with one hand on mobile
- Dark mode only
- Haptic feedback on destructive actions
- Undo always available after delete
- All dates stored T12:00:00 (timezone-safe)
