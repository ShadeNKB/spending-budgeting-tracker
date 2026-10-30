import { useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'

/** Bars split the width into equal bands; a line puts its first and last points on the edges. */
export type ScrubScale = 'band' | 'point'

/** Steps in points; Home and End run off either end, and the clamp stops them on it. */
const KEY_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 7,
  PageDown: -7,
  Home: -Infinity,
  End: Infinity,
}

/** The point under `x` px from the left of a `width`-px chart of `count` points (clamped). */
export function pointAt(
  x: number,
  width: number,
  count: number,
  scale: ScrubScale = 'band',
): number {
  const last = count - 1
  if (last <= 0 || width <= 0) return 0
  const raw = scale === 'band' ? Math.floor((x / width) * count) : Math.round((x / width) * last)
  return Math.min(last, Math.max(0, raw))
}

/**
 * A chart's description for screen readers: "Total S$60.00. Peak S$30.00 on Sep 30.", or "No
 * spending in this period." (a period without spending never reads as having a peak).
 */
export function seriesSummary(
  values: readonly number[],
  labelOf: (i: number) => string,
  fmt: (n: number) => string,
  preposition: 'on' | 'in' = 'on',
): string {
  const peak = Math.max(0, ...values)
  if (peak <= 0) return 'No spending in this period.'
  const total = values.reduce((sum, v) => sum + v, 0)
  const where = labelOf(values.indexOf(peak))
  return `Total ${fmt(total)}. Peak ${fmt(peak)}${where ? ` ${preposition} ${where}` : ''}.`
}

export interface ChartScrubProps {
  role: 'slider'
  tabIndex: 0
  'aria-valuemin': number
  'aria-valuemax': number
  'aria-valuenow': number
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

/**
 * A chart as one control (the slider pattern): one tab stop and one chart-wide target instead of
 * a tiny button per point. Hover with a mouse, press and drag with a finger or pen (give the
 * element `touch-pan-y` so a vertical swipe still scrolls the page), or focus it and step with
 * the arrows (PageUp / PageDown by seven, Home / End, Escape lets go). Focus shows the first
 * point, blur hides the reading. Spread `props` on the element and add its `aria-label` and the
 * `aria-valuetext` of `value`.
 */
export function useChartScrub({ count, scale = 'band' }: { count: number; scale?: ScrubScale }): {
  /** The point being read, or `null` when none is shown. */
  active: number | null
  /** The point the slider reports: the active one, else the first. */
  value: number
  props: ChartScrubProps
} {
  const [picked, setPicked] = useState<number | null>(null)
  const last = Math.max(0, count - 1)
  const clamp = (i: number) => Math.min(last, Math.max(0, i))
  // A shorter series (another month) keeps the reading on its last point.
  const active = picked === null ? null : clamp(picked)
  const value = active ?? 0

  const pointUnder = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return pointAt(e.clientX - box.left, box.width, count, scale)
  }

  return {
    active,
    value,
    props: {
      role: 'slider',
      tabIndex: 0,
      'aria-valuemin': 0,
      'aria-valuemax': last,
      'aria-valuenow': value,
      onPointerDown: (e) => {
        setPicked(pointUnder(e))
      },
      onPointerMove: (e) => {
        // Hover with a mouse; with a finger or pen only while pressed (a horizontal drag scrubs).
        if (e.pointerType === 'mouse' || e.buttons !== 0) setPicked(pointUnder(e))
      },
      onPointerLeave: (e) => {
        if (e.pointerType === 'mouse') setPicked(null)
      },
      onFocus: () => {
        setPicked((current) => current ?? 0)
      },
      onBlur: () => {
        setPicked(null)
      },
      onKeyDown: (e) => {
        // Alt+← is Back and Ctrl / ⌘ + arrows belong to the system: leave them alone.
        if (e.altKey || e.ctrlKey || e.metaKey) return
        const step = KEY_STEP[e.key]
        if (step !== undefined) {
          e.preventDefault()
          setPicked((current) => clamp(clamp(current ?? 0) + step))
        } else if (e.key === 'Escape') {
          setPicked(null)
        }
      },
    },
  }
}
