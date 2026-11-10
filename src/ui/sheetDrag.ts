import { useRef, type RefObject } from 'react'
import { flushStyle, prefersReducedMotion } from './motion'

// A bottom sheet shows a drag handle: pulled down by it (or by the title bar) the sheet follows
// the finger, and on release it closes or springs back (F-113). The panel is placed by transform
// from its classes alone (Sheet.tsx), so while a finger holds it the drag takes the transform
// over inline, and hands it back on release: the class's transition then runs from where the
// finger left it, down and out (closed) or back up (open). Close and Escape remain for anyone
// who does not drag.

/** Movement before a press counts as a drag, so a tap on the title bar moves nothing. */
const SLOP_PX = 6
/** Released this far down, or further, the sheet closes: 30 % of its height, 140 px at most. */
const CLOSE_FRACTION = 0.3
const CLOSE_MAX_PX = 140
/** A flick: released moving down at this speed, after at least this distance. */
const FLICK_PX_PER_MS = 0.5
const FLICK_MIN_PX = 24
/** A finger that rested this long before lifting was not flicking. */
const REST_MS = 100

/** Whether a sheet `height` px tall, released `dy` px down while moving at `velocity`, closes. */
export function dragCloses(dy: number, velocity: number, height: number): boolean {
  if (dy <= 0) return false
  if (velocity >= FLICK_PX_PER_MS && dy >= FLICK_MIN_PX) return true
  return dy >= Math.min(height * CLOSE_FRACTION, CLOSE_MAX_PX)
}

interface PointerLike {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean
  readonly button: number
  readonly clientY: number
  readonly timeStamp: number
  readonly target: EventTarget | null
  readonly currentTarget: Element
}

interface ClickLike {
  preventDefault(): void
  stopPropagation(): void
}

interface Drag {
  readonly pointerId: number
  /** Reduce Motion was on as the press began. */
  readonly reduced: boolean
  readonly startY: number
  lastY: number
  lastT: number
  velocity: number
  moved: boolean
}

export interface SheetDrag {
  readonly onPointerDown: (e: PointerLike) => void
  readonly onPointerMove: (e: PointerLike) => void
  readonly onPointerUp: (e: PointerLike) => void
  readonly onPointerCancel: (e: PointerLike) => void
  readonly onClickCapture: (e: ClickLike) => void
}

/** Handlers for the part of a bottom sheet it is dragged by; `panel` is what moves. */
export function useSheetDrag(panel: RefObject<HTMLElement | null>, onClose: () => void): SheetDrag {
  const drag = useRef<Drag | null>(null)
  // The click that follows a drag's release is the drag's, not a press on what is under it.
  const dragged = useRef(false)

  const end = (e: PointerLike, cancelled: boolean) => {
    const d = drag.current
    if (d?.pointerId !== e.pointerId) return
    drag.current = null
    const el = panel.current
    if (!el || !d.moved) return
    dragged.current = true
    const dy = Math.max(0, e.clientY - d.startY)
    const velocity = e.timeStamp - d.lastT > REST_MS ? 0 : d.velocity
    const closes = !cancelled && dragCloses(dy, velocity, el.offsetHeight)
    // Back to the classes. The transition is restored first and the style read, so it runs from
    // the dragged place; the state change that follows (closing) is committed before the next
    // style is computed, so there is one transition, straight to where the sheet is going.
    el.style.removeProperty('transition')
    flushStyle(el)
    el.style.removeProperty('transform')
    if (closes) onClose()
  }

  return {
    onPointerDown: (e) => {
      dragged.current = false
      if (drag.current !== null) return
      if (e.pointerType === 'mouse' ? e.button !== 0 : !e.isPrimary) return
      // A press on Close (or any control in the title bar) is that control's.
      if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) {
        return
      }
      drag.current = {
        pointerId: e.pointerId,
        reduced: prefersReducedMotion(),
        startY: e.clientY,
        lastY: e.clientY,
        lastT: e.timeStamp,
        velocity: 0,
        moved: false,
      }
      // The finger may leave the title bar on its way down.
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // A pointer that is gone already, or one a test made: its moves still arrive over the bar.
      }
    },
    onPointerMove: (e) => {
      const d = drag.current
      const el = panel.current
      if (d?.pointerId !== e.pointerId || !el) return
      const dy = Math.max(0, e.clientY - d.startY)
      const dt = e.timeStamp - d.lastT
      if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt
      d.lastY = e.clientY
      d.lastT = e.timeStamp
      if (!d.moved && dy < SLOP_PX) return
      d.moved = true
      // Under Reduce Motion the stylesheet holds the panel still with !important. A sheet held
      // by a finger still follows it there, as a swiped ledger row does and as the system's own
      // sheets do: the inline style has to outrank the rule. Released, it is the stylesheet's
      // again, which then moves nothing: the sheet is back in place, or gone, at once.
      const priority = d.reduced ? 'important' : ''
      el.style.setProperty('transition', 'none', priority)
      el.style.setProperty('transform', `translateY(${String(dy)}px)`, priority)
    },
    onPointerUp: (e) => {
      end(e, false)
    },
    onPointerCancel: (e) => {
      end(e, true)
    },
    onClickCapture: (e) => {
      if (!dragged.current) return
      dragged.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
