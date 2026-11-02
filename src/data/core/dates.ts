// The date contract (DATA-ENGINE-SPEC §7.10, F-049, F-096; track spec P2-2, superseding PR-1 P-5).
// Pure: time arrives as arguments.
// - `day` ('yyyy-MM-dd', the owner's calendar day) is the truth for every bucket, filter and export.
// - Every v5 write stores `date = day + 'T12:00:00'`: the floating local noon, with no zone and no Z.
//   Every reader agrees on its day in every zone (its first ten characters ARE the day; Date,
//   parseISO and lib/dates readStored all read a zone-less date-time as local wall time), so no
//   UTC+12…+14 or UTC−10 device can shift it, and a v0.8 client reads it exactly as it always has.
// - Existing dates are never rewritten: a Z instant (the 0.9.x add sheet), a raw instant (0.9.x
//   quick add) or a bare day keeps its text, and its day is `localDay(date)` in the device zone,
//   which is what 0.9.4 showed.
// NEVER parse a bare 'yyyy-MM-dd' with the Date constructor: that is UTC midnight.
import { isValid, parseISO } from 'date-fns'
import type { ExpenseRec } from './types'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const YEAR_MIN = 1970
const YEAR_MAX = 2099

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 'yyyy-MM-dd', a real calendar day, year 1970–2099. */
export function validDay(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = DAY_RE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < YEAR_MIN || y > YEAR_MAX || mo < 1 || mo > 12 || d < 1) return false
  const max = mo === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[mo - 1] ?? 0)
  return d <= max
}

/** The value of `n` decimal digits at `at`, or -1 when any of them is not a digit. */
function digits(s: string, at: number, n: number): number {
  let v = 0
  for (let i = at; i < at + n; i++) {
    const c = s.charCodeAt(i) - 48
    if (!(c >= 0 && c <= 9)) return -1
    v = v * 10 + c
  }
  return v
}

const DASH = 45
const COLON = 58
const DOT = 46
const LETTER_T = 84
const LETTER_Z = 90

/**
 * The instant parseISO gives `yyyy-MM-ddTHH:mm:ss[.f{1,3}]Z` (what `toISOString` writes, i.e.
 * nearly every stored date) when every field is in its ordinary range, computed with parseISO's own
 * arithmetic so even fractional seconds truncate identically; NaN for every other text, which then
 * takes the date-fns path. Boot decodes thousands of these, so this reads char codes, no regex.
 */
function canonicalInstant(s: string): number {
  const len = s.length
  if (len < 20 || len > 24 || len === 21 || s.charCodeAt(len - 1) !== LETTER_Z) return NaN
  if (
    s.charCodeAt(4) !== DASH ||
    s.charCodeAt(7) !== DASH ||
    s.charCodeAt(10) !== LETTER_T ||
    s.charCodeAt(13) !== COLON ||
    s.charCodeAt(16) !== COLON ||
    (len > 20 && (s.charCodeAt(19) !== DOT || digits(s, 20, len - 21) < 0))
  ) {
    return NaN
  }
  const y = digits(s, 0, 4)
  const mo = digits(s, 5, 2)
  const d = digits(s, 8, 2)
  const h = digits(s, 11, 2)
  const mi = digits(s, 14, 2)
  const whole = digits(s, 17, 2)
  const days = mo === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[mo - 1] ?? 0)
  if (
    y < YEAR_MIN ||
    y > YEAR_MAX ||
    mo < 1 ||
    d < 1 ||
    d > days ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    whole < 0 ||
    whole > 59
  ) {
    return NaN
  }
  const sec = len === 20 ? whole : Number.parseFloat(s.slice(17, len - 1))
  return Date.UTC(y, mo - 1, d) + (h * 3_600_000 + mi * 60_000 + sec * 1000)
}

/**
 * The local Date parseISO gives a zone-less `yyyy-MM-ddTHH:mm:ss` (the floating noon every v5 write
 * stores, P2-2) when every field is in its ordinary range and that wall time exists in this zone;
 * null for every other text. A wall time the zone skipped (a DST gap, Kiritimati's 1994-12-31) does
 * not read back with its own fields, and parseISO decides where it lands. Char codes, no regex:
 * boot decodes thousands of these.
 */
function floatingLocal(s: string): Date | null {
  if (
    s.length !== 19 ||
    s.charCodeAt(4) !== DASH ||
    s.charCodeAt(7) !== DASH ||
    s.charCodeAt(10) !== LETTER_T ||
    s.charCodeAt(13) !== COLON ||
    s.charCodeAt(16) !== COLON
  ) {
    return null
  }
  const y = digits(s, 0, 4)
  const mo = digits(s, 5, 2)
  const d = digits(s, 8, 2)
  const h = digits(s, 11, 2)
  const mi = digits(s, 14, 2)
  const sec = digits(s, 17, 2)
  const days = mo === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[mo - 1] ?? 0)
  if (
    y < YEAR_MIN ||
    y > YEAR_MAX ||
    mo < 1 ||
    d < 1 ||
    d > days ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    sec < 0 ||
    sec > 59
  ) {
    return null
  }
  const local = new Date(y, mo - 1, d, h, mi, sec)
  return local.getDate() === d && local.getHours() === h && local.getMinutes() === mi ? local : null
}

/**
 * A valid ISO date-time (date-fns parseISO) whose literal year is 1970–2099, else null. The year
 * is read from the text, not from the zone-dependent Date, so every device agrees (§8.1).
 */
export function parseDateLike(s: string): Date | null {
  const fast = canonicalInstant(s)
  if (!Number.isNaN(fast)) return new Date(fast)
  const floating = floatingLocal(s)
  if (floating !== null) return floating
  const year = /^(\d{4})-/.exec(s)
  if (!year) return null
  const y = Number(year[1])
  if (y < YEAR_MIN || y > YEAR_MAX) return null
  const parsed = parseISO(s)
  return isValid(parsed) ? parsed : null
}

/** parseDateLike(s) !== null, without building a Date for the canonical Z form. */
export const isDateText = (s: string): boolean =>
  !Number.isNaN(canonicalInstant(s)) || parseDateLike(s) !== null

const dayOfDate = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * The calendar day of an ISO string in the device zone: a bare valid day as-is, a zone-less wall
 * time (the floating noon) by its own date, an instant by the local day it falls on.
 */
export function localDay(isoText: string): string | null {
  const fast = canonicalInstant(isoText)
  if (!Number.isNaN(fast)) return dayOfDate(new Date(fast))
  if (floatingLocal(isoText) !== null) return isoText.slice(0, 10)
  if (validDay(isoText)) return isoText
  const parsed = parseISO(isoText)
  return isValid(parsed) ? dayOfDate(parsed) : null
}

/** The `date` every v5 add, edit and revive stores for `day`: its floating local noon (P2-2). */
export const localNoonIso = (day: string): string => `${day}T12:00:00`

/** Today's local day for a wall-clock reading. */
export const todayDay = (wall: number): string => dayOfDate(new Date(wall))

/**
 * Every bucket, filter and export uses this (T3): the stored day, else the local day of the date
 * (a v0.8 record, read as 0.9.4 shows it).
 */
export function dayOf(rec: ExpenseRec): string {
  const d = rec.d.v
  return d.day ?? localDay(d.date) ?? d.date.slice(0, 10)
}
