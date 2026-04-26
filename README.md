# SpendTrack

SpendTrack is a personal spending tracker built with React, TypeScript, Vite, and Tailwind CSS. It is designed for fast daily logging, clear spending visibility, and fully local data ownership.

## Features

- Add, edit, and delete expenses with typed validation.
- Smart entry parsing for quick expense capture.
- Local-first persistence with JSON backup and restore.
- Category management with reusable item-to-category mappings.
- Pulse dashboard with month pace, budget comparison, heatmap, and trend views.
- Ledger view with date, category, and search filters.
- Mobile-first dark interface with command palette, sheets, toasts, and keyboard shortcuts.

## Tech Stack

| Area | Tools |
| --- | --- |
| App | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, CSS custom properties |
| State | Zustand |
| Animation | Framer Motion |
| Charts | Chart.js, react-chartjs-2 |
| Search | Fuse.js |
| Dates | date-fns |
| Icons | Lucide React |
| Testing | Vitest, Testing Library |

## Getting Started

```bash
npm install
npm run dev
```

The app runs locally at `http://localhost:5173` by default. No environment variables are required.

## Scripts

```bash
npm run dev        # Start the Vite dev server
npm run build      # Build for production
npm run preview    # Preview the production build
npm run lint       # Run ESLint
npm run typecheck  # Run TypeScript checks
npm run test:run   # Run tests once
```

## Project Structure

```text
src/
  app/          App shell, routes, navigation, sync status
  features/     Product screens and feature-specific UI
  hooks/        Shared React hooks
  lib/          Analytics and formatting helpers
  services/     Browser storage layer
  stores/       Zustand state stores
  ui/           Reusable interface components
  utils/        Parsing, insights, recurring expense helpers
```

## Data Model

SpendTrack stores data in the browser with no backend dependency:

- `expenses`: transaction records
- `categories`: user-managed category names
- `categoryMappings`: learned item-to-category shortcuts
- `budgets`: monthly category budgets
- `recurringRules`: recurring expense templates

Backups are exported as JSON and can be restored from the settings drawer.

## Privacy

All spending data stays in the browser unless the user exports a backup manually. Exported backup files are ignored by Git to avoid committing personal financial data.

## License

MIT
