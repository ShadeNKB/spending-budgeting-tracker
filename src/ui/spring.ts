/**
 * The spring physics framer-motion 12.40 ran the app's motion with (motion-dom's `spring()`
 * generator, closed forms for under-, critically and over-damped springs), so the CSS and Web
 * Animations that replace it move the same way: the overlays' `linear()` easings in index.css
 * are sampled from it, and the ledger row's snap plays its samples.
 *
 * Time is in ms; velocity in units per second, positive towards larger values. At rest means
 * motion-dom's rule: speed at most 2 units/s and at most 0.5 units from the target (0.01 and
 * 0.005 when less than 5 units are travelled), and from then on the value is the target.
 */

export interface SpringPhysics {
  readonly stiffness: number
  readonly damping: number
  readonly mass?: number
}

export interface SpringOptions extends SpringPhysics {
  readonly from: number
  readonly to: number
  /** Initial velocity in units per second. */
  readonly velocity?: number
}

export interface Spring {
  /** The value `t` ms after the start: the target once at rest. */
  readonly at: (t: number) => number
  /** The velocity in units per second `t` ms after the start. */
  readonly velocityAt: (t: number) => number
  readonly restsAt: (t: number) => boolean
  /** The first whole ms at which it is at rest. */
  readonly duration: number
}

/** Longest a spring is followed (motion-dom's cap for generated keyframes). */
const MAX_MS = 20_000

export function spring({
  from,
  to,
  velocity = 0,
  stiffness,
  damping,
  mass = 1,
}: SpringOptions): Spring {
  const delta = to - from
  // motion-dom's sign: the closed forms below take minus the velocity, in units per ms.
  const v0 = -velocity / 1000
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  const w0 = Math.sqrt(stiffness / mass) / 1000
  const granular = Math.abs(delta) < 5
  const restSpeed = granular ? 0.01 : 2
  const restDelta = granular ? 0.005 : 0.5

  let position: (t: number) => number
  let speed: (t: number) => number // units per ms
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const a = (v0 + zeta * w0 * delta) / wd
    const sinCoeff = zeta * w0 * a + delta * wd
    const cosCoeff = zeta * w0 * delta - a * wd
    position = (t) => {
      const envelope = Math.exp(-zeta * w0 * t)
      return to - envelope * (a * Math.sin(wd * t) + delta * Math.cos(wd * t))
    }
    speed = (t) =>
      Math.exp(-zeta * w0 * t) * (sinCoeff * Math.sin(wd * t) + cosCoeff * Math.cos(wd * t))
  } else if (zeta === 1) {
    const c = v0 + w0 * delta
    position = (t) => to - Math.exp(-w0 * t) * (delta + c * t)
    speed = (t) => Math.exp(-w0 * t) * (w0 * c * t - v0)
  } else {
    const wd = w0 * Math.sqrt(zeta * zeta - 1)
    const p = (v0 + zeta * w0 * delta) / wd
    const sinhCoeff = zeta * w0 * p - delta * wd
    const coshCoeff = zeta * w0 * delta - p * wd
    position = (t) => {
      const envelope = Math.exp(-zeta * w0 * t)
      // sinh and cosh overflow to Infinity past ~710: motion-dom caps the argument at 300.
      const x = Math.min(wd * t, 300)
      return (
        to - (envelope * ((v0 + zeta * w0 * delta) * Math.sinh(x) + wd * delta * Math.cosh(x))) / wd
      )
    }
    speed = (t) => {
      const x = Math.min(wd * t, 300)
      return Math.exp(-zeta * w0 * t) * (sinhCoeff * Math.sinh(x) + coshCoeff * Math.cosh(x))
    }
  }

  const velocityAt = (t: number) => speed(t) * 1000
  const restsAt = (t: number) =>
    Math.abs(velocityAt(t)) <= restSpeed && Math.abs(to - position(t)) <= restDelta
  let duration = 0
  while (duration < MAX_MS && !restsAt(duration)) duration += 1

  return {
    at: (t) => (restsAt(t) ? to : position(t)),
    velocityAt,
    restsAt,
    duration,
  }
}

/** The spring sampled `hz` times a second until it rests; the last sample is exactly `to`. */
export function springSamples(
  options: SpringOptions,
  hz: number,
): { readonly values: readonly number[]; readonly step: number; readonly duration: number } {
  const s = spring(options)
  const step = 1000 / hz
  const values: number[] = []
  let t = 0
  while (!s.restsAt(t) && t < MAX_MS) {
    values.push(s.at(t))
    t = values.length * step
  }
  values.push(options.to)
  return { values, step, duration: (values.length - 1) * step }
}

/**
 * The spring's progress from 0 to 1 over a fixed `durationMs`, at `stops` + 1 evenly spaced
 * points, the last exactly 1: the stops of a CSS `linear()` easing. (Progress does not depend
 * on the distance; the thresholds of rest are left out: the transition ends at `durationMs`.)
 */
export function springEasing(physics: SpringPhysics, durationMs: number, stops: number): number[] {
  const unit = 1000
  const s = spring({ ...physics, from: 0, to: unit })
  const values: number[] = []
  for (let i = 0; i < stops; i++) values.push(s.at((i * durationMs) / stops) / unit)
  values.push(1)
  return values
}

/** `linear(...)` for the stops, each to `decimals` places (trailing zeros dropped). */
export function linearEasing(values: readonly number[], decimals = 4): string {
  const scale = 10 ** decimals
  const stops = values.map((v) => {
    const rounded = Math.round(v * scale) / scale
    return String(Object.is(rounded, -0) ? 0 : rounded)
  })
  return `linear(${stops.join(', ')})`
}
