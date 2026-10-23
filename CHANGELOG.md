# Changelog

## 0.9.1 — 2026-10-21

Track 5 of the overhaul: platform, resilience and security. The app now survives deploys and screen crashes without cutting you off from your data. It also behaves properly as an installed iPhone app, keeps its own fonts offline, and is served with an enforcing Content-Security-Policy.

### Fixed

- **Opening a screen right after a deploy no longer crashes the app.** The old service worker activated each new build straight away and deleted the files the open page still needed. The next screen then received `index.html` instead of code, and React Router's developer error page replaced the whole app. The "App updated" toast meant to warn about this closed itself at once, because `duration: 0` became a 0 ms timer. Now a new build waits until you accept it. A missing `/assets/*` or `/fonts/*` file returns 404 instead of the HTML page. A stale screen file reloads the page once: at most once a minute, never while offline, and never over typed text or an open sheet (F-028).
- **One broken screen no longer locks you out.** A crash now shows a card inside the app, and the header and tab bar keep working. The card explains what happened in plain words and offers **Reload**, **Go to Pulse** and **Download my data**. Technical details sit behind a disclosure. If the app shell itself fails, a full-page version offers the same actions. Settings, the command palette, the add sheet and the hotkey list each fail on their own card (Reload / Close) and never take the app down. When the failure is because you are offline, the card says so instead of sending you to the browser's offline page (F-005, boundary half).
- **On the installed iPhone app, the header no longer sits under the status bar.** The sticky header now covers the top safe area. In landscape, the header, content and sheets clear the notch. The demo and offline banners now sit below the header (F-029).
- **No more dark flash for light-theme users.** A tiny script applies the saved theme before the first frame is drawn. The browser chrome (`theme-color`), native controls and scrollbars (`color-scheme`) follow the theme at load and on every change (F-106).
- **iOS no longer zooms the page when you tap a text field.** On touch screens, every text input, select and textarea is at least 16 px. Selects and the "More..." category chip still draw their label at the design size, so nothing grows or gets cut off. Laptop sizes are unchanged, and pinch zoom still works (F-075).
- **CSV exports are safe to open in Excel, Google Sheets and Numbers.** Any cell that would run as a formula gets a leading apostrophe: one starting with = + - @, tab or CR, including full-width versions and ones hidden behind spaces. Amounts stay numbers. Files start with a UTF-8 BOM, so non-English item names display correctly in Excel, and use CRLF line endings. A bad stored date is exported as text instead of breaking the export. Ledger and Settings now share one CSV writer (F-069).
- **The header no longer repaints 60 times a second.** The logo glow was an endless box-shadow animation under the blurred header. It caused about 600 repaints in 5 seconds while the app sat idle; now there are none. This saves battery on phones (F-099).
- **The add sheet keeps the cursor in "What".** Right after opening, the sheet used to move focus to Close. With lazy loading it could also lose the first keystrokes, or pull focus out of a field when the app re-rendered.
- **The "More categories" select in the add and edit sheets has an accessible name.** axe used to report it as a critical `select-name` error.
- **Install icons display correctly.** The transparent icons were declared "maskable", so Android launchers cropped them. There are now opaque, full-bleed maskable icons, and the iPhone home-screen icon is opaque. The manifest was linked twice and is now linked once (F-102).

### Added

- **Update banner.** When a new version is ready, a strip in the header says "A new version of SpendTrack is ready." with **Reload** and **Later**, and it never closes on its own. If you have typed something or a sheet is open, Reload asks first: "Reloading will clear what you've typed." (**Reload anyway** / **Keep editing**). Other open tabs say "SpendTrack was updated in another tab." The app checks for updates when it comes back to the foreground and every hour, at most once an hour and never while offline. After **Later**, the banner comes back 6 hours later (F-028).
- **Download my data.** Every error card can save `spendtrack-backup-raw-YYYY-MM-DD-HHmm.json` (local time). The file holds everything this browser stored, copied byte for byte without parsing, so it works even when the data is what crashed. The sync code and other secret-like keys are left out (F-005).
- **"Add expense" app shortcut.** Long-press the installed app icon (Android and desktop Chromium) to go straight to the add sheet. The shortcut opens `/pulse?add=1`; the sheet opens once, after your data has loaded, and the link is cleaned up (F-102).
- **Security headers on every response.** An enforcing Content-Security-Policy:
  - scripts only from the app itself, plus the one hashed inline theme script
  - self-hosted fonts only
  - images from the app or `data:` only
  - network connections only to the app and Supabase (https and wss)
  - no framing and no plugins

  Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that turns off camera, microphone, location, payment and device APIs (F-067).

