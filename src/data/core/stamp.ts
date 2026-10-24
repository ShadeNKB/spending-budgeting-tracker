// Stamps and the hybrid logical clock (DATA-ENGINE-SPEC §4.1, §4.2). Pure.
import { MAX_AHEAD, MAX_T, MIN_T } from './constants'
import type { Hlc, Stamp } from './types'

/** Ordering stamp: anything outside the FIXED window [2000, 2100) is 0 ("unknown"). */
export const vs = (t: number): Stamp =>
  Number.isFinite(t) && t >= MIN_T && t < MAX_T ? Math.floor(t) : 0

/** yyyy-MM-dd, then optionally [T or space]HH:mm[:ss[.fraction]] and an offset (Z, ±HH, ±HHmm, ±HH:mm). */
const ISO_STAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const daysIn = (y: number, mo: number): number =>
  mo === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : (DAYS_IN_MONTH[mo - 1] ?? 0)

/** Minutes east of UTC of an offset group, or NaN when out of range. */
function offsetMinutes(z: string): number {
  if (z === 'Z') return 0
  const hh = Number(z.slice(1, 3))
  const mm = z.length > 3 ? Number(z.slice(-2)) : 0
  if (hh > 23 || mm > 59) return NaN
  return (z.startsWith('-') ? -1 : 1) * (hh * 60 + mm)
}

/**
 * Epoch ms of an ISO 8601 date or date-time, identical on every engine and in every time zone. A
 * text WITHOUT an offset is read as UTC: `Date.parse` reads such a date-time as device-local time,
 * so a zone-less `createdAt` would decode to different stamps, seals and digests on two devices
 * (hard constraint 5, I4). Fractions truncate to whole ms. Any other text is NaN.
 */
function isoMs(text: string): number {
  const m = ISO_STAMP.exec(text)
  if (m === null) return NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4] ?? 0)
  const mi = Number(m[5] ?? 0)
  const sec = Number(m[6] ?? 0)
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))
  const endOfDay = h === 24 && mi === 0 && sec === 0 && ms === 0
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || (h > 23 && !endOfDay)) return NaN
  if (mi > 59 || sec > 59) return NaN
  const off = offsetMinutes(m[8] ?? 'Z')
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - off * 60_000
}

/** Parses a wire stamp (ISO string or epoch number), wall-clock and time-zone independent. */
export const ps = (x: unknown): Stamp =>
  typeof x === 'string' ? vs(isoMs(x)) : typeof x === 'number' ? vs(x) : 0

/** ms precision, 'Z'. */
export const iso = (t: Stamp): string => new Date(t).toISOString()

/**
 * A device clock before 2000 (a phone reset to the 1970 epoch) reads as MIN_T: a stamp below the
 * window would be kept raw here but decode as 0 everywhere else, so the doc would never survive its
 * own round trip (I4) and would push on every cycle (I5).
 */
const wallIn = (wall: number): number => Math.max(wall, MIN_T)

/**
 * A stamp strictly above everything issued on this clock and above `base`, the version the
 * write supersedes (the per-entity causal floor), always inside the window. The clock follows at
 * most 24 h ahead of wall.
 */
export function tick(c: Hlc, wall: number, base: Stamp = 0): Stamp {
  const now = wallIn(wall)
  const t = Math.min(MAX_T - 1, Math.max(now, c.last + 1, base + 1))
  c.last = Math.max(c.last, Math.min(t, now + MAX_AHEAD))
  return t
}

/** Called with the max stamp of every merged remote document. */
export function observe(c: Hlc, wall: number, seen: Stamp): void {
  c.last = Math.max(c.last, Math.min(seen, wallIn(wall) + MAX_AHEAD))
}
