import { useEffect, useState } from 'react'
import { canAnimate, prefersReducedMotion } from '../../ui/motion'
import { springSamples } from '../../ui/spring'
import {
  CLICK_GUARD_MS,
  REVEAL_X,
  SNAP_HZ,
  SNAP_SPRING,
  actionOpacity,
  constrainX,
  pastThreshold,
  pointerVelocity,
  revealDecision,
  rowVelocity,
  tintOpacity,
  xAt,
  type Sample,
} from './swipe'

/**
 * A ledger row's swipe to reveal its Delete, on pointer events: the content follows the pointer
 * on x once it has moved 3 px (framer's maths, swipe.ts), and on release snaps to -96 (revealed)
 * or back to 0 on framer's spring, carrying the row's own velocity, as Web Animations sampled
 * from that spring (compositor-only: transform and opacity). The red tint behind the row and
 * the swipe Delete's opacity follow x the whole way.
 *
 * Nothing here re-renders the row or reads layout while it moves: it writes three inline styles
 * per pointer event, so 5,000 rows stay smooth. Pointer capture is taken when a drag starts,
 * never on the press (capture retargets the click that follows away from the row button). A
 * press on a row still settling lets it settle; a drag takes it over where it is. Reduce Motion:
 * the row still follows the finger, and the snap is instant.
 */

/** What the swipe reads of a pointer event (React's and the DOM's both have it). */
interface PointerLike {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean
  readonly button: number
  readonly buttons: number
  readonly clientX: number
  readonly clientY: number
  readonly timeStamp: number
  readonly target: EventTarget | null
}

interface Session {
  readonly pointerId: number
  readonly pressX: number
  readonly pressY: number
  readonly pressT: number
  started: boolean
  /** Where the row was when the drag started. */
  originX: number
  /** framer's pan history: the press, then one point per move since the drag started. */
  readonly history: Sample[]
  /** Where the row was put, from before the drag on (its velocity at release). */
  readonly offsets: Sample[]
  /** Where the pointer last moved to: a cancelled drag ends there. */
  lastX: number
}

interface Snap {
  readonly samples: { readonly values: readonly number[]; readonly step: number }
  readonly animations: readonly Animation[]
}

export interface SwipeReveal {
  readonly contentRef: (el: HTMLElement | null) => void
  readonly tintRef: (el: HTMLElement | null) => void
  readonly actionRef: (el: HTMLElement | null) => void
  readonly onPointerDown: (e: PointerLike) => void
  readonly onPointerMove: (e: PointerLike) => void
  readonly onPointerUp: (e: PointerLike) => void
  readonly onPointerCancel: (e: PointerLike) => void
  readonly onLostPointerCapture: (e: PointerLike) => void
  /** From a drag's start until 50 ms after it ends: the click that comes with it is no tap. */
  readonly dragged: () => boolean
  readonly revealed: () => boolean
  /** Snaps a revealed row back. */
  readonly close: () => void
  /** A new press, or a cancelled one, ends the click guard at once. */
  readonly clearGuard: () => void
  readonly dispose: () => void
}