### Changed

- **Fonts are self-hosted and work offline.** IBM Plex Sans and JetBrains Mono (latin, weights 400 to 700, SIL OFL) now ship in `public/fonts` and are precached. The render-blocking Google Fonts request is gone, and the app makes no requests to Google. The old Google Fonts cache is deleted after the first load (F-103).
- **Faster start.** framer-motion and every overlay (Settings, palette, add sheet, toasts, hotkeys) now load on first open or once the app is idle, never before first paint. `index.html` no longer preloads framer-motion. In a phone test with 4× CPU throttling and 2,000 expenses:
  - code downloaded before the page finished loading fell from 178 KB to 140 KB
  - the first tap on + now opens the add sheet in about 0.5 s instead of 1.5 s (F-051)
- **Smaller offline cache.** The service worker no longer precaches any PNG, including the 263 KB `og.png`, or any duplicate file, and now includes the 8 fonts. The precache went from 34 entries / 1,225 KiB to 30 / 906 KiB (F-098).
- **Logo glow** brightens once on load and again on hover or keyboard focus. It stays still under reduced motion (F-099).
- **Bigger phone header buttons.** The logo, palette and Settings buttons are 44 px touch targets on phones, and the bar keeps its height.
- **Installed app.** The manifest `id` stays `/pulse`, so existing installs are kept. Launching the app again focuses the window that is already open. The portrait lock is removed, so landscape works, with notch padding. Theme and splash colours now match the warm surfaces (`#0c0b0a`) (F-102, F-106).

### Changed (engineering)

- The service worker is prompt-style: `registerType: 'prompt'`, no `skipWaiting`, `clientsClaim` kept. The app registers `/sw.js` itself in production, and `registerSW.js` is no longer shipped.
- `vite preview` serves the production headers from `vercel.json`, so smoke, a11y and e2e runs happen under the real CSP.
- Every `lazy()` and `import()` goes through `importWithReload`. A contract test fails if a new unwrapped one appears (the Supabase client is the one allowed exception).
- Contract tests pin the inline-script hash to the CSP, plus the exact header values, the rewrite regex, the fonts, the icons and the theme table. This track adds 352 unit tests (1,007 in total after merging with 0.9.0, all green in three timezones) and new e2e specs: a CSP walk with negative controls, resilience tests and CSV tests (170 e2e tests pass on Chromium and iPhone WebKit). Total JS is 679.7 KB of the 700 KB budget; replacing framer-motion with CSS is planned to win back headroom.
- `ToastHost` now treats `duration <= 0` as sticky instead of closing the toast at once.
- `scripts/render-icons.mjs` renders the opaque icons with the Playwright Chromium that is already installed. No new dependencies.

## 0.9.0 — 2026-10-21

Track 3 of the overhaul: every number on screen is now correct and matches between screens, and the app no longer freezes on a real history. Money shows in your own currency (Singapore dollars on a Singapore device), and quick add understands Singapore place names and dates.

### Fixed

- **No more freezes on a real history.** At 2,000 entries, with the CPU slowed to phone speed (4× throttle), returning to Pulse took 20–25 s and a quick add took 21–33 s to show its toast. Both now take under 0.2 s. A Ledger search keystroke dropped from about 0.5 s to under 0.1 s. Every screen now reads one shared index of your entries, built once per change, instead of re-reading every date for every day; recomputing all of Pulse and Insights for 5,000 entries takes about 6 ms. (F-024, F-052, F-053, F-054)
- **"Week" in the Ledger depended on the time of day.** It covered the last 7×24 hours, so entries appeared and disappeared between morning and afternoon. It is now "Last 7 days · Oct 12 – Oct 18" by calendar day on every screen, and its total matches the Insights week card. (F-020)
- **The "vs last month" pill compared half a month with a whole one.** On 18 October it set Oct 1–18 against all of September, so you always looked under. It now compares the same days ("▲ 41.0% vs Sep 1–18"), says "vs February" when the comparison covers the whole of February, and compares full months for past months ("vs August"). The year pill works the same way ("vs 2025 to Oct 18"). (F-021)
- **Insights pacing missed the last day of last month** and projected rent or subscriptions you had already paid as if they would repeat; rent on the 1st read as "379% higher" on the 5th. It now uses whole calendar days, and it counts a monthly charge already paid once instead of projecting it. Pulse budgets use the same rule. (F-022)
- **One monthly average, and a correct one.** The year view showed two different averages and treated the current month as complete, so an even S$1,000 a month showed S$958. There is now one figure under the total. It counts the current month as partial, and a past year divides by 12. (F-023, F-101)
- **The budget ring measured all spending against your budgets.** An S$400 investment with only a Food budget turned it red. The ring now counts budgeted categories only and says so ("Budgeted categories only"). It stays in the accent colour while you are on track, and it never turns red or shows "Projected" in the first days of a month. Per-category rows follow the same rule. (F-025, GAP3-05)
- **Past months and years show their final state.** Viewing September no longer shows today's card, the ring, "days left", a heatmap ending today or the last 30 days' trend. You see that month's days, a final "S$X under" or "Over by S$X", and a trend whose total equals the headline. A past year no longer marks any month as current or future. (GAP3-01, GAP3-02, GAP3-03, GAP3-04, GAP3-08)
- **The Insights 14-day forecast showed empty bars.** The bars now have real heights whenever something is due. (F-031)
- **Heatmap:**
  - The Mon/Wed/Fri labels now line up with their rows (they were 9 px off).
  - The card no longer pushes the page sideways at 320 px.
  - It opens on the latest week, and a soft fade marks the side with more weeks.

  (F-074, F-082)

