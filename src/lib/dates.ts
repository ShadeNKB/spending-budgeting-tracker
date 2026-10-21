import { format, parseISO } from 'date-fns'

/**
 * The one date contract for every number on screen.
 *
 * A row belongs to the local calendar day (device time zone at render time) of its stored
 * instant; a date-only row belongs to that calendar date. That is exactly
 * `format(parseISO(date), 'yyyy-MM-dd')`; this module computes it fast and does all period
 * arithmetic on the resulting keys, so time of day and DST can never move a row between days.
 */

/** A local calendar day, `yyyy-MM-dd`. Lexicographic order is time order. */
export type DayKey = string
/** A local calendar month, `yyyy-MM`. */
export type MonthKey = string
/** An inclusive range of whole local days. */
export interface DayRange {
  readonly start: DayKey
  readonly end: DayKey
}
export interface Comparison {
  readonly range: DayRange
  /** What is compared against: "Sep 1–18", "September", "2025 to Oct 18". */
  readonly against: string
  /** `vs ${against}` */
  readonly label: string
}

/** Earlier than any real key: the open start of an unbounded custom range. */
const MIN_KEY: DayKey = '0000-01-01'

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const
const DAY_MS = 86_400_000

const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n))
const pad4 = (n: number): string => String(n).padStart(4, '0')

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 31
}

export const makeKey = (year: number, month: number, day: number): DayKey =>
  `${pad4(year)}-${pad2(month)}-${pad2(day)}`

export const keyYear = (key: DayKey): number => Number(key.slice(0, 4))
export const keyMonth = (key: DayKey): number => Number(key.slice(5, 7))
export const keyDay = (key: DayKey): number => Number(key.slice(8, 10))

/** The local calendar day of a Date. */
export const toDayKey = (date: Date): DayKey =>
  makeKey(date.getFullYear(), date.getMonth() + 1, date.getDate())

export const todayKey = (now: Date = new Date()): DayKey => toDayKey(now)

// ─── Stored dates (read side) ─────────────────────────────────────────────────

// Structure only; fields are read by position: Y 0-3, M 5-6, D 8-9, h 11-12, m 14-15, s 17-18.
const DATE_ONLY = /^[1-9]\d{3}-\d{2}-\d{2}$/
const DATE_TIME =
  /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/

/** Two ASCII digits at `i` as a number (the regex has already checked they are digits). */
const d2 = (s: string, i: number): number => (s.charCodeAt(i) - 48) * 10 + s.charCodeAt(i + 1) - 48

interface Parsed {
  key: DayKey | null
  time: number
}

const INVALID: Parsed = { key: null, time: Number.NaN }

const validYmd = (y: number, m: number, d: number): boolean =>
  m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)

/** The slow path: whatever date-fns makes of it, so the result is identical by construction. */
function parseSlow(s: string): Parsed {
  try {
    const d = parseISO(s)
    const time = d.getTime()
    if (Number.isNaN(time)) return INVALID
    const key = format(d, 'yyyy-MM-dd')
    // Keys are always 10 characters; a 5-digit year would break key arithmetic, so it is
    // treated like any other unusable date (listed under "Unknown date").
    return key.length === 10 ? { key, time } : INVALID
  } catch {
    return INVALID
  }
}

/** Milliseconds from a 1-3 digit fraction ("5" → 500, "05" → 50, "123" → 123). */
function fractionMs(fraction: string | undefined): number {
  if (fraction === undefined) return 0
  let ms = 0
  for (let i = 0; i < 3; i++) ms = ms * 10 + (i < fraction.length ? fraction.charCodeAt(i) - 48 : 0)
  return ms
}

/**
 * Parse a stored `date` once into its local day key and epoch time. Fast paths for the forms
 * the app writes (`yyyy-MM-dd`, local `…T12:00:00`, ISO-Z, `±HH:MM` offsets), reading digits by
 * position; anything else, or any value at an edge (24:00, a DST gap), goes through `parseISO`.
 * Never throws; invalid → `{ key: null, time: NaN }`.
 */
