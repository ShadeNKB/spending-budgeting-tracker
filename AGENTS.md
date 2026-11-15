# Repository Notes

SpendTrack is a React, TypeScript, and Vite spending tracker.

## Project Standards

- Preserve local-first privacy.
- Keep expense entry fast and low-friction.
- Keep UI changes responsive across desktop and mobile.
- Prefer small, typed components with clear ownership.
- Avoid broad rewrites unless the current structure blocks a meaningful improvement.
- Do not commit real spending exports, local backups, browser profiles, or environment files.

## Orientation

- `docs/brain/OPERATING-MANUAL.md` — what must not break, and how to test and deploy.
- `conductor/tech-stack.md` — where things live, the data model and what each script proves.
- `docs/brain/overhaul/LEDGER.md` — what is planned, in progress and done.

## Validation

Run this before committing (backup guard, typecheck, lint, format check, unit tests, build,
bundle and startup budgets, preview smoke):

```bash
npm run verify
```

For UI changes, also run `npm run a11y` and include screenshots when practical. For changes to
the data engine or sync, also run `npm run e2e:data`. Unit tests are also run in CI under the
Pacific/Honolulu and Pacific/Kiritimati time zones.