function createSwipe(): SwipeReveal {
  let content: HTMLElement | null = null
  let tint: HTMLElement | null = null
  let action: HTMLElement | null = null
  let session: Session | null = null
  /** Where the row was last put. */
  let x = 0
  let snap: Snap | null = null
  let revealed = false
  let dragged = false
  let guard: ReturnType<typeof setTimeout> | undefined

  /** Puts the row at `at`; at rest (`clear`), the classes alone place it. */
  const put = (at: number, clear = false) => {
    x = at
    if (content) content.style.transform = clear ? '' : `translateX(${String(at)}px)`
    if (tint) tint.style.opacity = clear ? '' : String(tintOpacity(at))
    if (action) action.style.opacity = clear ? '' : String(actionOpacity(at))
  }

  /** The content keeps a layer of its own while it moves (dragged or snapping), then lets it go. */
  const promote = (on: boolean) => {
    content?.style.setProperty('will-change', on ? 'transform' : '')
  }

  /** Where the row is now: mid-snap, where the snap has got it to. */
  const currentX = () => {
    if (!snap) return x
    const t = snap.animations[0]?.currentTime
    return xAt(snap.samples, typeof t === 'number' ? t : 0)
  }

  const stopSnap = () => {
    for (const animation of snap?.animations ?? []) animation.cancel()
    snap = null
  }

  const snapTo = (target: number, velocity: number) => {
    const from = currentX()
    stopSnap()
    // Where it ends, inline first: once the animation is over, there it is, seamlessly.
    put(target, target === 0)
    const el = content
    const samples =
      el && !prefersReducedMotion() && canAnimate()
        ? springSamples({ ...SNAP_SPRING, from, to: target, velocity }, SNAP_HZ)
        : null
    if (!el || !samples || samples.values.length < 2) {
      promote(false)
      return
    }
    const timing: KeyframeAnimationOptions = { duration: samples.duration, easing: 'linear' }
    const animations = [
      el.animate(
        samples.values.map((v) => ({ transform: `translateX(${String(v)}px)` })),
        timing,
      ),
    ]
    if (tint) {
      animations.push(
        tint.animate(
          samples.values.map((v) => ({ opacity: tintOpacity(v) })),
          timing,
        ),
      )
    }
    if (action) {
      animations.push(
        action.animate(
          samples.values.map((v) => ({ opacity: actionOpacity(v) })),
          timing,
        ),
      )
    }
    const playing: Snap = { samples, animations }
    snap = playing
    const [moving] = animations
    if (moving) {
      moving.onfinish = () => {
        if (snap !== playing) return
        snap = null
        promote(false)
      }
    }
  }

  const start = (s: Session, e: PointerLike) => {
    s.started = true
    dragged = true
    clearTimeout(guard)
    // A row still settling is taken over where it is, without a jump.
    s.originX = currentX()
    stopSnap()
    s.history.push({ t: s.pressT, x: s.pressX })
    s.offsets.push({ t: Number.NEGATIVE_INFINITY, x: s.originX })
    try {
      content?.setPointerCapture(e.pointerId)
    } catch {
      // A pointer that is gone already (or a synthetic one): moves still arrive over the row.
    }
    promote(true)
  }

  /** The drag is over at `pointerX`: reveal or snap back, framer's rule. */
  const end = (pointerX: number, at: number) => {
    const s = session
    session = null
    if (!s?.started) return
    revealed = revealDecision(pointerX - s.pressX, pointerVelocity(s.history))
    snapTo(revealed ? REVEAL_X : 0, rowVelocity(s.offsets, at))
    clearTimeout(guard)
    guard = setTimeout(() => {
      dragged = false
    }, CLICK_GUARD_MS)
  }

  return {
    contentRef: (el) => {
      content = el
    },
    tintRef: (el) => {
      tint = el
    },
    actionRef: (el) => {
      action = el
    },
    onPointerDown: (e) => {
      // framer's rule: the left mouse button, or the primary touch or pen.
      if (e.pointerType === 'mouse' ? e.button !== 0 : !e.isPrimary) return
      if (session?.started) end(session.lastX, e.timeStamp)
      session = {
        pointerId: e.pointerId,
        pressX: e.clientX,
        pressY: e.clientY,
        pressT: e.timeStamp,
        started: false,
        originX: 0,
        history: [],
        offsets: [],
        lastX: e.clientX,
      }
    },
    onPointerMove: (e) => {
      const s = session
      if (!s || e.pointerId !== s.pointerId) return
      // A mouse or pen moving with nothing pressed: its pointerup was lost (outside the window).
      if (e.pointerType !== 'touch' && e.buttons === 0) {
        end(e.clientX, e.timeStamp)
        return
      }
      const dx = e.clientX - s.pressX
      if (!s.started) {
        if (!pastThreshold(dx, e.clientY - s.pressY)) return
        start(s, e)
      }
      put(constrainX(s.originX + dx))
      s.history.push({ t: e.timeStamp, x: e.clientX })
      s.offsets.push({ t: e.timeStamp, x })
      s.lastX = e.clientX
    },
    onPointerUp: (e) => {
      if (session?.pointerId === e.pointerId) end(e.clientX, e.timeStamp)
    },
    onPointerCancel: (e) => {
      if (session?.pointerId === e.pointerId) end(session.lastX, e.timeStamp)
    },
    onLostPointerCapture: (e) => {
      // Only the row's own capture: a touch is captured by what it went down on (the row
      // button), which loses it, and says so, as the drag takes it for the row.
      if (e.target === content && session?.pointerId === e.pointerId) {
        end(session.lastX, e.timeStamp)
      }
    },
    dragged: () => dragged,
    revealed: () => revealed,
    close: () => {
      revealed = false
      snapTo(0, 0)
    },
    clearGuard: () => {
      clearTimeout(guard)
      dragged = false
    },
    dispose: () => {
      clearTimeout(guard)
      stopSnap()
      session = null
    },
  }
}

/** One row's swipe: stable for the row's life; nothing it does re-renders the row. */
export function useSwipeReveal(): SwipeReveal {
  const [swipe] = useState(createSwipe)
  useEffect(() => swipe.dispose, [swipe])
  return swipe
}
