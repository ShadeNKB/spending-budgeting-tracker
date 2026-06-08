# Spike — Throwaway Experiments

*Adapted from Hermes Agent's `spike` skill (MIT, NousResearch/hermes-agent).*

---

Use when the user wants to **feel out an idea** before committing to a real build. Spikes are disposable. Throw them away once they've paid their debt.

Triggers: "try this", "see if X works", "spike it", "before I commit", "quick prototype", "is this even possible?", "A vs B?"

## When NOT to spike

- The answer is knowable from docs or reading code → just research, don't build
- The work is on the production path → use `prompts/plan.md` instead
- The idea is already validated → jump to implementation

## The loop

```
decompose  →  research  →  build  →  verdict
   ↑__________________________________________↓
                  iterate on findings
```

### 1. Decompose

Break the idea into 2–5 independent feasibility questions. Each is one spike. Frame as Given/When/Then:

| # | Spike | Validates | Risk |
|---|---|---|---|
| 001 | ws-sync-realtime | Given an active Supabase channel, when a remote write happens, then the client receives the row in <500 ms | High |
| 002a | recurring-detect-heuristic | Given 12 months of expenses, when run, then recurring entries surface with <10% false positives | Med |
| 002b | recurring-detect-stats | Same question, different approach (z-score on intervals) | Med |

**Order by risk.** Run the spike most likely to kill the idea first. No point prototyping the easy part if the hard part doesn't work.

### 2. Build

- Branch: `spike/<NNN>-<slug>` — never merge to `main`.
- Location: `spikes/<NNN>-<slug>/` at repo root (gitignored, see below).
- No tests, no polish, no error handling beyond what reveals the answer.
- Time-box: 30 min default. If it's taking longer, the spike is too big — decompose more.

### 3. Verdict

Write a short note inline at `docs/brain/spikes-log.md`:

```markdown
## 2026-05-25 · 001 · ws-sync-realtime
**Verdict:** ✅ feasible / ⚠️ feasible with caveats / ❌ not feasible
**Evidence:** measured 180–400 ms p95 over 50 trials on home wifi
**Decision:** proceed to plan / kill / re-spike
**Notes:** Supabase free tier rate-limits at 100 concurrent — won't matter for solo use
```

Then delete the spike branch + folder. The log is the durable artifact.

## SpendTrack-specific spike housekeeping

Add `spikes/` to `.gitignore` if not already there (it isn't — add it before your first spike). Keeps experiments off `main` automatically.

## Anti-patterns

- Spiking something the docs already answer
- Letting a spike turn into the real implementation ("just polish it up")
- Skipping the verdict — the whole point is the durable lesson
- Spiking on `main` or a feature branch (state leaks back)
