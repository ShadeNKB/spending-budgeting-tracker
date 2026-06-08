# Contributing

Thanks for taking a look at SpendTrack. The project is intentionally small, local-first, and focused on daily spending clarity.

## Principles

- Keep the app fast and simple.
- Preserve local-first privacy.
- Improve real user workflows before adding new surface area.
- Prefer clear TypeScript and small components.
- Avoid broad refactors unless they remove real complexity.

## Local Setup

```bash
npm ci
npm run dev
```

Optional cloud sync needs a local `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, plus the SQL in `supabase/migrations/001_sync.sql` applied to your own Supabase project. Leave those variables unset when you only need local-first behavior.

Before opening a pull request, run:

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
npm run smoke
```

## Pull Requests

Good pull requests usually include:

- a clear problem statement
- screenshots or screen recordings for UI changes
- notes on data/storage impact
- test coverage when behavior changes

## Data Safety

Do not commit real spending exports, `.env` files, browser profiles, screenshots with sensitive data, or generated local backups.

The repo ignores `spendtrack-backup-*.json` by default.
