<p align="center">
  <img src="public/favicon.svg" alt="SpendTrack" width="80" height="80" />
</p>

<h1 align="center">SpendTrack</h1>

<p align="center">
  <strong>Know where your money goes. Without the noise.</strong><br/>
  A fast, local-first expense tracker built for daily use - no account, no sync, no friction.
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/ShadeNKB/spending-budgeting-tracker/ci.yml?branch=main&label=CI&style=flat-square" alt="CI" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Local--First-No%20Backend-22C55E?style=flat-square" alt="Local-first" />
  <img src="https://img.shields.io/badge/License-MIT-22D3EE?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/PWA-Installable-8B5CF6?style=flat-square" alt="PWA" />
</p>

<p align="center">
  <a href="https://spendtrack-demo.vercel.app"><strong>▶ Try the Demo</strong></a> &nbsp;·&nbsp;
  <a href="#-quick-start">Quick Start</a> &nbsp;·&nbsp;
  <a href="#-features">Features</a> &nbsp;·&nbsp;
  <a href="#%EF%B8%8F-how-it-works">How It Works</a> &nbsp;·&nbsp;
  <a href="#-tech-stack">Stack</a>
</p>

> **Demo:** pre-loaded with sample data — your changes stay on your device only, no data is shared.

<br/>

<p align="center">
  <img src="docs/screenshots/pulse.png" alt="SpendTrack dashboard" width="100%" />
</p>

<br/>

---

## Why SpendTrack

Most budgeting apps are built around syncing, subscriptions, and dashboards you open once and forget. SpendTrack is built for one thing: making it effortless to log an expense and understand where your money is going.

- **Local-first** - your data never leaves the browser
- **Friction-free entry** - natural language parsing gets out of your way
- **Meaningful feedback** - pace tracking, category breakdowns, and recurring detection surface insights without effort
- **Simple enough to keep using** - log quickly, review clearly, export anytime

---

## Features

### Pulse Dashboard

At-a-glance spending visibility: current month total, daily pace, category breakdown, activity heatmap, and recent entries.

### Ledger

Full transaction history with fast search, date/category filters, inline editing, and bulk delete.

### Budget Tracking

Set monthly budgets per category. See planned vs actual side-by-side with progress indicators.

### Insights

Trend analysis, spending forecasts, recurring expense detection, and anomaly signals - automatically surfaced from your history.

### Smart Entry

Type natural inputs like `coffee 4.50 yesterday` or `netflix 15 monthly`. The parser infers category, amount, and date.

### Private & Portable

No backend. No account. Data lives in `localStorage`. Export JSON backups or CSV for spreadsheets anytime.

---

## Screenshots

| Pulse | Ledger | Insights |
|:---:|:---:|:---:|
| ![Pulse](docs/screenshots/pulse.png) | ![Ledger](docs/screenshots/ledger.png) | ![Insights](docs/screenshots/insights.png) |
| Dashboard, pace, heatmap | Searchable history | Trends and forecasts |

---

## Daily Use

SpendTrack is designed around a simple loop:

1. Open the app.
2. Type an expense naturally, for example `coffee 4.50 yesterday`.
3. Check Pulse to see how the month is pacing.
4. Use Ledger when you need to clean up, filter, or export records.
5. Review Insights for recurring charges and spending patterns.

Good fit:

- Personal daily spending logs
- Simple budgeting without a bank connection
- Local-first finance tracking
- Portfolio reference for a polished React finance app

Not a fit yet:

- Multi-device sync
- Shared household budgets
- Bank imports
- Investment tracking

For a practical walkthrough, see the [user guide](docs/USER_GUIDE.md).

---

## Quick Start

**Requirements:** Node.js 20+, npm

```bash
git clone https://github.com/ShadeNKB/spending-budgeting-tracker.git
cd spending-budgeting-tracker
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

No environment variables are needed.

---

## Scripts

```bash
npm run dev        # Local dev server
npm run build      # Production build
npm run preview    # Preview production build locally
npm run lint       # ESLint
npm run typecheck  # TypeScript check
npm run test:run   # Run tests once
```

---

## How It Works

SpendTrack is entirely browser-side. On load, it hydrates from `localStorage`. Every action - adding an expense, updating a budget, changing a category - writes back immediately. No server, no latency, no auth.

Three screens cover the full workflow:

| Screen | Purpose |
|--------|---------|
| **Pulse** | Spending overview: totals, pace, category mix, heatmap |
| **Ledger** | Transaction management: search, filter, edit, delete |
| **Insights** | Pattern analysis: trends, forecasts, recurring detection |

---

## Data & Privacy

SpendTrack stores data in your browser's `localStorage`.

- No account is required.
- No spending data is sent to a backend.
- Clearing browser storage can delete your data.
- Use JSON export before switching devices, clearing storage, or testing major changes.
- CSV export is available when you want to analyse spending in a spreadsheet.

See [SECURITY.md](SECURITY.md) for reporting security issues.

---

## Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript, Vite |
| Styling | Tailwind CSS, CSS custom properties |
| State | Zustand |
| Routing | React Router |
| Animation | Framer Motion |
| Charts | Chart.js, react-chartjs-2 |
| Search | Fuse.js |
| Dates | date-fns |
| Testing | Vitest, Testing Library |

---

## Project Structure

```text
src/
  app/          Shell, routing, navigation, sync status
  features/     Entry, pulse, ledger, insights, settings
  hooks/        Shared React hooks
  lib/          Analytics and formatting helpers
  services/     localStorage layer
  stores/       Zustand stores
  ui/           Reusable UI components
  utils/        Parsing, insights, recurring expense helpers
```

---

## Roadmap

- [x] Real product screenshots in `docs/screenshots/`
- [x] CI for install, typecheck, lint, tests, and build
- [x] [Live demo](https://spendtrack-demo.vercel.app) — pre-loaded, data stays local per visitor
- [ ] Browser smoke tests in CI
- [ ] Code-split chart-heavy routes for smaller initial bundles
- [ ] Expand test coverage for parsing, analytics, storage, and recurring detection

---

## Contributing

Issues and pull requests are welcome. Start with:

- [User guide](docs/USER_GUIDE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

Please avoid sharing real spending data in public issues, screenshots, or exports.

---

## License

[MIT](LICENSE) - built by [ShadeNKB](https://github.com/ShadeNKB)
