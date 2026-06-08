# Dogfood — Exploratory Web QA

*Adapted from Hermes Agent's `dogfood` skill (MIT, NousResearch/hermes-agent).*

Use when you want a systematic exploratory pass over SpendTrack — finding bugs, console errors, broken interactions, and a11y issues — before a release or after a big change.

Runs against the live preview or production URL via the **Playwright MCP** (already wired in this workspace). No new tools needed.

---

## Inputs

1. **Target URL** — `http://localhost:4173` (after `npm run preview`) or `https://spendtrack-demo.vercel.app`
2. **Scope** — `full`, or a specific area: `add-flow` / `pulse` / `ledger` / `insights` / `settings`
3. **Output dir** — defaults to `docs/brain/dogfood-runs/YYYY-MM-DD/`

## 5-phase workflow

### Phase 1 — Plan
- Create `docs/brain/dogfood-runs/YYYY-MM-DD/{screenshots/,report.md}`
- Map the surface to test:
  - Routes: `/` `/ledger` `/insights`
  - Modals: AddExpenseSheet, CommandPalette, SettingsDrawer
  - Forms: SmartInput, expense edit, budget edit, category rename
  - Edge cases: empty state, 0 expenses, future date, very large amount, very long note

### Phase 2 — Explore
For each surface:
1. `browser_navigate` to the URL
2. `browser_snapshot` — get the DOM structure
3. `browser_console_messages` — capture JS errors (do this after every nav + every significant interaction; silent JS errors are high-value)
4. `browser_take_screenshot` — visual reference
5. Interact: click buttons, fill forms, keyboard nav (`Tab`, `Enter`, `Escape`), scroll
6. Test validation: empty submit, invalid amount (`abc`, `-5`, `Infinity`), giant note (10k chars)

### Phase 3 — Collect evidence
For every issue:
- Screenshot at `screenshots/NN-<slug>.png`
- Note: URL, repro steps, expected vs actual, severity (P0/P1/P2/P3), console errors if any

### Phase 4 — Test mobile viewport
- `browser_resize` to 375×667
- Re-run the most important flows (add expense, switch tabs, open settings)
- Check tap targets ≥ 44px, no horizontal scroll, no hover-only affordances

### Phase 5 — Report
Write `report.md`:

```markdown
# Dogfood Report — YYYY-MM-DD

**Target:** <URL>  ·  **Scope:** <area>  ·  **Build:** <git sha>

## Summary
- X issues found (P0: _, P1: _, P2: _, P3: _)
- Console: <clean / N errors>
- Mobile: <clean / N issues>

## Issues
### P0-1 — <one-line headline>
- **URL:** ...
- **Repro:** 1. ... 2. ... 3. ...
- **Expected:** ...
- **Actual:** ...
- **Evidence:** ![](screenshots/01-name.png)
- **Console:** `TypeError: ...` (if any)

(repeat per issue)

## Clean areas
- Pulse heatmap, Insights forecast, ...
```

## Severity guide
- **P0** — data loss, crash, security
- **P1** — feature broken, blocks normal use
- **P2** — UX issue, ugly, confusing
- **P3** — polish, nit

## Promote findings
- P0/P1 → file as a task and reference the report in the PR
- Recurring class of issue → one bullet in `docs/brain/bugs-fixed.md`
- Permanent gate to add → one item in `docs/brain/qa-checklist.md`

## Anti-patterns
- Reporting "site looks good" with no evidence — always screenshot + console check
- Reporting issues without repro steps
- Mixing severity (P3 nits next to P0 crashes — separate them)
