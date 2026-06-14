# Backlog

Deferred work and known issues. Not a roadmap — a holding pen so good ideas don't get lost. Pull from the top.

## Active / in flight
_Nothing in flight. Pull from High Value below when ready._

## High value, ready to start
_(all shipped 2026-06-13)_

## Quality of life
_(shipped 2026-06-13)_

## Nice to have
- **Storybook.** Component count too low to justify; revisit at ~40+ components.

## ✅ Warmer/softer redesign — COMPLETE (brief: docs/design-brief.md)
- ✅ **Foundation + Pulse** (v0.8.0) — warm surfaces, soft shadows, rounder radii, warm text, shared SectionHeader.
- ✅ **Ledger** (v0.8.1) — soft floating list via `.elevated`, unified warm day-headers, warm row-hover; radius rounding completed app-wide.
- ✅ **Insights** (v0.8.2) — theme-aware `--chart-bar` tokens fix the week chart in light; consistent card icons.
- ✅ **Entry + Settings sheets** (v0.8.3 + v0.7.1) — `--shadow-overlay` token for soft warm modal shadows; DatePicker warmed; settings controls redesigned (Segmented theme + styled currency).
  _All four surfaces shipped. Light mode AA-clean throughout; dark primary._
- ⬜ **Insights** — per-surface refinement.
- ⬜ **Entry + Settings sheets** — per-surface refinement (settings controls already redone in v0.7.1).
  _One surface per release; before/after + a11y both themes each time._
- **Per-bucket RLS lockdown (Supabase).** RLS disabled by design (sync_id = shared secret); Shade ruled leave-as-is 2026-06-13. Revisit only to tighten sync security — its own session.

## Shipped
- **Light mode** — shipped 2026-06-13 in v0.6.0. System/Dark/Light, `[data-theme]` token overrides, Tailwind surface channel vars. Released as [v0.6.0](https://github.com/ShadeNKB/spending-budgeting-tracker/releases/tag/v0.6.0).
- **Light-mode parity + a11y** — shipped 2026-06-13 in [v0.6.1](https://github.com/ShadeNKB/spending-budgeting-tracker/releases/tag/v0.6.1). Theme-aware chart/marker tokens (fixed hardcoded-white leaks), WCAG-AA text contrast (axe 30→0), page h1.
- **Ledger virtualization + light-mode a11y** — shipped 2026-06-13 in [v0.7.0](https://github.com/ShadeNKB/spending-budgeting-tracker/releases/tag/v0.7.0). @tanstack/react-virtual windowing >150 rows; light-mode text/accent contrast (axe 0 both themes); Tailwind font hygiene.

## Investigations (don't act, just look first)
- Bundle js 625 KB (under 700 KB budget). `perf-reviewer` ran 2026-06-13 — verdict FAST. No urgent action.
- Google Fonts: changed to `display=optional` 2026-06-13 — avoids FOIT on slow connections.

## Done — moved out
When an item ships, delete it from here and rely on `CHANGELOG.md`. This file should never grow past one screen.
