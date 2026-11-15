# SpendTrack — Tech Stack

Versions are the ranges in `package.json`; `npm ls <package>` prints what is installed.

## Runtime
- React 19 + TypeScript 6 (strict) + Vite 7; Node 20+ (`engines`), CI runs Node 22
- React Router 7 — declarative routes in `src/app/routes.tsx`: Pulse (`/` and `/pulse`), `/ledger`, `/insights`; anything else redirects to `/pulse`. Ledger and Insights are lazy
- Zustand 5 — three stores (below); the data itself lives in the data engine, not in a store
- Tailwind 3 with CSS custom properties for the Light / Dark / System themes, lucide-react icons, date-fns 4, fuse.js 7 (`fuse.js/basic`), @tanstack/react-virtual 3 (Ledger past 150 rows)
- Motion: no animation library. Overlays move with CSS transitions keyed on `data-state` (`src/ui/usePresence.ts`, tokens in `index.css`); the ledger swipe and the toast slide use the Web Animations API (`src/ui/spring.ts`, `motion.ts`)
- Supabase JS 2 — optional sync relay, lazy-loaded with the sync engine; a build without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` drops the engine entirely
- Private sync: WebCrypto (AES-GCM-256, HKDF-SHA256) and Compression Streams, both built into the browser; no crypto dependency
- PWA: vite-plugin-pwa 1 (Workbox). Prompt-style updates: a new worker waits until the in-app banner is accepted (`src/app/swUpdate.ts`)
- Security headers: `vercel.json` is the source; `vite preview` serves the same set, so smoke and e2e run under the production CSP

## Build flags (all optional, read at build time)
| Variable | Effect |
|----------|--------|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Turn sync on (`src/services/syncConfig.ts`) |
| `VITE_SYNC_RELAY` = `auto` / `rpc` | Use the relay's sync functions (migration 004) instead of the table |
| `VITE_SYNC_CAS` = `on` | Write by compare-and-set on `updated_at` |
| `VITE_DEMO_MODE` = `true` | Seed sample data on a pristine demo origin, once |

With the relay functions or CAS on, a new sync is private (encrypted on the device, `ST5-` code). See `docs/brain/sync-runbook.md` and `supabase/README.md` before changing any of these on a deployment.

## Where things live
```
src/
├── main.tsx          Starts loading the data engine chunk, registers the service worker, mounts
├── App.tsx           The router over `app/routes.tsx`
├── app/              Shell: AppShell, TopBar, TabBar, SyncPill, routes, banners and cards
│                     (offline, update, backup nudge, first run, data notices), error boundaries,
│                     service-worker update, route focus and screen titles
├── data/             The data engine (see below)
├── features/         One folder per surface
│   ├── entry/        SmartInput (quick bar), AddExpenseSheet, CommandPalette, expenseForm
│   ├── pulse/        PulseScreen, PaceRing, TodayStrip, TopCategories, BudgetActual, Heatmap,
│   │                 MonthlyBars, Sparkline, MonthReview, MonthClosed
│   ├── ledger/       LedgerScreen, LedgerRow (swipe), VirtualLedgerList, EditExpenseSheet,
│   │                 URL filter params
│   ├── insights/     InsightsScreen, ForecastChart, DueSoon
│   └── settings/     SettingsDrawer; Backup, Import preview, Clear data; Recovery centre;
│                     Sync panel, code, join and devices
├── stores/           Zustand stores and the sync engine
├── services/         storage.ts (the one safe writer), syncService.ts (transport), syncConfig.ts
├── ui/               Primitives (Button, Card, Sheet, Select, DatePicker, Segmented, Ring, Pill,
│                     ToastHost, InlineConfirm…) and the motion, modal-layer and announce helpers
├── hooks/            useHotkeys, useToast, useHaptic, useToday, useIdle, useChartScrub…
├── lib/              analytics, spending totals, format, dates (screen side), csv, backup guards,
│                     rescue (raw export without the engine), kind, ledgerIndex, chunkReload
├── utils/            parseExpense (natural language), recurring, insights, amountGuard
├── demo/             Sample data for demo builds
├── types.ts          Expense / ExpenseView and the screen-side types
├── constants.ts      Default categories and a few UI constants
└── __tests__/        Shared test harnesses (below)
```

### The data engine (`src/data`)
- **`core/`** — pure, no I/O: the document (`doc.ts`), per-field registers (`record.ts`), stamps and the hybrid logical clock (`stamp.ts`), every user mutation as an op (`ops.ts`), the one codec for relay payloads, local envelopes and backup files (`wire.ts`), the sanitiser (`sanitize.ts`), push decisions (`push.ts`), the date contract (`dates.ts`), categories and renames, ids, hashing, salvage of damaged arrays, sync codes (`codes.ts`) and the private-sync codec (`e2e.ts`).
- **`local/`** — the local engine, a lazy chunk preloaded at boot (`engine.ts`): the `st5:db` envelope written through on a microtask (`envelope.ts`), the v4 keys read and mirrored for rollback (`migrate.ts`), every storage key it owns (`keys.ts`), storage access (`io.ts`), quarantine, the recovery ladder, snapshots, the journal, the outbox, lifecycle flush and cross-tab merge, the views the screens read (`views.ts`), smart category and fuzzy matching, "not spending" and the month budget (`spending.ts`), backup files (`files.ts`). The Recovery centre's data side (`recoveryCentre.ts`) is its own lazy chunk.
- **`sync/`** — the device registry (`registry.ts`), shipped in the sync engine's chunk.

### Sync
- **Engine:** `src/stores/syncEngine.ts` — a lazy chunk: single-flight cycle, pull → decode → synchronous merge on a fresh local read → push only news, plain and private buckets, compare-and-set, backoff, realtime, fences.
- **Transport:** `src/services/syncService.ts` — the relay row and realtime only (table or `st_sync_*` functions, etag, keepalive); it never reads a payload.
- **Relay schema:** `supabase/migrations/` (001–006, with rollbacks for 004–006) and `supabase/checks/`; applied by hand, never with `supabase db push` (`supabase/README.md`).

### Stores (`src/stores`)
- `useExpenseStore` — a thin facade over the local engine: the views the screens read (`expenses`, `categories`, budgets, mappings, not-spending categories, month budget), save status, the undo stack, and actions that delegate to the engine. `hydrated` is false until the engine chunk loads.
- `useSyncStore` — sync state for the pill and the panel; loads the sync engine on first use.
- `useUIStore` — overlays (palette, settings, add sheet, hotkeys), toasts, currency and theme (persisted).

### Tests and their harnesses
- **Unit and component (Vitest, jsdom):** beside the code (`*.test.ts(x)`), plus `src/stores/__tests__` (the sync engine against the fake relay), `src/data/local/__tests__` (engine harness, fake storage) and `src/data/__tests__` (`sim/` deterministic multi-device simulator, `props/` property laws, `probes/`, `legacy/` frozen 0.8.4 and 0.8.5 clients, `bench/`). `ST5_SIM_SEEDS` sets the simulator's seed count.
- **`src/__tests__/fakeRelay.ts`** — fake Supabase client (table, `st_sync_*` RPCs, realtime), held to its contract by `fakeRelay.contract.test.ts`; `legacyPeer.ts` and `legacyPeer092.ts` are old devices on it.
- **`src/__tests__/pgRelay.ts` + `pgRest.ts`** — the relay on real Postgres (PGlite, dev only) with Supabase's roles emulated, and a PostgREST-shaped `fetch` over it; `src/__tests__/sql/` runs the migrations, checks and transport against it.
- **`src/__tests__/realWork.ts`** — tracks real WebCrypto and gzip work, so tests on fake timers do not move the clock while it is in flight.
- **E2E (Playwright, `e2e/`):** Chromium desktop and iPhone 14 WebKit against `vite preview`; `a11y.spec.ts` (axe) and `keyboard.spec.ts` are the accessibility gate.
- **Data-engine gate (`e2e/data-engine/`, `*.data.ts`):** this build, with and without the sync flags, beside archived older releases (`scripts/build-mixed.mjs`) on a fake relay in one Node process (`support/relayServer.ts`).

### Scripts
| Command | What it proves |
|---------|----------------|
| `npm run verify` | Everything below from `check:backups` to `smoke`, in order |
| `npm run check:backups` | No file shaped like a SpendTrack backup is tracked (`--staged` in the pre-commit hook, `npm run hooks:install`) |
| `npm run typecheck` | `tsc` on the app and the Node configs |
| `npm run lint` | ESLint, zero warnings |
| `npm run format:check` | Prettier on `src`, `e2e`, `scripts` and root files |
| `npm run test:run` | The Vitest suite |
| `npm run build` | Production build (no relay settings, so no sync code) |
| `npm run size` | `dist/assets` within the JS, CSS and total budgets (`scripts/check-bundle-size.mjs`) |
| `npm run size:relay` | Rebuilds as deployed and holds the startup (eager and boot) budgets; sync code stays lazy (`scripts/check-relay-weight.mjs`) |
| `npm run smoke` | `vite preview` serves every route, `sw.js` and the manifest |
| `npm run e2e` / `npm run a11y` | Playwright suite / its accessibility specs |
| `npm run e2e:data` | Builds the mixed versions, then runs the data-engine gate (local, not in CI) |
| `npm run check:playwright-image` | CI's Playwright image tag matches the installed `@playwright/test` |
| `node scripts/mutate-core.mjs [--sync]` | Mutation suites: known-bad changes to the core or the sync engine must turn tests red |
| `node scripts/verify-cas.mjs` | The owner's compare-and-set check against his own relay (see the runbook) |

Each budget script prints its numbers and what is left; read them there rather than copying them here.

## Data model
The stored truth is the v5 document (`src/data/core/types.ts`, `Doc`): live expenses as records of six per-field last-writer-wins registers (name, amount, category, date + day, notes, extras), tombstones for deletions, categories, renames, learned item → category mappings, budgets, synced preferences and the device registry. It is stored as one `st5:db` envelope in `localStorage`, with the 0.9.x keys kept as a rollback mirror.

What screens read is `ExpenseView` (`src/types.ts`):
```typescript
interface Expense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string        // stored text; readers bucket on `day`, never on this
  day?: string        // 'yyyy-MM-dd', the owner's calendar day
  notes?: string
  createdAt: string
  updatedAt?: string
  ext?: Readonly<Record<string, Json>>  // `kind` (income / refund) and pass-through fields
}
interface ExpenseView extends Expense { readonly day: string; readonly ext: ... }
```
The date contract is in `src/data/core/dates.ts`; the rules that must not break are in `docs/brain/OPERATING-MANUAL.md`.

## CI / Deployment
- GitHub Actions (`.github/workflows/ci.yml`): **Validate** (backup guard, Playwright image guard, typecheck, lint, format, unit tests in Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati, build, size, size:relay, smoke, `npm audit --omit=dev --audit-level=high`); **Data engine simulation** (`src/data` at 150 seeds); **E2E** in three shards in Playwright's container image, summed into one check
- Vercel: auto-deploy on push to `main`

## Standards
- TypeScript strict — zero `any`
- No dead code, no commented-out blocks
- PascalCase components, camelCase utils/hooks/stores
- Single responsibility per component
