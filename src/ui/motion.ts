/**
 * What the app's motion code asks the browser: whether to move at all, whether the Web
 * Animations API is there, which animations an element is running, and the motion tokens of
 * index.css. No React here.
 *
 * Reduce Motion is read on every call, never cached: the setting can change while the app is
 * open (index.css holds the overlays still at once through its media query; script-driven
 * motion asks again at each decision). Nothing subscribes, so a page with no matchMedia (jsdom,
 * a stub without addEventListener) simply moves.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches
}

/** The Web Animations API with `getAnimations()` (jsdom has neither). */
export function canAnimate(): boolean {
  return (
    typeof Element.prototype.animate === 'function' &&
    typeof Element.prototype.getAnimations === 'function'
  )
}

/**
 * Reads a computed value (and returns it), so a CSS transition started next runs from the
 * style the element has now.
 */
export function flushStyle(element: Element): string {
  return getComputedStyle(element).opacity
}

/**
 * The finite animations each element runs itself (CSS transitions, Web Animations), never those
 * of what it contains: an exit waits for its parts, not for a spinner or a countdown inside.
 */
export function finiteAnimations(parts: Iterable<Element | null | undefined>): Animation[] {
  if (!canAnimate()) return []
  const found: Animation[] = []
  for (const part of parts) {
    if (!part) continue
    for (const animation of part.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) found.push(animation)
    }
  }
  return found
}

const ms = (time: CSSNumberish | null | undefined): number => (typeof time === 'number' ? time : 0)

/** What the exit timing reads of an animation. */
interface Timed {
  readonly currentTime: CSSNumberish | null
  readonly effect: { getComputedTiming: () => { readonly endTime?: CSSNumberish } } | null
}

/** How long the longest of `animations` still has to run, in ms (0 for none). */
export function longestRemainingMs(animations: readonly Timed[]): number {
  let longest = 0
  for (const animation of animations) {
    const end = ms(animation.effect?.getComputedTiming().endTime)
    longest = Math.max(longest, end - ms(animation.currentTime))
  }
  return longest
}

/** A custom property of the root element (a motion token of index.css), trimmed. */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** A duration token ('350ms', '0.4s') in ms, or `fallback` when it is missing or unreadable. */
export function cssMs(name: string, fallback: number): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(cssToken(name))
  if (!match) return fallback
  const value = Number(match[1])
  return match[2] === 's' ? value * 1000 : value
}