- **Recurring charges:**
  - A subscription billed on the 1st now shows as due on the 1st.
  - Monthly charges stay on their usual day of the month (the 31st becomes 30 Apr or 28 Feb), and gaps are counted in calendar days.
  - A missed charge counts once, as "due today", instead of piling up.
  - "next ~" is never a date in the past.

  An old test had locked in a wrong forecast (12 instead of 24). (F-048, F-063)

- **Money in your currency everywhere.** The hero total, cards, chart tooltips, insight text, palette, toasts and the Add/Edit/budget amount fields used a hard-coded `$`. They now use the currency you chose, with its own symbol (S$, RM, A$, C$, and ¥ without decimals). (F-070)
- **Quick add understands Singapore:**
  - Places and brands are no longer read as dates or amounts: Junction 8, Marina Bay Sands, Novena, Marine Parade, Decathlon, Sephora, Maybank, Sun Plaza, Blk 123, bus 190.
  - A date is never in the future: "31 dec" typed on 2 January means last year, and a date a few days ahead stays in the name instead of jumping back a year.
  - A year after a date is never the amount: "taxi 15 18 oct 2026" is S$15.
  - Amounts like `S$12`, `5 sgd`, `1,200` and `12,50` all read correctly, and "2 pax" or "x2" is never the amount.
  - A category word after the amount sets the category ("lunch 8.5 food").
  - Item names such as `constructor` or `__proto__` can no longer break parsing.

  (F-019, F-046, F-010 parser half)

- **Quick adds are saved on the right day.** Undated quick adds are stored at local midday, like the full form. Relative words such as "yesterday" follow the clock past midnight. (F-020)
- **CSV export no longer fails on an entry with an unreadable date.** The Ledger and Settings exporters now write the stored day, or the raw stored text when it cannot be read, instead of throwing.
- **No more double adds.** A double Enter, a held Enter or a double tap adds one entry, in quick add, the palette and the Add and Edit sheets. Confirming a Chinese (IME) word with Enter no longer saves either. (F-046)
- **An entry with an unreadable date blanked Pulse, Insights and the Ledger.** The screens now render, and the entry appears only under Ledger "All" as "Unknown date". The Edit sheet asks you to pick its day instead of silently moving it to today. (F-053)
- **Ledger:**
  - Tapping a filter just after typing a search no longer undoes the filter.
  - Opening a search from the palette fills the search box (F-080).
  - In a long list, tapping the same spot again after a swipe-delete can no longer delete a different expense (GAP1-01).
  - Entries saved at the same time keep a fixed order (GAP1-04).
  - Day headers show the year when it is not this year (GAP3-06).
- **Left open overnight, the app moves to the new day** (Pulse, Ledger Today, quick-add dates) when you come back to it, without a reload.
- **Add and Edit sheets:**
  - "Yesterday", "2d ago" and "3d ago" picked the wrong day after a daylight-saving change.
  - The back-dated toast could show the previous day west of UTC.

  Both now count calendar days. (F-096)

- **Typing in the Add sheet while the app refreshed** (for example when going offline) moved focus to Close and lost what you typed. Focus now stays in the field. (F-093)

### Changed

