# Backlog

Deferred work and known issues. Not a roadmap — a holding pen so good ideas don't get lost. Pull from the top.

## Active / in flight
- **Sync layer rewrite (in progress).** `syncService.ts` and `useSyncStore.ts` removed; `AppShell.tsx` still imports them — build is broken on `main`. Next: either complete the rip-out or restore the modules.

## High value, ready to start
- **Service worker cache versioning.** Manual cache-bust risk on PWA updates. Add a version constant + skip-waiting flow.
- **Recurring-expense detection accuracy.** Insights' recurring detection has false positives on irregular intervals. Tighten the heuristic in `src/utils/recurring.ts`.
- **Bundle: lazy-load `framer-motion`.** ~30 KB gzip. Most screens use trivial transitions that CSS can do.

## Quality of life
- **Inline CSV export per filter.** Currently exports all; would be nice to export the current Ledger filter set.
- **Multi-currency support.** Single currency only today. Would need format util + store field + budget per currency.
- **Keyboard shortcut hints overlay.** `?` opens a cheat sheet of `useHotkeys.ts` bindings.

## Nice to have
- **Light mode.** Dark is default and follower at best — but a follower exists by design (see anti-patterns doc). Skipping unless requested.
- **Storybook.** Component count too low to justify; revisit at ~40+ components.

## Investigations (don't act, just look first)
- Why does `format:check` flag 67 files? Likely first-time Prettier sweep needed; confirm before mass-formatting.
- Bundle js currently 597 KB — under budget but could trim. Run `perf-reviewer` skill before adding new deps.

## Done — moved out
When an item ships, delete it from here and rely on `CHANGELOG.md`. This file should never grow past one screen.
