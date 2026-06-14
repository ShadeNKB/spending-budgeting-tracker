# SpendTrack Design Brief — Warmer/Softer Redesign

_Set 2026-06-14 from Shade's discovery answers. Anchors every surface pass._

## North star
Shift the app from its cool, OLED-near-black "terminal" feel toward a **warmer, softer, friendlier**
look — without losing the dense, information-rich Notion/Linear bones. Warm-neutral darks (not cool
blue-grays), softer shadows, slightly rounder corners, calmer contrast. Still a capable power-user
tool, just less cold.

## Taste dials
- **Variance: 5** — a real directional shift, not experimental.
- **Motion: 4** — purposeful micro-interactions (number count-ups, gentle hovers, smooth state
  changes). Always respect `prefers-reduced-motion`.
- **Density: 6** — keep balanced; refine spacing/rhythm, don't add or remove information.

## Decisions
- **Aesthetic:** warmer / softer (warm-neutral surface ramp, softer/warmer shadows, rounder radii).
- **Color:** keep the single cyan accent (no second accent; no purple→blue gradients).
- **Density:** balanced — current information density preserved.
- **Motion:** purposeful micro only.
- **Scope (priority order):** Pulse → Ledger → Insights → Entry + Settings. One surface per release.

## Guardrails
- Dark mode primary; light mode follower but must stay WCAG AA-clean (currently 0 failures).
- Token-first — extend CSS custom properties; no per-component one-offs.
- Bundle budget JS 700 KB (currently ~651). Mono + tabular-nums for all numbers. Timezone-safe dates.
- One surface per release; before/after screenshots + approval before merging anything subjective.