- **Your currency is set from your device.** A new install on a Singapore device starts in SGD. Malaysia gets MYR, Japan JPY, the UK GBP, Australia AUD, euro countries EUR, and everywhere else USD. The choice is saved, so travelling does not change it, and a currency you already picked is kept. Settings now says "Changes the symbol only — amounts aren't converted." (F-070)
- **The budget ring shows more.** Next to the ring: "S$X left · S$Y/day" and the days left. A tick marks an even pace, and screen readers hear all of these numbers. On phones it is a compact strip under the trend. (F-025)
- **The Pulse header on phones** fits on one row at 375 px with a short month label ("Sep 2026"). The period arrows have 44 px touch targets. The Avg/day tile is dropped on phones because the line under the total already shows it.
- **Year view:** the monthly bars show "Total" and "Highest" instead of a second average, and the bars are now visible in the light theme.
- **One way to read a change.** Pulse and Insights use the same pill: down is good, up is bad, and within ±0.5% it reads "≈ same as …".
- **The 14-day forecast is one control.** Tap or drag anywhere over it to read a day, or use the arrow keys. Screen readers get a list of the days with charges. It replaces 14 tiny tap targets. (F-031)
- **Date pills show the year** for a date in another year ("Dec 31, 2025"), in quick add, the Add sheet and its banner.
- **The quick-entry guide** in `docs/USER_GUIDE.md` now describes exactly what quick add understands. The incorrect "Time zones" row is corrected. (F-046)

### Added

- **A check for unusually large amounts.** An amount far above your usual spending turns the amount pill amber, and **Add** becomes **Confirm**. "Far above" means about ten times a typical entry, or 10,000 and up until you have 10 entries. A quick double press cannot confirm it, so a mistyped `450` for `4.50` gets caught. (F-046)
- **An amount limit.** Amounts over 10,000,000 cannot be added from quick add, the palette or the Add and Edit sheets. The message reads "Amount too large — the limit is S$10,000,000.00". (F-046)

### Changed (engineering)

- `src/lib/dates.ts` holds day keys, the one period table and calendar arithmetic that ignores time zones, so DST cannot skip or double a day. `src/lib/ledgerIndex.ts` holds the per-entry day key and integer cents, the sorted order and by-day totals, cached per expenses array. Totals are summed in cents, so Pulse, the Ledger and Insights agree to the cent.
- New `useToday()` hook: one timer for the next midnight, plus `visibilitychange`, `focus` and `pageshow`.
- `src/lib/format.ts` is now the only money formatter, with cached `Intl.NumberFormat` (1,000 calls: ~105 ms → ~1.7 ms). It owns the currency table, which moved from `useUIStore`. A guard test (`moneySurfaces.test.ts`) fails on any hard-coded `$`, `en-US` money formatting or `'USD'` in `src`; it stands in for a lint rule while `eslint.config.js` is frozen. (F-054, F-070)
- `useToast`, `useHaptic` and `useFormatMoney` return stable references, and `useHotkeys` binds its listener once. AppShell no longer subscribes to the undo stack, so it does not re-render on every add. (F-093)
- The quick-add parser is token based, with stated rules. Its fuzzy lookup is cached per mappings object and gives exactly Fuse's top match. Dropping date-fns `parse` shrinks `vendor-utils` by 21 KB. The command palette builds its search index once per data change. (F-100)
- Pulse renders from a deferred copy of the entries, so the quick-add toast paints first.
- New tests:
  - Unit tests: 95 → 655. They include a reference implementation checked at 7 boundary clocks, a 10,000-instant date property test, a 123-phrase Singapore corpus, two 2,000-case seeded parser property tests, and speed guards relative to a baseline measured in the same run, so a busy CI runner cannot trip them.
  - End-to-end tests: 28 → 100 on Chromium and iPhone WebKit, with new `numbers`, `currency` and `quick-add` specs.
- JS bundle 654.3 → 661.7 KB (+7.4 KB, budget 700). No new dependencies, and stored data is unchanged: no new fields, no migration.

## 0.8.4 — 2026-10-19

Track 0 of the overhaul: the quality gates now actually run, and the bugs they exposed are fixed.

### Fixed

- **Sync reconnect storm.** After any network drop, removing the dead realtime channel fired a `CLOSED` event that scheduled another reconnect, which removed the healthy replacement, so the app tore down and resubscribed every 2 s for as long as it stayed open (11 channels in 20 s). Statuses from channels that are no longer current are now ignored. Covered by `syncService.test.ts`, which fails against the old code.
- **Corrupt preferences no longer crash the app.** A malformed stored currency was passed straight to `Intl.NumberFormat` and broke every money render; an invalid stored theme was applied as-is. Both now fall back safely.
- **Corrupt storage keys no longer leak into state.** Category mappings, budgets and their timestamps are shape-checked when loaded (wrongly typed entries are dropped instead of crashing later).
- **Backup import is validated properly.** Every expense is parsed into a clean record (dates must parse, optional fields must have the right type, a missing `createdAt` falls back to the date), with readable error messages.
- **Copying the sync code** shows an error toast if the clipboard is unavailable instead of failing silently.
- **Currency-aware labels.** Chart tooltips, chart screen-reader labels and the command-palette quick add now use the selected currency instead of a hard-coded `$`.

