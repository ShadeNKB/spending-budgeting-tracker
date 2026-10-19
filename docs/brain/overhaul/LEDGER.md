# Overhaul ledger

Resume from this file, never from memory. Updated at every phase / track boundary.

**Mandate (Shade, 18 Oct 2026):** "do a full improvement on the current spending tracker. Do a full overhaul if you will." Then: "Execute it partner. Anything is up to you. 110%. Top 0.0001% standard."
**Delegation recorded:** Shade delegated plan approval, feature selection and merges ("Anything is up to you"). Still held back for an explicit ask: anything that could lose real synced data, Supabase / Vercel config changes, new runtime dependencies.

| When           | Phase / track                | Status                                                               | Branch                                                                            | PR  | Gates                                                                 | Next          |
| -------------- | ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------- | ------------- |
| 18 Oct 2026    | Phase 0 — baseline           | ✅ done                                                              | main @ 7468985                                                                    | —   | all green except local-only format:check (CRLF, see BASELINE)         | Phase 1 audit |
| 18–19 Oct 2026 | Phase 1 — audit              | ⏳ verify pass resumed after a usage-limit cut (run wf_04caa261-52d) | —                                                                                 | —   | 10 auditors done: 201 raw → 117 merged (6 P0 · 25 P1 · 57 P2 · 29 P3) | FINDINGS.md   |
| 19 Oct 2026    | Track 0 — foundation & gates | ⏳ fixing strict-TS + ESLint errors (run wf_cffa60f7-394)            | chore/overhaul-t0-foundation (worktree C:/Users/Nkb31/dev/spendtrack-overhaul/t0) | —   | —                                                                     | review → PR   |

## Decisions (Shade, 19 Oct 2026)

- **ESLint config:** "Edit via Bash (Recommended)". One-time exception to config-guard: `eslint.config.js` rewritten via shell to ADD TypeScript + jsx-a11y coverage (strengthening only). Lands in the Track 0 PR.
- **Supabase P0 (relay readable by anyone with the public anon key):** "Build it, I apply (Recommended)". The client must work with and without the new RPC functions. Shade applies the migrations; step 2 (revoke direct table access) only after both devices run the new client.

## Incidents

- **19 Oct 2026, audit read real backups.** Auditors found Shade's real backups (`supabase/spendtrack-backup-2026-05-29.json` inside the repo folder, gitignored, never committed; and a 20 Sep 2026 backup elsewhere on disk) and used them for counts and perf baselines (e.g. "641 entries"). Nothing left the machine beyond the model session; no live Supabase was contacted. Mitigation: all scratch derived from it is purged at close-out; the in-repo backup is moved out of the repo tree (finding F-105); fixtures use invented data only.
- **Usage-limit cut** during audit verification; resumed from the run journal, cached agents replayed.
