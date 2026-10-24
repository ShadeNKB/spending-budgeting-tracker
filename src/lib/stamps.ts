// Write stamps (`updatedAt`, budget stamps). Ordering only honours instants in a fixed
// window, so a hostile or corrupt far-future stamp cannot pin a record, and every device
// orders the same stamps the same way whatever its own clock says.
//
// Stamps are read by a parser of our own, never `Date.parse`: what `Date.parse` accepts beyond
// the canonical form is implementation-defined (Chromium reads "2026-10-19t08:00:00z" and
// "2026-02-30T08:00:00Z", WebKit returns NaN for both) and it reads a date-time without an
// offset as device-local time. Two devices that order one pair of copies differently each keep
// their own and push over each other forever. The grammar is the v5 engine's
// (`src/data/core/stamp.ts`), so v0.8.5 and v5 order every v4 stamp alike.

export const STAMP_MIN = Date.UTC(2000, 0, 1)
export const STAMP_MAX = Date.UTC(2100, 0, 1)
/** Written for budgets whose set time is unknown. Orders as 0. */
export const LEGACY_STAMP_ISO = '1970-01-01T00:00:00.000Z'

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
  if (hh > 23 || mm > 59) return Number.NaN
  return (z.startsWith('-') ? -1 : 1) * (hh * 60 + mm)
}

/**
 * Epoch ms of an ISO 8601 date or date-time, the same on every engine and in every time zone:
 * a text without an offset is read as UTC, fractions truncate to whole ms, and a day or time
 * that does not exist (2026-02-30, 12:60) is NaN, as is any other text.
 */
function isoMs(text: string): number {
  const m = ISO_STAMP.exec(text)
  if (m === null) return Number.NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4] ?? 0)
  const mi = Number(m[5] ?? 0)
  const sec = Number(m[6] ?? 0)
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))
  const endOfDay = h === 24 && mi === 0 && sec === 0 && ms === 0
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || (h > 23 && !endOfDay)) return Number.NaN
  if (mi > 59 || sec > 59) return Number.NaN
  const off = offsetMinutes(m[8] ?? 'Z')
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - off * 60_000
}

/** Epoch ms of an ISO stamp inside [2000, 2100), else 0 ("unknown", loses to every real stamp). */
export function stampMs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const t = isoMs(value)
  return Number.isFinite(t) && t >= STAMP_MIN && t < STAMP_MAX ? Math.floor(t) : 0
}

/** A stamp at `now`, but strictly after every base it supersedes (a slow clock still wins). */
export function nextStampIso(now: number, ...bases: number[]): string {
  const t = Math.min(STAMP_MAX - 1, Math.max(Math.floor(now), ...bases.map((b) => b + 1)))
  return new Date(t).toISOString()
}
