# Overhaul ledger

Resume from this file, never from memory. Updated at every phase and track boundary.

**Mandate (Shade, 18 Oct 2026):** "do a full improvement on the current spending tracker. Do a full overhaul if you will." Then: "Execute it partner. Anything is up to you. 110%. Top 0.0001% standard."

**Delegation recorded:** Shade delegated plan approval, feature selection and merges ("Anything is up to you"). These still need an explicit ask: anything that could lose real synced data, Supabase or Vercel config changes, and new runtime dependencies.

| When           | Phase / track                      | Status                                                     | Branch / PR               | Gates                                                                                                                              | Next          |
| -------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 18 Oct 2026    | Phase 0 — baseline                 | ✅ done                                                    | main @ 7468985            | all green except local-only format:check (CRLF)                                                                                    | —             |
| 18–19 Oct 2026 | Phase 1 — audit                    | ✅ done                                                    | —                         | 201 raw → 158 findings (117 merged + 41 gap probes); **114 confirmed** (7 P0 · 14 P1 · 66 P2 · 27 P3), 1 refuted, 43 P3 unverified | `FINDINGS.md` |
| 19 Oct 2026    | Phase 2 — plan                     | ✅ approved under delegation                               | —                         | —                                                                                                                                  | `PLAN.md`     |
| 19 Oct 2026    | T0 — foundation & gates            | ✅ shipped **v0.8.4**                                      | #29                       | verify green; tests 39 → 95 in 3 TZs; e2e 28/28 Chromium + WebKit                                                                  | —             |
| 19 Oct 2026    | T3 — correct & fast numbers        | ⏳ building                                                | feat/overhaul-t3-numbers  | —                                                                                                                                  | review → PR   |
| 19 Oct 2026    | T5 — platform & resilience         | ⏳ building                                                | feat/overhaul-t5-platform | —                                                                                                                                  | review → PR   |
| 19 Oct 2026    | Data engine (T1 + T2) design panel | ⏳ judging (3 designs done, each with a passing prototype) | —                         | —                                                                                                                                  | spec → T1     |

## Decisions (Shade, 19 Oct 2026)

- **ESLint config:** "Edit via Bash (Recommended)". One-time exception to config-guard: `eslint.config.js` was rewritten through the shell to ADD TypeScript and jsx-a11y coverage (it only strengthens the config). Shipped in #29.
- **Supabase P0 (relay readable by anyone with the public anon key):** "Build it, I apply (Recommended)". The client must work with and without the new RPC functions. Shade applies the migrations. Step 2 (revoke direct table access) happens only after both devices run the new client.

## Lead decisions

- Lint rule `jsx-a11y/no-autofocus` is off. `autoFocus` is only used inside dialogs the user opens, which follows the WAI-ARIA dialog pattern. The real focus bugs are fixed in T6.
- Unit-test timezone runs on Windows must use PowerShell `$env:TZ`. Git Bash does not honour IANA TZ names, which caused one false "all green" during T0. Reviewers caught it.

## Incidents

- **19 Oct 2026, the audit read real backups.** Auditors found Shade's real backups on disk (one inside the repo folder, gitignored and never committed) and used them for size and performance baselines. Nothing left the machine beyond the model session, and no live Supabase was contacted. Mitigation: this public `FINDINGS.md` is scrubbed of every measurement taken on real data, and the unscrubbed report lives only in Shade's private vault. Scratch files derived from the backups are purged at close-out, the in-repo backup is moved out of the repo tree (F-105), and fixtures use invented data only.
- **Usage-limit cuts** interrupted the audit, T3, T5 and the design panel. Each resumed from its run journal with cached agents replayed. Build units continued from their partial diffs.
- **The audit's report-writer agent tripped a false-positive safeguard** on its very large prompt. `FINDINGS.md` was then generated deterministically from the run journal instead.
