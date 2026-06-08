# Bugs Fixed — Recurring Patterns

Not a changelog (that's `CHANGELOG.md`). This is the **distilled patterns** — the classes of bug that have bitten us more than once. Read before touching the relevant area.

## Sync

- **`GRANT` is not RLS.** Granting `INSERT`/`UPDATE` on a Supabase table doesn't restrict who reads/writes which rows — Supabase ignores grants when RLS is enabled but policies are missing. Either `ENABLE ROW LEVEL SECURITY` + define policies, or `DISABLE ROW LEVEL SECURITY` explicitly. (PRs #7, #11)
  - **How to apply:** invoke `supabase-migration-safety` agent before merging any migration touching access control.

- **Client-side state can revert after a sync round-trip.** Editing a budget locally, then pulling the server snapshot ~3s later, overwrote the local edit because the pull didn't compare timestamps. Always carry `updatedAt`/`deletedAt` per field and prefer the newer side. (PR #16)

- **Push-during-pull races.** Without a single in-flight `Promise` lock, simultaneous push + pull interleave writes. Lock at the sync entry point. (PR #8)

- **Realtime connections drop silently.** Supabase realtime emits `CLOSED` / `CHANNEL_ERROR` / `TIMED_OUT` without auto-reconnect. Wire explicit reconnect on each. (PR #8)

- **Payloads can exceed Supabase row limits.** Pre-flight size guard; reject writes > 1 MB with a user-facing toast. (PR #8)

## Navigation

- **Route-level `AnimatePresence` causes blank renders on fast taps.** The `mode="wait"` exit animation gaps the new render. Replaced with CSS keyframe `.route-fade-in`. **Verified 290 stress iterations, 0 blanks.** Don't reintroduce `AnimatePresence` at the route level. (PRs #8, #9, #10)

- **Index route via `<Navigate>` causes cold-start flash.** Render the target component directly at `/` instead of redirecting. (PR — 0.2.0)

## Storage

- **Silent data loss on `QuotaExceededError`.** `localStorage.setItem` throws when full and the catch happens deep in Zustand persist. Every write must go through `safeSet()` which catches, fires a custom event, and surfaces a toast. (0.5.0)

- **Invalid expense amounts crash analytics later.** Validate at the store boundary in `addExpense` — reject non-finite, non-positive. Don't validate at the UI only. (0.5.0)

- **Category rename can duplicate.** `renameCategory` must merge into the target if it already exists, not create a parallel category. (0.5.0)

- **JSON import is an attack surface.** 8 MB file cap, deep schema validation (id/amount/date/category required), 50K-entry hard limit. (0.5.0)

## Performance

- **Eager Supabase SDK import is ~25 KB gzip on the critical path.** Lazy-load via dynamic `import()` inside the sync service. (0.5.0)
- **Settings drawer doesn't need to be on first paint.** `React.lazy()` it. (0.5.0)
- **Vendor chunk bloat.** Keep `vendor-react`, `vendor-motion`, `vendor-utils` split in `vite.config.js`. (0.2.0)

## Workflow

- **`vitest run --passWithNoTests` hides regressions.** Drop the flag (done 0.6.0).
- **Bundle creeps silently.** `npm run size` budget catches it; raise budgets deliberately when adding a dep, with a commit note. (0.6.0)

## Adding to this file
One bullet per pattern. Format: **bold rule** + 1–2 sentences. Optionally add **How to apply:** if non-obvious. Link the PR if there's useful context. Don't paste full postmortems — that's what git history is for.
