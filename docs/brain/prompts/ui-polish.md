# UI Polish Prompt

Paste when tightening a specific UI surface.

---

You are doing a focused UI polish pass on **[component/screen]** in SpendTrack.

**Procedure:**
1. **Read** `docs/design-anti-patterns.md` to load the rules.
2. **Open** the target component(s) and read end-to-end.
3. **Grep for violations** of each anti-pattern category (typography, color, spacing, motion, interaction, hierarchy, SpendTrack-specific).
4. **Mobile-first check:** open DevTools at 375×667 and verify the surface. Tap targets ≥ 44px. Text legible at body size (16px min on mobile).
5. **Keyboard pass:** Tab through every interactive element. Focus rings visible. No keyboard traps.
6. **Fix surgically.** One concern per change. Don't restyle adjacent surfaces.
7. **Verify:** screenshot before + after (mobile + desktop). Run `npm run typecheck && npm run lint && npm run build`.
8. **Run** the `design-taste` agent on the diff for an independent pass.

**Constraints:**
- Dark mode is the default — don't add light-mode-only styling.
- Use existing Tailwind tokens and the `surface-*` / `text-*` scale. Don't introduce one-off hex.
- Motion: max 400ms, no bounce/elastic. Default `cubic-bezier(0.4, 0, 0.2, 1)`.
- One primary CTA per viewport.
- No `outline: none` without a replacement focus indicator.

**Output expectation:**
- Before/after screenshots in the PR.
- One-line rationale per change in the commit message.
- Anti-pattern doc reference if you bent a rule deliberately.
