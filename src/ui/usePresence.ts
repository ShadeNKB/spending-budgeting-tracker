import { useLayoutEffect, useRef, useState } from 'react'
import {
  canAnimate,
  finiteAnimations,
  flushStyle,
  longestRemainingMs,
  prefersReducedMotion,
} from './motion'

/**
 * Presence for an element that animates in and out with CSS: it stays mounted while it plays
 * its exit, which framer-motion's AnimatePresence did for the overlays.
 *
 * The caller renders `state` as `data-state` on the element that owns the animated parts, and
 * index.css gives each state its look and transition:
 *
 * - `starting` (first commit of an open that may animate): the closed look. A layout effect
 *   reads the parts' style, then turns `open`, so the transition runs from the closed look,
 *   before anything is painted.
 * - `open`.
 * - `closed`: the exit look. The element stays until the finite animations its declared parts
 *   run themselves have ended (never what they contain: a spinner, a countdown bar, a button's
 *   hover), or at the latest the longest of them + 250 ms: WebKit never settles the `finished`
 *   promise of a transition that a reversing one replaced, and a browser may hold an animation.
 *
 * Reopened while leaving, it turns `open` on the same node (CSS reverses from where it is) and
 * the pending exit is dropped. Under reduced motion, or without the Web Animations API, it opens
 * on its first commit and leaves at once. StrictMode-safe: a completion that is stale (an older
 * exit, an unmounted component) does nothing, and unmounting clears the timer.
 */

export type PresenceState = 'starting' | 'open' | 'closed'

export interface Presence {
  readonly mounted: boolean
  readonly state: PresenceState
}

export interface PresenceOptions {
  /** The elements whose own animations make up the exit (read when it starts). */
  readonly parts: () => readonly (Element | null)[]
  /** False: a first mount that is already open shows open at once (framer's initial={false}). */
  readonly appear?: boolean
  /** Called once each time the exit has ended and the element is gone. */
  readonly onExitComplete?: () => void
}

/** Slack on top of the longest exit before the element goes regardless. */
const EXIT_CAP_SLACK_MS = 250

const mayAnimate = () => canAnimate() && !prefersReducedMotion()

export function usePresence(open: boolean, options: PresenceOptions): Presence {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })

  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<PresenceState>(() => {
    if (!open) return 'closed'
    return options.appear !== false && mayAnimate() ? 'starting' : 'open'
  })
  // Derived while rendering (the codebase's openSeen pattern): the element mounts, or turns
  // closed, in the very render that changes `open`.
  const [openSeen, setOpenSeen] = useState(open)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (!open) {
      if (mounted) setState('closed')
    } else if (mounted) {
      setState('open')
    } else {
      setMounted(true)
      setState(mayAnimate() ? 'starting' : 'open')
    }
  }

  useLayoutEffect(() => {
    if (state !== 'starting') return
    for (const part of latest.current.parts()) if (part) flushStyle(part)
    setState('open')
  }, [state])

  const exits = useRef(0)
  useLayoutEffect(() => {
    if (state !== 'closed' || !mounted) return undefined
    const exit = ++exits.current
    // Once: a later call (the cap after the animations, a stale one) does nothing. The cap's
    // timer is cleared by the cleanup below as the element goes.
    const finish = () => {
      if (exits.current !== exit) return
      exits.current += 1
      setMounted(false)
      latest.current.onExitComplete?.()
    }
    if (!mayAnimate()) {
      finish()
      return undefined
    }
    const parts = latest.current.parts()
    for (const part of parts) if (part) flushStyle(part)
    const animations = finiteAnimations(parts)
    if (animations.length === 0) {
      finish()
      return undefined
    }
    const cap = setTimeout(finish, longestRemainingMs(animations) + EXIT_CAP_SLACK_MS)
    void Promise.allSettled(animations.map((a) => a.finished)).then(finish)
    return () => {
      clearTimeout(cap)
      if (exits.current === exit) exits.current += 1
    }
  }, [state, mounted])

  return { mounted, state }
}

/**
 * `value` while open; while closing, the value of the last open render, so a leaving overlay
 * keeps showing what it showed (the Add sheet's typed entry as it slides away after Add, not
 * the cleared form). Freeze content only, never the element that carries `data-state`.
 */
export function useHeldWhileClosing<T>(open: boolean, value: T): T {
  const held = useRef(value)
  useLayoutEffect(() => {
    if (open) held.current = value
  })
  return open ? value : held.current
}

/** An item of a list whose removed items stay, leaving, until their exit ends. */
export interface PresentItem<T> {
  readonly item: T
  /** False once it is gone from the source list: it is playing its exit. */
  readonly present: boolean
  /** False for items already there when the list was first shown: no entrance. */
  readonly appear: boolean
}

/**
 * The next list to show for the source list `next`: items keep their places, those gone from
 * `next` stay where they were as leaving ones (the caller drops each once its exit ends), and
 * new ones are appended (the sources only append and remove).
 */
export function mergeLeaving<T extends { readonly id: string }>(
  previous: readonly PresentItem<T>[],
  next: readonly T[],
  appear = true,
): PresentItem<T>[] {
  const byId = new Map(next.map((item) => [item.id, item]))
  const merged = previous.map((shown): PresentItem<T> => {
    const current = byId.get(shown.item.id)
    return current
      ? { item: current, present: true, appear: shown.appear }
      : { ...shown, present: false }
  })
  const known = new Set(previous.map((shown) => shown.item.id))
  for (const item of next) {
    if (!known.has(item.id)) merged.push({ item, present: true, appear })
  }
  return merged
}