export function readStored(value: unknown): Parsed {
  if (typeof value !== 'string') return INVALID
  const y = d2(value, 0) * 100 + d2(value, 2)
  const m = d2(value, 5)
  const d = d2(value, 8)
  if (DATE_ONLY.test(value)) {
    return validYmd(y, m, d) ? { key: value, time: new Date(y, m - 1, d).getTime() } : INVALID
  }
  const dt = DATE_TIME.exec(value)
  if (!dt) return parseSlow(value)
  // V8 rolls 2026-02-30T12:00 over to Mar 2; date-fns calls it invalid. Validate first.
  if (!validYmd(y, m, d)) return INVALID
  const hour = d2(value, 11)
  const minute = d2(value, 14)
  const second = value.charCodeAt(16) === 58 ? d2(value, 17) : 0 // ':'
  if (hour > 23 || minute > 59 || second > 59) return parseSlow(value)
  const ms = fractionMs(dt[1])
  const zone = dt[2]
  if (zone === undefined) {
    // Local wall time: its day is the written day unless a DST gap pushed it past midnight.
    const local = new Date(y, m - 1, d, hour, minute, second, ms)
    return local.getDate() === d
      ? { key: value.slice(0, 10), time: local.getTime() }
      : parseSlow(value)
  }
  let offset = 0
  if (zone !== 'Z') {
    const offsetHour = d2(zone, 1)
    const offsetMinute = d2(zone, 4)
    if (offsetHour > 14 || offsetMinute > 59) return parseSlow(value)
    offset = (zone.charCodeAt(0) === 45 ? -1 : 1) * (offsetHour * 60 + offsetMinute) // '-'
  }
  const time = Date.UTC(y, m - 1, d, hour, minute, second, ms) - offset * 60_000
  return { key: toDayKey(new Date(time)), time }
}

/** The local day a stored date belongs to, or `null` when it cannot be read. */
export const dayKeyOfStored = (value: unknown): DayKey | null => readStored(value).key

// ─── Key arithmetic (time-zone free) ──────────────────────────────────────────

function utcMs(key: DayKey): number {
  const d = new Date(0)
  d.setUTCFullYear(keyYear(key), keyMonth(key) - 1, keyDay(key))
  return d.getTime()
}

