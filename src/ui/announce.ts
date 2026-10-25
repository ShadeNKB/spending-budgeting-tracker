import { useLayoutEffect, useRef } from 'react'

/**
 * Screen-reader announcements through persistent live regions.
 *
 * A live region only speaks when text changes inside a node that was already in the
 * accessibility tree, so the region nodes are rendered empty once and text is set on them
 * (a toast inserted together with its message is often not read at all). And content outside an
 * open `aria-modal` dialog is hidden from assistive tech, so an announcement made while a sheet
 * or the palette is open must land inside it: every open layer pushes its own pair of regions
 * (LayerAnnouncer) and the top pair speaks; the app-wide pair (ToastAnnouncer) is at the bottom.
 * A layer that is closing (its dialog is made inert while it animates out) no longer speaks.
 */

export type Politeness = 'polite' | 'assertive'

export interface LiveRegions {
  /** `role="status"` */
  readonly polite: HTMLElement
  /** `role="alert"` */
  readonly assertive: HTMLElement
}

/** Long enough after clearing a region for screen readers to notice the repeat. */
const REPEAT_DELAY_MS = 100

const stack: LiveRegions[] = []
/** A repeated message waiting to be set again, per region. */
const pending = new Map<HTMLElement, { message: string; timer: ReturnType<typeof setTimeout> }>()

/** Makes `regions` the top pair until the returned function is called. */
export function pushLiveRegions(regions: LiveRegions): () => void {
  stack.push(regions)
  return () => {
    const index = stack.lastIndexOf(regions)
    if (index !== -1) stack.splice(index, 1)
  }
}

/** The top pair that is still live: not inside a closing (inert) layer. */
function topRegions(): LiveRegions | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const regions = stack[i]
    if (regions && regions.polite.closest('[inert]') === null) return regions
  }
  return null
}

/** Speak `message` through the top layer's region: errors assertively, the rest politely. */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const top = topRegions()
  if (!top) return
  const region = politeness === 'assertive' ? top.assertive : top.polite
  const waiting = pending.get(region)
  if (waiting !== undefined) {
    clearTimeout(waiting.timer)
    pending.delete(region)
  }
  if (region.textContent !== message) {
    region.textContent = message
    return
  }
  // The same text again (a second identical toast): clear it, then set it once more.
  region.textContent = ''
  pending.set(region, {
    message,
    timer: setTimeout(() => {
      pending.delete(region)
      region.textContent = message
    }, REPEAT_DELAY_MS),
  })
}

/**
 * Takes `message` back where it is still the top region's text (a status that no longer holds:
 * "No matches" once results are in), so the region never contradicts the screen. Anything
 * announced since stays.
 */
export function retract(message: string, politeness: Politeness = 'polite'): void {
  const top = topRegions()
  if (!top) return
  const region = politeness === 'assertive' ? top.assertive : top.polite
  const waiting = pending.get(region)
  if (waiting?.message === message) {
    clearTimeout(waiting.timer)
    pending.delete(region)
  }
  if (region.textContent === message) region.textContent = ''
}

/**
 * Refs for a polite and an assertive region rendered empty by the caller; while `active` they
 * are the top pair. The nodes are never re-created: text is set on them by `announce`.
 */
export function useLiveRegions(active: boolean) {
  const polite = useRef<HTMLDivElement>(null)
  const assertive = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!active || !polite.current || !assertive.current) return
    return pushLiveRegions({ polite: polite.current, assertive: assertive.current })
  }, [active])
  return { polite, assertive }
}
