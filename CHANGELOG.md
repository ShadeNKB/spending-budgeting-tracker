# Changelog

## Unreleased

- Planned: focused tests for parsing, analytics, storage, and recurring detection.
- Planned: browser smoke tests in CI.

## 0.2.0 — 2026-05-02

### Fixed
- Pulse blank-flash on first cold visit — index route now renders Pulse directly instead of redirecting through `<Navigate>`, eliminating the `AnimatePresence mode="wait"` exit gap.
- Mobile Ledger could not delete individual expenses — explicit delete button now visible on every row, plus a delete-with-confirm action inside the edit drawer.
- README in-page navigation links (`Quick Start`, `Features`, `How It Works`, `Stack`) now resolve correctly; previous anchors carried a phantom dash from removed emojis.

### Added
- **Clear all expenses** — Settings → Backup with two-step confirmation, removes only expense data and keeps categories/budgets.
- **Cross-platform usage card** — Settings → Backup explains laptop / phone / multi-device usage and the local-only data model.
- Demo banner now points users to the clear-all action so they can repurpose the demo for daily use.

### Changed / performance
- Vendor bundle split — `vendor-react`, `vendor-motion`, `vendor-utils` extracted; main chunk reduced from 560 KB to 279 KB (gzip 175 KB → 86 KB).
- Ledger and Insights routes lazy-loaded via `React.lazy()`.

### Removed
- Unused `chart.js` and `react-chartjs-2` dependencies (never imported).
- Dead `src/ui/Skeleton.tsx`, `.skeleton` CSS class, and unused `deleteMany` store action.

## 0.1.0

- Public GitHub release.
- Local-first expense storage using browser `localStorage`.
- Smart natural-language expense entry.
- Pulse dashboard with totals, pace, category breakdown, heatmap, and recent activity.
- Ledger with search, date/category filters, editing, deletion, and bulk actions.
- Insights for trends, forecasts, recurring expenses, and spending signals.
- JSON backup import/export and CSV export.
- GitHub Actions validation for install, typecheck, lint, tests, and build.
