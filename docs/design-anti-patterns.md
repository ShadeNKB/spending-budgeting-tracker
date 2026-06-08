# Design Anti-Patterns

Distilled from impeccable, taste-skill, and huashu-design. These are the concrete rules — grep for violations before any UI PR.

## Typography

- ❌ Inter, Arial, Helvetica, system-ui as primary display font (overused / generic)
- ❌ Single font weight throughout — pair at least 2 weights (e.g. 400 + 600)
- ❌ Body text below 14px on desktop, 16px on mobile
- ❌ Line-height < 1.4 for body copy
- ✅ Use one display font + one body font max — coherent rhythm

## Color

- ❌ Pure `#000` or pure `#fff` — always tint (e.g. `#0a0a0b`, `#fafafa`)
- ❌ Pure gray neutrals (`gray-500`) — use tinted neutrals (slate, zinc, stone)
- ❌ Purple→blue gradients (the AI default)
- ❌ Gray text on colored backgrounds — contrast fails
- ❌ More than 1 accent color per surface
- ✅ WCAG AA contrast minimum (4.5:1 body, 3:1 large)

## Spacing & Layout

- ❌ More than 2 levels of nested cards
- ❌ Equal padding everywhere — establish a rhythm (4 / 8 / 16 / 24 / 48)
- ❌ Centered hero + centered everything — try asymmetric compositions
- ❌ Buttons that span full width on desktop unless explicitly mobile
- ✅ Whitespace discipline — generous around primary actions

## Motion

- ❌ Bounce / elastic easing (feels dated)
- ❌ Animations > 400ms for UI feedback
- ❌ Animating on every state change — reserve motion for meaning
- ✅ Default ease: `cubic-bezier(0.4, 0, 0.2, 1)` (Material standard) or `ease-out` for entrances

## Interaction

- ❌ Hover-only affordances (breaks on touch)
- ❌ Click targets < 44×44px on mobile
- ❌ Forms without inline validation
- ❌ Destructive actions without confirmation
- ✅ Focus rings visible — never `outline: none` without replacement

## Information Hierarchy

- ❌ Three+ competing primary CTAs in the same viewport
- ❌ Tables with > 7 columns on mobile (use cards instead)
- ❌ All-caps body text
- ✅ One primary action per screen, secondary actions visually subordinate

## SpendTrack-Specific

- ❌ Dates rendered without timezone-safe parsing (always `T12:00:00`)
- ❌ Currency formatting inconsistent across screens — use one util
- ❌ Long expense lists without virtualization beyond ~200 rows
- ✅ Dark mode is the default — light mode is a follower

## Taste Dials (when prompted to design)

Reference these when starting fresh UI work:
- **Variance** (1=conservative, 10=experimental) — default 5
- **Motion** (1=static, 10=cinematic) — default 4
- **Density** (1=spacious, 10=dashboard-dense) — default 6 for tracker views

## Workflow gates

Before merging UI changes, run:
1. Grep this file's bullets — fix violations
2. Mobile + desktop screenshot
3. Keyboard-only navigation pass