export function addDays(key: DayKey, n: number): DayKey {
  const d = new Date(0)
  d.setUTCFullYear(keyYear(key), keyMonth(key) - 1, keyDay(key) + n)
  return makeKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export const diffDays = (a: DayKey, b: DayKey): number => Math.round((utcMs(b) - utcMs(a)) / DAY_MS)

/** 0 = Sunday … 6 = Saturday. */
export const dayOfWeek = (key: DayKey): number => new Date(utcMs(key)).getUTCDay()

export const sundayOnOrBefore = (key: DayKey): DayKey => addDays(key, -dayOfWeek(key))

/** Every key from `start` to `end` inclusive (empty when `end < start`). */
export function enumerateDays(range: DayRange): DayKey[] {
  const out: DayKey[] = []
  if (range.end < range.start) return out
  let y = keyYear(range.start)
  let m = keyMonth(range.start)
  let d = keyDay(range.start)
  let key = range.start
  while (key <= range.end) {
    out.push(key)
    d += 1
    if (d > daysInMonth(y, m)) {
      d = 1
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
    key = makeKey(y, m, d)
  }
  return out
}

export const monthKeyOf = (key: DayKey): MonthKey => key.slice(0, 7)

export function addMonths(month: MonthKey, n: number): MonthKey {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n
  const y = Math.floor(total / 12)
  return `${pad4(y)}-${pad2(total - y * 12 + 1)}`
}

export function monthRange(month: MonthKey): DayRange {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return { start: `${month}-01`, end: makeKey(y, m, daysInMonth(y, m)) }
}

export const yearRange = (year: number): DayRange => ({
  start: makeKey(year, 1, 1),
  end: makeKey(year, 12, 31),
})

/** `[today - (n - 1), today]`: "Last 7 days" is today and the six days before it. */
export const lastNDays = (today: DayKey, n: number): DayRange => ({
  start: addDays(today, -(n - 1)),
  end: today,
})

/**
 * Month to date vs the same days of the previous month, clamped to its length
 * (Mar 30 → all of February). Labelled "vs Sep 1–18", or "vs September" when whole.
 */
export function prevMonthLikeForLike(today: DayKey): Comparison {
  const prev = addMonths(monthKeyOf(today), -1)
  const py = Number(prev.slice(0, 4))
  const pm = Number(prev.slice(5, 7))
  const dim = daysInMonth(py, pm)
  const endDay = Math.min(keyDay(today), dim)
  const short = MONTHS_SHORT[pm - 1] ?? ''
  const against =
    endDay === dim ? monthName(prev) : endDay === 1 ? `${short} 1` : `${short} 1–${String(endDay)}`
  return {
    range: { start: `${prev}-01`, end: makeKey(py, pm, endDay) },
    against,
    label: `vs ${against}`,
  }
}

/** Year to date vs the previous year up to the same month/day (Feb 29 → Feb 28). */
export function prevYearLikeForLike(today: DayKey): Comparison {
  const py = keyYear(today) - 1
  const m = keyMonth(today)
  const d = Math.min(keyDay(today), daysInMonth(py, m))
  const end = makeKey(py, m, d)
  const against = m === 12 && d === 31 ? String(py) : `${String(py)} to ${shortDate(end)}`
  return { range: { start: makeKey(py, 1, 1), end }, against, label: `vs ${against}` }
}

// ─── Ledger ranges ────────────────────────────────────────────────────────────

export type RangeName = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom'

export interface RangeOptions {
  /** A specific day (`?date=`) overrides the range. */
  readonly date?: DayKey | null
  readonly customStart?: DayKey
  readonly customEnd?: DayKey
}

/** The days a ledger view covers; `null` = everything, including rows with unreadable dates. */
export function ledgerRange(
  range: RangeName,
  today: DayKey,
  opts: RangeOptions = {},
): DayRange | null {
  if (opts.date) return { start: opts.date, end: opts.date }
  switch (range) {
    case 'today':
      return { start: today, end: today }
    case 'week':
      return lastNDays(today, 7)
    case 'month':
      return monthRange(monthKeyOf(today))
    case 'year':
      return yearRange(keyYear(today))
    case 'custom': {
      const a = opts.customStart || MIN_KEY
      const b = opts.customEnd || today
      return a <= b ? { start: a, end: b } : { start: b, end: a }
    }
    case 'all':
      return null
  }
}

export function ledgerRangeLabel(range: RangeName, today: DayKey, opts: RangeOptions = {}): string {
  if (opts.date) return shortDateYear(opts.date)
  switch (range) {
    case 'today':
      return `Today · ${formatKey(today, 'EEE, MMM d')}`
    case 'week':
      return `Last 7 days · ${formatRangeLabel(lastNDays(today, 7), today)}`
    case 'month':
      return monthLabel(monthKeyOf(today))
    case 'year':
      return String(keyYear(today))
    case 'custom': {
      const { customStart, customEnd } = opts
      if (customStart && customEnd)
        return `${shortDateYear(customStart)} – ${shortDateYear(customEnd)}`
      if (customStart) return `From ${shortDateYear(customStart)}`
      if (customEnd) return `Until ${shortDateYear(customEnd)}`
      return 'Custom range'
    }
    case 'all':
      return 'All time'
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

/** Local noon of a key: the only safe Date to hand to a formatter. */
export function keyToLocalNoon(key: DayKey): Date {
  const d = new Date(2000, 0, 1, 12)
  d.setFullYear(keyYear(key), keyMonth(key) - 1, keyDay(key))
  return d
}

/** date-fns `format` on the key's local noon, for patterns without a fast helper. */
export const formatKey = (key: DayKey, pattern: string): string =>
  format(keyToLocalNoon(key), pattern)

/** "Oct 18" */
export const shortDate = (key: DayKey): string =>
  `${MONTHS_SHORT[keyMonth(key) - 1] ?? ''} ${String(keyDay(key))}`

/** "Oct 18, 2026" */
export const shortDateYear = (key: DayKey): string => `${shortDate(key)}, ${String(keyYear(key))}`

/** "October 18" */
export const longDate = (key: DayKey): string =>
  `${MONTHS_LONG[keyMonth(key) - 1] ?? ''} ${String(keyDay(key))}`

/** "Sun" */
export const weekdayShort = (key: DayKey): string => WEEKDAYS_SHORT[dayOfWeek(key)] ?? ''

/** "October" */
export const monthName = (month: MonthKey): string =>
  MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? ''

/** "Oct" */
export const monthShortName = (month: MonthKey): string =>
  MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? ''

/** "October 2026" */
export const monthLabel = (month: MonthKey): string => `${monthName(month)} ${month.slice(0, 4)}`

/** "Oct 12 – Oct 18"; a year appears only on a side whose year differs from today's. */
export function formatRangeLabel(range: DayRange, today: DayKey): string {
  const year = keyYear(today)
  const sy = keyYear(range.start)
  const ey = keyYear(range.end)
  if (range.start === range.end)
    return sy === year ? shortDate(range.start) : shortDateYear(range.start)
  if (sy === ey && sy === year) return `${shortDate(range.start)} – ${shortDate(range.end)}`
  if (sy === ey) return `${shortDate(range.start)} – ${shortDateYear(range.end)}`
  const side = (key: DayKey, y: number) => (y === year ? shortDate(key) : shortDateYear(key))
  return `${side(range.start, sy)} – ${side(range.end, ey)}`
}
