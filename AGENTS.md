# Repository Notes

SpendTrack is a React, TypeScript, and Vite spending tracker.

## Project Standards

- Preserve local-first privacy.
- Keep expense entry fast and low-friction.
- Keep UI changes responsive across desktop and mobile.
- Prefer small, typed components with clear ownership.
- Avoid broad rewrites unless the current structure blocks a meaningful improvement.
- Do not commit real spending exports, local backups, browser profiles, or environment files.

## Validation

Run these before committing:

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
```

For UI changes, include a browser smoke check and screenshots when practical.
