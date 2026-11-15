# SpendTrack — Operating Manual

The one doc to read first. Everything else links from here.

## What this is

A local-first spending tracker. React 19 + TS strict + Vite 7 + Zustand 5 + Tailwind 3 + Supabase (optional sync) + PWA. Mobile-first, one-hand use; Light, Dark and System themes (System by default). All expense data lives in `localStorage`; Supabase sync is optional and never required for the app to work offline. Where things live: [conductor/tech-stack.md](../../conductor/tech-stack.md).

**Deployed:** https://spendtrack-demo.vercel.app · auto-deploy from `main`.

## How it works (5-line mental model)

1. User adds an entry (expense, income or refund) via `SmartInput` (NL parsing), `AddExpenseSheet` or the palette.
2. The data engine (`src/data/local/engine.ts`, a lazy chunk over the pure core in `src/data/core`) holds the document and writes it through to one `st5:db` envelope; `useExpenseStore` is a thin Zustand facade over it.
3. Three screens read the engine's views through the store: Pulse (overview), Ledger (list), Insights (trends).
4. PWA shell + service worker make it installable + offline.
5. If the user opted into Supabase sync, the sync engine (`src/stores/syncEngine.ts`, lazy) pulls, merges per field (last-writer-wins registers) and pushes only news. On a build with the relay functions or compare-and-set, a new sync is private: encrypted on the device ([overhaul/PRIVATE-SYNC.md](overhaul/PRIVATE-SYNC.md)). See [bugs-fixed.md](bugs-fixed.md) §Sync for the failure patterns it guards against.

## What NOT to break

- **Date storage contract (the day is the truth)** — an entry carries `day` (`yyyy-MM-dd`, the owner's calendar day) and `date`. Every new or edited entry stores `date = day + 'T12:00:00'`: the floating local noon, **no `Z`, no offset** (`localNoonIso` in `src/data/core/dates.ts`). Never write `new Date(day + 'T12:00:00').toISOString()`: that is a UTC instant, and in UTC+12…+14 (Kiritimati) local noon is the previous UTC date. An edit that keeps the day keeps `date` byte-identical; a quick add with no date stores today's local day. Older dates (the 0.9.x Z instants, raw quick-add instants, bare days) are **never rewritten**: their day is `dayOf(rec) = rec.day ?? localDay(date)` in the device zone, which is what 0.9.4 showed. Ledger, Pulse, Insights, recurring, CSV, backups, the v4 mirror and the wire read `day`, never re-derive it. Never parse a bare `yyyy-MM-dd` with `new Date()` (UTC midnight); screen-side helpers are in `src/lib/dates.ts` (`readStored`, `keyToLocalNoon`). Unit tests run in Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati (on Windows set `$env:TZ` in PowerShell; Git Bash ignores IANA zones).
- **`safeSet()` for localStorage** — never call `localStorage.setItem` directly; quota errors must surface a toast.
- **Amount validation** — the core's ops (`src/data/core/ops.ts`) reject non-finite, non-positive and too-large amounts; the store's `addExpense` goes through them. Don't bypass.
- **Route fade is CSS** — a route-level `AnimatePresence` (framer-motion, removed in 0.9.4) caused blank renders (see [bugs-fixed.md](bugs-fixed.md)). Use the `.route-fade-in` CSS keyframe.
- **Motion system: CSS + Web Animations, no library** — sheets, the palette and toasts animate with CSS transitions keyed on `data-state` from `usePresence` (exits wait only on their parts' finite animations, capped); springs are `linear()` tokens in `index.css` sampled from `src/ui/spring.ts`; the ledger swipe snaps with WAAPI. Every animating module asks `prefersReducedMotion()` or carries `motion-reduce:!transform-none` (guarded by `a11y-guards.test.ts`). Never re-add an animation library: the JS budget has no room.
- **PWA manifest + service worker** — changes here require a manual cache-bust check on installed clients.
- **Supabase RLS** — `GRANT` alone is _not_ enough; either enable RLS with policies or explicitly disable it. See [bugs-fixed.md](bugs-fixed.md). The relay's end state is the deliberate third case: migration 005 turns RLS on with **no** policies, and devices reach `sync_buckets` only through the `st_sync_*` `SECURITY DEFINER` functions from 004 (owned by the table owner; RLS is not forced, so they still work). The owner applies 004 and 005 by hand, in that order and gated, and the optional 006 with or after 004: [sync-runbook.md](sync-runbook.md). Never `supabase db push` ([supabase/README.md](../../supabase/README.md)).

## Common failure points (read before changing these areas)

- **Sync layer** — race conditions, RLS confusion, payload size, tombstones. Read [bugs-fixed.md](bugs-fixed.md) §Sync.
- **Rapid route nav** — Pulse/Insights can render blank. Read §Navigation.
- **localStorage quota** — silent data loss without `safeSet()`. Read §Storage.

## How to test

```bash
npm run verify
```

It runs the backup guard, typecheck, lint, format check, unit tests, build, `size`, `size:relay` and smoke. For data or sync changes, also `npm run e2e:data` (local only); for UI, `npm run a11y`.

Visual checks: `npm run preview` then DevTools mobile mode → click through Pulse / Ledger / Insights / Add. Keyboard-only nav pass. For UI work, run the `design-taste` agent on the diff.

For real device sync QA: see [qa-checklist.md](qa-checklist.md) §Cross-device.

## How to deploy

Push to `main`. Vercel auto-deploys in ~60s. Rollback: `git revert HEAD && git push`. Vercel ships the revert in another ~60s.

CI (`.github/workflows/ci.yml`): **Validate** (backup guard · Playwright image guard · typecheck · lint · format:check · unit tests in three time zones · build · size · size:relay · smoke · production audit), then the data-engine simulation at 150 seeds and the E2E suite in three shards. Branch protection requires Validate; read the run on `main` after a merge before tagging.

## How to update this brain

- New durable lesson? Append one bullet to the right file (`bugs-fixed.md`, `qa-checklist.md`, or `backlog.md`). Add a `Why:` line. Don't write essays.
- New skill/agent? Register it in `.claude/CLAUDE.md`, not here.
- New architectural decision? Update `conductor/tech-stack.md` and link from here if it changes any "What NOT to break" rule.
- Memory across sessions: `~/.claude/projects/.../memory/MEMORY.md` (global). This brain is repo-local.

## Iron Laws (ported from Hermes-agent)

These override any "just this once" reasoning. If you're tempted to bypass one, that's the signal you need to follow it harder.

1. **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.** Symptom fixes are failure. See `prompts/debug.md` Phase 1.
2. **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST** (for pure logic — utils/stores/services). UI-only fixes use visual confirm.
3. **NO AGENT VERIFIES ITS OWN WORK.** When verifying a change, the reviewer must come in cold — either a fresh subagent or a human pass. See `code-reviewer` global skill.

## When in doubt

- UI: `docs/design-anti-patterns.md` is authoritative.
- Workflow: `conductor/workflow.md` is authoritative.
- Skills/agents: `.claude/CLAUDE.md` is authoritative (local, untracked).
- Operating principles: `.claude/CLAUDE.md` + the user's global `~/.claude/CLAUDE.md` (`.claude/` is not tracked in this repository).