### Changed (engineering)

- `npm run lint` now lints the app: typescript-eslint `strictTypeChecked`, react-hooks and jsx-a11y on every TS/TSX file (it previously linted 6 config files and 0 app files), with zero warnings allowed.
- TypeScript is strict for real: `noImplicitAny` (was off), `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noUncheckedIndexedAccess`. E2E specs and config files are type-checked too.
- Line endings are forced to LF (`.gitattributes eol=lf`), so Windows checkouts no longer fail `format:check`. Prettier now also checks `e2e/` and `scripts/`.
- CI runs on Node 22, runs unit tests in three timezones (Singapore, UTC-10, UTC+14), audits production dependencies, and runs the end-to-end suite on desktop Chromium and iPhone WebKit.
- Unit tests no longer depend on the machine's timezone or the current date. 39 → 95 tests.
- New `npm run verify` runs every local gate in order.

## 0.8.3 — 2026-06-15

### Changed

- **Warmer/softer Entry sheets pass — completes the redesign.** The bottom sheets, command palette, and date-picker popup now use a theme-aware `--shadow-overlay` token (softer, warm-tinted in light) instead of hardcoded heavy black shadows. The date-picker popup, which still hardcoded the old cool blue-black (`#0f1117`), now uses the warm surface token. With this, all four surfaces (Pulse, Ledger, Insights, Entry/Settings) carry the warmer/softer design.

## 0.8.2 — 2026-06-14

### Changed

- **Warmer/softer Insights pass.** Gave the "Spending trend" card the accent leading icon the other Insights cards already had; cards inherit the warm/soft foundation.

### Fixed

- **Insights week chart invisible in light mode** — the Week-vs-last-week bars hardcoded `bg-white/15`/`bg-white/30` and disappeared on the white card. Added theme-aware `--chart-bar` tokens (dark-on-light in light mode). Contrast verified 0 failures in both themes.

## 0.8.1 — 2026-06-14

### Changed

- **Warmer/softer Ledger pass.** The ledger list shell now floats with the soft card elevation (new reusable `.elevated` utility, warm-tinted in light mode); the day-header band is unified and warmed across the grouped and windowed views (`bg-surface-2/85`); added a gentle warm row-hover micro-interaction on desktop.
- **Completed the radius rounding** from v0.8.0 — the `--radius-lg` bump only affected the `.card` class, so the shared `Card` component and 6 other spots hardcoding `rounded-[14px]` were aligned to `rounded-2xl` (16px). The rounder look is now consistent app-wide.

## 0.8.0 — 2026-06-14

### Changed

- **Warmer/softer visual foundation** (first pass of the redesign — see `docs/design-brief.md`). Dark surfaces moved from cool OLED blue-black to warm-neutral charcoal; light surfaces from clinical cool white to warm off-white/cream; corner radii rounded (6/10/14/18 → 8/12/16/20); primary text warmed and secondary/tertiary/muted shifted to warm grays; cards given soft resting + softened hover shadows (warm-tinted in light mode). Keeps the dense Notion/Linear layout and single cyan accent; dark stays primary.
- **Unified Pulse card headers** via a new shared `SectionHeader` (leading accent icon + eyebrow + right meta), replacing four hand-rolled headers; fixed a tracking inconsistency.

### Fixed

- Dark-mode over-budget red text brightened to red-400 to clear WCAG AA on the lighter warm cards. Contrast verified 0 failures in both themes.

## 0.7.1 — 2026-06-14

### Changed

- **Settings controls redesign** — the Theme selector is now a full-width Segmented control (System / Dark / Light with icons) instead of a cramped native dropdown; the Currency selector is a polished full-width styled select with a custom chevron and theme-aware colors. Bigger touch targets, consistent with the app's pill/segmented styling.

### Fixed

- **Light-mode button contrast** — `.text-surface-0` (text on solid accent/colored fills: Add buttons, FAB, selected category pills) flipped to near-white in light mode and failed contrast (1.7:1) on the bright cyan fill. Pinned dark in light mode. Verified 0 contrast failures.

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
