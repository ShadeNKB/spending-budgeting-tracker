# Overhaul baseline — 18 Oct 2026

Recorded on `main` @ `7468985` (v0.8.3) before any overhaul change. Raw logs live in the session scratchpad (`overhaul/baseline/*.log`).

## Gates

| Gate                   | Result                                                         | Note                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`            | ✅ pass                                                        |                                                                                                                                                                                                                            |
| `lint`                 | ✅ pass                                                        |                                                                                                                                                                                                                            |
| `format:check`         | ❌ fail (local only)                                           | `package.json` flagged. Root cause: `.gitattributes` is `* text=auto` + `core.autocrlf=true` → 29 tracked files check out as CRLF on Windows while Prettier enforces `endOfLine: lf`. CI (Linux) is green. Fix in Track 0. |
| `test:run`             | ✅ 39 / 39                                                     | 7 files                                                                                                                                                                                                                    |
| `build`                | ✅ pass                                                        |                                                                                                                                                                                                                            |
| `size`                 | ✅ js 653.1 / 700 KB · css 46.2 / 80 KB · total 699.3 / 800 KB | **Only ~47 KB raw JS headroom** — new features must be lazy or replace weight                                                                                                                                              |
| `smoke`                | ✅ 4 routes + sw.js + manifest                                 |                                                                                                                                                                                                                            |
| `e2e`                  | ✅ 28 / 28 (14 desktop Chromium + 14 mobile WebKit)            | WebKit binary was missing locally; installed (playwright webkit v2287)                                                                                                                                                     |
| `npm audit --omit=dev` | ✅ 0                                                           |                                                                                                                                                                                                                            |
| `npm audit` (all)      | ⚠️ 14 (2 moderate, 12 high)                                    | dev-only chain (`@axe-core/cli` and friends)                                                                                                                                                                               |

## Bundle (gzip, per chunk)

| Chunk                         | gzip     |
| ----------------------------- | -------- |
| index (app shell)             | 80.96 KB |
| vendor-motion (framer-motion) | 44.71 KB |
| vendor-react                  | 35.18 KB |
| vendor-utils                  | 20.90 KB |
| LedgerScreen                  | 13.55 KB |
| SettingsDrawer                | 5.30 KB  |
| InsightsScreen                | 4.38 KB  |
| CommandPalette                | 2.57 KB  |
| DatePicker                    | 2.13 KB  |
| AddExpenseSheet               | 1.97 KB  |
| CSS                           | 9.35 KB  |

## Codebase shape

- ~8.7k lines in `src`. Largest files: `SettingsDrawer.tsx` 549 · `useExpenseStore.ts` 490 · `LedgerScreen.tsx` 453 · `SyncPanel.tsx` 387 · `PulseScreen.tsx` 382 · `analytics.ts` 342 · `CommandPalette.tsx` 338.
- Data model: `Expense = { id, itemName, amount, category, date, notes?, createdAt, updatedAt? }`. `BackupData.version = '4.0'`.

## Measured in Phase 1 (pre-change, read-only)

axe per route (both themes), Lighthouse mobile per route, render cost at 1k / 5k expenses, and taps-to-add at 375 px are captured by the Phase 1 auditors and appended to `FINDINGS.md` → "Baseline measurements".

## Repo hygiene noted

- Local branch `chore/deps-audit-fix-2026-10` — tree identical to `main` (superseded by #28). Left in place (harmless).
- Untracked at repo root: `apex-investment-tracker.png`, `spending-tracker-omega.png`, `spendtrack-demo.png`, a mis-named `…tz_analysis.py`. Not app files; never committed.
