# Backlog

Deferred work and known issues. Not a roadmap — a holding pen so good ideas don't get lost. Pull from the top.

## Active / in flight
_Nothing in flight. Pull from High Value below when ready._

## High value, ready to start
_(all shipped 2026-06-13)_

## Quality of life
_(shipped 2026-06-13)_

## Nice to have
- **Light mode.** Dark is default and follower at best — but a follower exists by design (see anti-patterns doc). Skipping unless requested.
- **Storybook.** Component count too low to justify; revisit at ~40+ components.

## Investigations (don't act, just look first)
- Bundle js 625 KB (under 700 KB budget). `perf-reviewer` ran 2026-06-13 — verdict FAST. No urgent action.
- Google Fonts: changed to `display=optional` 2026-06-13 — avoids FOIT on slow connections.

## Done — moved out
When an item ships, delete it from here and rely on `CHANGELOG.md`. This file should never grow past one screen.
