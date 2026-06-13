# Changelog

## 0.7.0 — 2026-06-13

### Added

- **Ledger list virtualization** — above 150 filtered rows the ledger swaps from the animated grouped+sticky view to a windowed flat list (`@tanstack/react-virtual` `useWindowVirtualizer`), so the DOM stays bounded on large histories while the page keeps its natural one-hand scroll. Verified: 220 entries → ~12 rows mounted. Normal-sized lists keep the existing sticky grouped view unchanged.

### Fixed

- **Light-mode accessibility** — darkened light `--text-tertiary`/`--text-muted` and remapped accent/semantic **text** to AA-passing 700-weight variants (cyan/green/red/amber) so foreground text clears WCAG AA 4.5:1 on light surfaces; the dark neon values were 1–1.8:1 as text on light. Backgrounds/bars keep the bright tokens; dark mode untouched. Marked the decorative category-initial avatar `aria-hidden`. Contrast verified 0 failures on Pulse + Ledger, both themes.

### Changed

- `tailwind.config.js` `sans` font set to `IBM Plex Sans` (the font actually loaded), replacing the stale `Inter` reference.

## 0.6.1 — 2026-06-13

### Fixed

- **Light-mode parity** — several elements hardcoded white and disappeared (or inverted) on light surfaces. Introduced theme-aware tokens (`--marker`, `--marker-edge`, `--chart-axis`, `--chart-axis-strong`, `--app-sheen`) defined in both `:root` and `[data-theme="light"]`, fixing: the AppShell top sheen, the budget pace-marker line in `BudgetActual`, the `Sparkline` hover line + point ring, and the `prefers-contrast:more` border (which was inverting contrast in light mode).
- **Accessibility (axe-core 30 → 0 violations)** — lifted `--text-tertiary` (`#778399→#8a96aa`) and `--text-muted` (`#6c778a→#828da1`) to clear WCAG AA 4.5:1 on elevated surfaces while staying below `--text-secondary` (hierarchy preserved); added a visually-hidden page `<h1>`.

## 0.6.0 — 2026-06-13

### Added

- **Light mode** — full theme system with **System / Dark / Light** options in Settings. System mode tracks `prefers-color-scheme` with a live listener and flips instantly when the OS theme changes. Choice persists to `localStorage` (`spendtrack:theme`). Implemented purely through CSS custom-property overrides under `[data-theme="light"]` plus Tailwind surface colors rewired to `rgb(var(--surface-N-ch) / <alpha-value>)` channel vars so every `bg-surface-*` utility (and its opacity modifiers) adapts at runtime.
- **Multi-currency** — 8 currencies (USD, SGD, EUR, GBP, JPY, MYR, AUD, CAD) selectable in Settings, persisted to `localStorage` (`spendtrack:currency`). New `useFormatMoney()` hook binds the active currency to `formatMoney()` reactively across all 13 display call-sites; the compact path resolves each currency's symbol via `Intl.NumberFormat.formatToParts`.

### Fixed

- **E2E CRUD coverage** — the two previously `fixme`'d Playwright specs (add-expense, backup/restore) now run green; root cause was tests assuming `/entry` and `/settings` were routes when they are an in-app sheet and drawer.
- **CI format gate** — `index.css` and two pulse files were not Prettier-clean, turning the `Validate` job red. Reformatted; CI is green again.

### Changed

- **Fonts** — Google Fonts switched from `display=swap` to `display=optional`, avoiding FOIT on slow connections.

## 0.5.0 — 2026-05-08

### Added

- **Brand identity refresh** — new logo and favicon derived from the app's signature **PaceRing** data viz. Identical mark used across favicon, in-app `SpendLogo`, apple-touch-icon, and PWA install icon.
- **Storage quota guard** — every `localStorage` write goes through `safeSet()` which catches `QuotaExceededError`, dispatches a custom event, and surfaces a user-facing toast. Previously silent data loss.
- **JSON import hardening** — 8 MB file cap, deep schema validation (id/amount/date/category required), 50K-entry safety limit, specific error messages.
- **Supabase retention helpers** — `supabase/migrations/002_sync_indexes.sql` adds `created_at`, an index on `updated_at`, and a `prune_stale_sync_buckets()` function for housekeeping.
- **README refresh** — fresh screenshots, full architecture block, sync deep dive, performance + stability tables, hero banner.

### Fixed

- **Rapid-nav blank-render bug** — Pulse and Insights screens could render blank when the user tapped between tabs faster than the framer-motion exit animation. Eliminated by removing the route-level `AnimatePresence` wrapper and migrating to a CSS-keyframe `.route-fade-in`. **Verified across 290 stress-test iterations on dev / production / mobile / 4× CPU-throttled builds — 0 blanks.**
- `addExpense` now rejects non-finite or non-positive amounts at the store boundary.
- `renameCategory` is collision-safe — merges into the existing target category instead of duplicating.
- Undo stack drops expired entries on every `consumeUndo`.

### Changed

- **Sync hardening** — single in-flight `Promise` lock kills push-during-pull races. Realtime auto-reconnects on `CLOSED`/`CHANNEL_ERROR`/`TIMED_OUT`. Push retries with exponential backoff (1.5 s × 2ⁿ, capped at 2 min). Pre-flight payload size guard rejects writes >1 MB. Tombstone array capped at 1000.
- **Performance** — Supabase JS SDK is now lazy-loaded via dynamic `import()` (~25 kB gzip moved off the critical path). `SettingsDrawer` is lazy via `React.lazy()`. Hydration deferred from module-load to a `useEffect` so first paint is unblocked.
- **Bundle** — main `index.js` shrank from 142.9 KB → **83.7 KB gzip** (−41 %).
- **`tabular-nums` on `body`** — every digit aligns vertically across the entire app.

### Removed

- Dead `formatCurrency` and duplicate `generateColorFromString` helpers (canonical equivalents already lived in `lib/format.ts` and `lib/analytics.ts`).
- Stray `spendtrack-backup-2026-05-02.json` from repo root.

## 0.3.0 — 2026-05-02

### Added

- **Browser smoke test in CI** — boots `vite preview`, asserts all four routes (`/`, `/pulse`, `/ledger`, `/insights`) plus the service worker and PWA manifest.
- **Test suite expansion** — focused unit tests for analytics (`computeMonthAnalytics`, `computeWeekAnalytics`, `colorFromString`), storage (round-trip, corruption recovery), formatting (`formatMoney`, `formatInt`), and helpers (validation, migration, color hashing). Total: 36 tests across 6 files.

### Security

- Resolved 4 high-severity advisories in the `vite-plugin-pwa → workbox-build → @rollup/plugin-terser → serialize-javascript` chain by pinning `serialize-javascript@^7.0.5` via npm `overrides`. `npm audit` now reports 0 vulnerabilities.

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
