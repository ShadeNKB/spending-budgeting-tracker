# SpendTrack — Tech Stack

## Runtime
- React 19 + TypeScript 6 (strict) + Vite 7
- React Router v7 — routes for Pulse (`/`), `/ledger`, `/insights`
- Zustand 5 — `useExpenseStore` + `useUIStore` (auto-persist via localStorage, undo stack)
- Tailwind 3, lucide-react icons, date-fns 4, fuse.js 7
- Motion: no animation library (framer-motion removed in 0.9.4). Overlays move with CSS
  transitions keyed on `data-state` (`src/ui/usePresence.ts`, tokens in `index.css`); the ledger
  swipe and the toast slide use the Web Animations API (`src/ui/spring.ts`, `motion.ts`)
- Supabase JS 2 — optional sync (lazy-loaded; app fully works offline without it)
- PWA: vite-plugin-pwa 1, service worker, web manifest

## Structure
```
src/
├── app/          AppShell, routing, global layout
├── components/   Shared UI primitives
├── features/     Feature slices (pulse/, ledger/, insights/, settings/)
├── hooks/        Custom React hooks
├── services/     Data layer (import/export, backup)
├── stores/       Zustand stores
├── types/        Shared TypeScript types
└── utils/        Pure utility functions
```

## Key components
| Component | Purpose |
|-----------|---------|
| SmartInput | Natural-language expense entry |
| CommandPalette | ⌘K / ⌘N global command hub |
| PaceRing | Budget pace visualisation (SVG ring) |
| Heatmap | Monthly spend heatmap calendar |
| LedgerRow | Swipe-delete + tap-to-edit expense row |
| SettingsDrawer | Categories, budgets, backup/restore |
| TabBar | Bottom nav + Plus button (addSheetOpen) |

## Data model
```typescript
interface Expense {
  id: string           // uuid
  amount: number
  category: string
  note: string
  date: string         // ISO 8601, always T12:00:00
  createdAt: string
}
```

## State architecture
- `useExpenseStore`: expenses[], categories[], budgets{}, undo stack — persisted
- `useUIStore`: addSheetOpen, commandPaletteOpen, activeMonth/year offsets — session-only

## CI / Deployment
- GitHub Actions: `Validate` workflow — typecheck + lint + build + smoke tests
- Vercel: auto-deploy on push to `main`
- npm audit: 0 vulnerabilities (serialize-javascript override applied)

## Standards
- TypeScript strict — zero `any`
- No dead code, no commented-out blocks
- PascalCase components, camelCase utils/hooks/stores
- Single responsibility per component
