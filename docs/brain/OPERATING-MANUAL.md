# SpendTrack — Operating Manual

The one doc to read first. Everything else links from here.

## What this is
A local-first spending tracker. React 19 + TS strict + Vite 7 + Zustand 5 + Tailwind 3 + Supabase (optional sync) + PWA. Mobile-first, one-hand use, dark by default. All expense data lives in `localStorage`; Supabase sync is optional and never required for the app to work offline.

**Deployed:** https://spendtrack-demo.vercel.app · auto-deploy from `main`.

## How it works (5-line mental model)
1. User adds an expense via `SmartInput` (NL parsing) or `AddExpenseSheet`.
2. `useExpenseStore` (Zustand, persisted) is the single source of truth.
3. Three screens read from it: Pulse (overview), Ledger (list), Insights (trends).
4. PWA shell + service worker make it installable + offline.
5. If the user opted into Supabase sync, a debounced push/pull keeps devices aligned. **Sync is currently being rewritten** — see [backlog.md](backlog.md).

## What NOT to break
- **Date storage contract** — all dates stored as `T12:00:00` ISO strings. Anything else hits timezone bugs. See `src/utils/date.ts`.
- **`safeSet()` for localStorage** — never call `localStorage.setItem` directly; quota errors must surface a toast.
- **`addExpense` validation** — rejects non-finite / non-positive amounts at the store boundary. Don't bypass.
- **Route fade is CSS, not framer-motion** — the route-level `AnimatePresence` caused blank renders (see [bugs-fixed.md](bugs-fixed.md)). Use the `.route-fade-in` CSS keyframe.
- **PWA manifest + service worker** — changes here require a manual cache-bust check on installed clients.
- **Supabase RLS** — `GRANT` alone is *not* enough; either enable RLS with policies or explicitly disable it. See [bugs-fixed.md](bugs-fixed.md).

## Common failure points (read before changing these areas)
- **Sync layer** — race conditions, RLS confusion, payload size, tombstones. Read [bugs-fixed.md](bugs-fixed.md) §Sync.
- **Rapid route nav** — Pulse/Insights can render blank. Read §Navigation.
- **localStorage quota** — silent data loss without `safeSet()`. Read §Storage.

## How to test
```bash
npm run typecheck && npm run lint && npm run test:run && npm run build && npm run size && npm run smoke
```
Visual checks: `npm run preview` then DevTools mobile mode → click through Pulse / Ledger / Insights / Add. Keyboard-only nav pass. For UI work, run the `design-taste` agent on the diff.

For real device sync QA: see [qa-checklist.md](qa-checklist.md) §Cross-device.

## How to deploy
Push to `main`. Vercel auto-deploys in ~60s. Rollback: `git revert HEAD && git push`. Vercel ships the revert in another ~60s.

Pre-push gate (CI): typecheck · lint · format:check · test · build · size · smoke.

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
- Skills/agents: `.claude/CLAUDE.md` is authoritative.
- Operating principles: `CLAUDE.md` at repo root + the user's global `~/.claude/CLAUDE.md`.
