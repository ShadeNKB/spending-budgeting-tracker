<p align="center">
  <img src="public/favicon.svg" alt="SpendTrack logo" width="72" height="72" />
</p>

<h1 align="center">SpendTrack</h1>

<p align="center">
  A fast, local-first spending tracker for logging expenses, spotting patterns, and staying close to your budget.
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/ShadeNKB/spending-budgeting-tracker/ci.yml?branch=main&label=ci" alt="CI status" />
  <img src="https://img.shields.io/badge/license-MIT-22D3EE" alt="MIT license" />
  <img src="https://img.shields.io/badge/local--first-yes-22C55E" alt="Local-first app" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  |
  <a href="#features">Features</a>
  |
  <a href="#how-it-works">How It Works</a>
</p>

## Preview

![SpendTrack dashboard preview](docs/preview.svg)

## Why SpendTrack

Most personal finance tools are either too heavy or too slow for daily use. SpendTrack is built for the opposite: quick entry, clean feedback, and private data that stays in your browser.

It works well as a personal daily tracker, a portfolio project reference, or a starting point for a local-first finance app.

## Features

- **Fast expense entry** - type natural entries like `coffee 4.50 yesterday` and let the app parse the details.
- **Pulse dashboard** - see month/year spend, pace, category mix, heatmap activity, and recent entries.
- **Ledger view** - filter by range, category, or search text; edit and delete transactions quickly.
- **Budget tracking** - set category budgets and compare planned vs actual spending.
- **Insights** - review trends, recurring patterns, forecasts, and spending signals.
- **Private by default** - no backend, no account, no API keys; data lives in localStorage.
- **Portable data** - export/import JSON backups and export CSV for spreadsheets.

## Screenshots

| Pulse | Ledger | Insights |
| --- | --- | --- |
| Dashboard, pace, categories, heatmap | Searchable transaction history | Trends, forecasts, recurring patterns |

## Quick Start

Requirements:

- Node.js 20 or newer
- npm

```bash
git clone https://github.com/ShadeNKB/spending-budgeting-tracker.git
cd spending-budgeting-tracker
npm install
npm run dev
```

Open `http://localhost:5173`.

No environment variables are required.

## Scripts

```bash
npm run dev        # Start local development
npm run build      # Create a production build
npm run preview    # Preview the production build
npm run lint       # Run ESLint
npm run typecheck  # Check TypeScript
npm run test:run   # Run tests once
```

## How It Works

SpendTrack stores expenses, categories, budgets, and learned category mappings in the browser. The app hydrates from localStorage on load, writes changes automatically, and lets you export a full JSON backup when needed.

The interface is split into three main screens:

- `Pulse` for dashboard-level spending visibility.
- `Ledger` for transaction management.
- `Insights` for patterns, forecasts, and recurring expense detection.

## Tech Stack

| Area | Tools |
| --- | --- |
| App | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, CSS custom properties |
| State | Zustand |
| Routing | React Router |
| Animation | Framer Motion |
| Charts | Chart.js, react-chartjs-2 |
| Search | Fuse.js |
| Dates | date-fns |
| Testing | Vitest, Testing Library |

## Project Structure

```text
src/
  app/          Shell, routes, navigation, sync status
  features/     Entry, pulse, ledger, insights, settings
  hooks/        Shared React hooks
  lib/          Analytics and formatting helpers
  services/     Browser storage layer
  stores/       Zustand stores
  ui/           Reusable UI components
  utils/        Parsing, insights, recurring expense helpers
```

## Roadmap

- Add focused tests for parsing, analytics, storage, and recurring detection.
- Code-split chart-heavy routes.
- Add deployed demo link and real product screenshots.
- Expand CI with browser smoke tests.

## Privacy

SpendTrack does not send spending data anywhere. Everything stays in the browser unless you export a backup manually.

## License

MIT
