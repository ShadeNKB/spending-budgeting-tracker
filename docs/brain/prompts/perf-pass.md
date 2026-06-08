# Performance Pass Prompt

Paste when bundle size, render lag, or interaction lag is the concern.

---

You are doing a performance pass on SpendTrack. Be data-driven — measure before and after every change.

**Procedure:**
1. **Baseline measurement.**
   - `npm run build && npm run size` — record js/css/total bytes.
   - DevTools Performance panel: record a representative interaction (e.g. add expense + nav to Insights). Note long tasks (>50 ms), layout thrash, scripting time.
   - Lighthouse mobile run on `npm run preview` — record LCP, TBT, CLS, TTI.
2. **Identify the largest culprit.** Don't optimize the second-biggest thing.
3. **Pick one of these levers:**
   - **Lazy-load** a heavy module via dynamic `import()` (precedent: Supabase SDK, SettingsDrawer).
   - **Code-split** a route or vendor chunk.
   - **Memoize** an expensive selector or component (`useMemo`, `React.memo`) — but only after confirming the work is actually repeating.
   - **Defer** non-critical work (`requestIdleCallback`, `useEffect` instead of module-load).
   - **Remove a dep.** Cheapest win — see if a small util replaces a library import.
4. **Measure again.** Reject the change if the win is <10 % or comes with UX cost.
5. **Update budgets** in `scripts/check-bundle-size.mjs` only if the new size is intentional and explained in the commit.
6. **Invoke** the `perf-reviewer` skill for an independent pass.

**Anti-patterns:**
- Memoizing everything reflexively — adds complexity, often hurts perf.
- Adding a build plugin to "optimize" without measuring.
- Lazy-loading something on the critical path (regresses LCP).
- Replacing a working lib with a smaller one that lacks edge-case handling.
