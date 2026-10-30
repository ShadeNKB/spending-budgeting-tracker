/**
 * The ledger row's swipe-to-reveal, in numbers: framer-motion 12.40's drag maths for the row it
 * used to drive (`drag="x"`, constraints -120..0, elastic 0.12 to the left only, the pan
 * session's 3 px start and 100 ms velocity, the motion value's own velocity), so the row feels
 * the same. Pure; the pointer wiring lives in useSwipeReveal.
 *
 * x is the row content's horizontal offset in px (0 at rest, negative to the left); times are
 * event timeStamps in ms (monotonic, never the wall clock).
 */
import type { SpringPhysics } from '../../ui/spring'

/** How far the row may be dragged: the swipe Delete is 96 px wide, with 24 px to spare. */
const MIN_X = -120
const MAX_X = 0
/** Past the left limit the row moves 0.12 px per px of pointer; never past 0 to the right. */
const ELASTIC = 0.12
/** A press becomes a drag once the pointer is this far (2-D) from where it went down. */
export const DRAG_THRESHOLD = 3
/** Where a revealed row rests: the swipe Delete fully in view. */
export const REVEAL_X = -96
/** Reveal when the pointer ends further left than this from the press... */
const REVEAL_OFFSET = -76
/** ...or leaves faster than this, in px/s. */
const REVEAL_VELOCITY = -650
/** framer's pan velocity looks back over this much of the pointer's history. */
const VELOCITY_WINDOW_MS = 100
/** motion-dom reads a value as still when it last changed longer ago than this. */
const STILL_AFTER_MS = 30
/** The snap: framer's `{ type: 'spring', stiffness: 420, damping: 40 }`. */
export const SNAP_SPRING: SpringPhysics = { stiffness: 420, damping: 40, mass: 1 }
/** Snap keyframes per second. */
export const SNAP_HZ = 120
/** After a drag, the click the browser sends with its release is not a tap. */
export const CLICK_GUARD_MS = 50

/** A pointer position or a row offset, with when it was taken. */
export interface Sample {
  readonly t: number
  readonly x: number
}

/** Where the row goes for a drag that would put it at `x` (framer's applyConstraints). */
export function constrainX(x: number): number {
  if (x < MIN_X) return MIN_X + (x - MIN_X) * ELASTIC
  return Math.min(x, MAX_X)
}

export function pastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD
}

/** Whether a released drag reveals the swipe Delete (else the row snaps back to 0). */
export function revealDecision(offset: number, velocity: number): boolean {
  return offset < REVEAL_OFFSET || velocity < REVEAL_VELOCITY
}

/**
 * The pointer's velocity at release in px/s: framer's `getVelocity(history, 0.1)`. `history` is
 * the press point and then one point per move since the drag started. It measures from the
 * newest point back to the first one more than 100 ms older (else the press point), except that
 * a press held for over 200 ms before a flick measures from the drag's first point instead.
 */
export function pointerVelocity(history: readonly Sample[]): number {
  const last = history.at(-1)
  if (!last || history.length < 2) return 0
  let from: Sample | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    from = history[i]
    if (from && last.t - from.t > VELOCITY_WINDOW_MS) break
  }
  if (!from) return 0
  if (from === history[0] && history.length > 2 && last.t - from.t > VELOCITY_WINDOW_MS * 2) {
    from = history[1] ?? from
  }
  const seconds = (last.t - from.t) / 1000
  if (seconds === 0) return 0
  const velocity = (last.x - from.x) / seconds
  return velocity === Infinity ? 0 : velocity
}

/**
 * The row's own velocity at `at`, in px/s, as motion-dom's MotionValue.getVelocity() gave it to
 * the snap: from the newest offset and the newest one taken earlier, over at most 30 ms; 0 once
 * the newest is more than 30 ms old. `samples` start with where the row was before the drag.
 */
export function rowVelocity(samples: readonly Sample[], at: number): number {
  const last = samples.at(-1)
  if (!last || at - last.t > STILL_AFTER_MS) return 0
  for (let i = samples.length - 2; i >= 0; i--) {
    const prev = samples[i]
    if (prev && prev.t < last.t) {
      return ((last.x - prev.x) * 1000) / Math.min(last.t - prev.t, STILL_AFTER_MS)
    }
  }
  return 0
}

/** Piecewise-linear map of x over ascending `xs` to `ys`, held at both ends. */
function piecewise(x: number, xs: readonly number[], ys: readonly number[]): number {
  const first = xs[0] ?? 0
  if (x <= first) return ys[0] ?? 0
  for (let i = 1; i < xs.length; i++) {
    const x1 = xs[i] ?? 0
    if (x <= x1) {
      const x0 = xs[i - 1] ?? 0
      const y0 = ys[i - 1] ?? 0
      const y1 = ys[i] ?? 0
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return ys.at(-1) ?? 0
}

/** The red tint behind the row (the colour of `bg-negative`): framer's background alpha. */
export function tintOpacity(x: number): number {
  return piecewise(x, [-120, -40, 0], [0.14, 0.04, 0])
}

/** The swipe Delete action's opacity. */
export function actionOpacity(x: number): number {
  return piecewise(x, [-120, -20, 0], [1, 0.6, 0])
}

/** Where a snap playing `samples` (one every `step` ms, linear between) has the row at `t`. */
export function xAt(
  samples: { readonly values: readonly number[]; readonly step: number },
  t: number,
): number {
  const { values, step } = samples
  const position = Math.max(0, t / step)
  const i = Math.floor(position)
  const a = values[Math.min(i, values.length - 1)] ?? 0
  const b = values[Math.min(i + 1, values.length - 1)] ?? a
  return a + (b - a) * (position - i)
}
