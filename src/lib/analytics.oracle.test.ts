import { describe, expect, it } from 'vitest'
import {
  addDays as dfAddDays,
  endOfDay,
  endOfMonth,
  endOfYear,
  format,
  getDate,
  getDaysInMonth,
  isSameDay,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from 'date-fns'
import { computeMonthAnalytics, computeWeekAnalytics, computeYearAnalytics } from './analytics'
import { ledgerRange, todayKey } from './dates'
import { getLedgerIndex, rowsInRange, sumRange } from './ledgerIndex'
import type { Expense } from '../types'

/**
 * Differential oracle: a deliberately naive reference (parseISO + date-fns intervals + plain
 * loops, the way the app computed things before the index) must agree, to the cent, with the
 * indexed analytics at boundary clocks. Runs under whatever TZ the process has, so CI's
 * Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati legs each check their own midnight.
 */

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CLOCKS: [string, Date][] = [
  ['1 Oct 00:05', new Date(2026, 9, 1, 0, 5)],
  ['15 Oct 11:55', new Date(2026, 9, 15, 11, 55)],
  ['30 Sep 23:55', new Date(2026, 8, 30, 23, 55)],
  ['31 Mar 09:30', new Date(2027, 2, 31, 9, 30)],
  ['29 Feb 2028 12:30', new Date(2028, 1, 29, 12, 30)],
  ['1 Jan 2027 00:05', new Date(2027, 0, 1, 0, 5)],
  ['31 Dec 23:55', new Date(2026, 11, 31, 23, 55)],
]

const CATEGORIES = ['Food & Dining', 'Transportation', 'Shopping', 'Investment', 'constructor']

/** Every stored form the app has ever written, for one local instant. */
function storedForm(d: Date, r: number): string {
  if (r < 0.4) return format(d, "yyyy-MM-dd'T'12:00:00") // sheets: local noon
  if (r < 0.75) return d.toISOString() // quick add: the real instant, UTC
  if (r < 0.95) return format(d, 'yyyy-MM-dd') // legacy date-only
  if (r < 0.98) return format(d, "yyyy-MM-dd'T'HH:mm:ss.SSS") // local with time
  return 'not-a-date'
}

function buildFixture(): Expense[] {
  const rand = mulberry32(641)
  const out: Expense[] = []
  const push = (d: Date, form: number) => {
    const n = out.length
    out.push({
      id: `o${String(n).padStart(5, '0')}`,
      itemName: `item ${String(n % 97)}`,
      amount: Math.round((0.5 + rand() * 120) * 100) / 100,
      category: CATEGORIES[Math.floor(rand() * CATEGORIES.length)] ?? 'Other',
      date: storedForm(d, form),
      createdAt: d.toISOString(),
    })
  }
  // 641 rows spread over 2025-07 .. 2028-03 (the owner's real count; invented content).
  const lo = new Date(2025, 6, 1).getTime()
  const hi = new Date(2028, 2, 31).getTime()
  for (let i = 0; i < 641; i++) push(new Date(lo + Math.floor(rand() * (hi - lo))), rand())
  // Boundary rows around every clock: the minutes either side of local midnight, in every form.
  for (const [, clock] of CLOCKS) {
    for (let day = -14; day <= 1; day++) {
      const base = dfAddDays(startOfDay(clock), day)
      for (const minutes of [1, 4, 6, 12 * 60, 23 * 60 + 56, 23 * 60 + 59]) {
        push(new Date(base.getTime() + minutes * 60_000), rand())
      }
    }
  }
  return out
}

const fixture = buildFixture()
const cents = (n: number) => Math.round(n * 100)

/** The reference: no index, no keys. */
function reference(now: Date) {
  const rows = fixture
    .map((e) => ({ e, d: parseISO(e.date), c: Number.isFinite(e.amount) ? cents(e.amount) : 0 }))
    .filter(({ d }) => !Number.isNaN(d.getTime()))
  const sum = (start: Date, end: Date, pred: (e: Expense) => boolean = () => true) => {
    let s = 0
    for (const { e, d, c } of rows) if (d >= start && d <= end && pred(e)) s += c
    return s
  }
  const dom = getDate(now)
  const prevMonthStart = startOfMonth(subMonths(now, 1))
  const likeEnd = endOfDay(
    dfAddDays(prevMonthStart, Math.min(dom, getDaysInMonth(prevMonthStart)) - 1),
  )
  const prevYear = subYears(now, 1)
  const prevYearSameDay = endOfDay(
    new Date(
      prevYear.getFullYear(),
      now.getMonth(),
      Math.min(dom, getDaysInMonth(new Date(prevYear.getFullYear(), now.getMonth(), 1))),
    ),
  )
  const monthTotalAt = (offset: number) => {
    const ref = subMonths(now, offset)
    return sum(startOfMonth(ref), endOfMonth(ref))
  }
  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = subDays(now, 29 - i)
    let s = 0
    for (const { d, c } of rows) if (isSameDay(d, day)) s += c
    return s
  })
  const yearMonths = Array.from({ length: 12 }, (_, m) =>
    sum(new Date(now.getFullYear(), m, 1), endOfMonth(new Date(now.getFullYear(), m, 1))),
  )
  return {
    month: sum(startOfMonth(now), endOfMonth(now)),
    monthToDate: sum(startOfMonth(now), endOfDay(now)),
    prevLikeForLike: sum(prevMonthStart, likeEnd),
    pastMonths: [1, 2, 3].map(monthTotalAt),
    today: sum(startOfDay(now), endOfDay(now)),
    week: sum(startOfDay(subDays(now, 6)), endOfDay(now)),
    prevWeek: sum(startOfDay(subDays(now, 13)), endOfDay(subDays(now, 7))),
    daily,
    year: sum(startOfYear(now), endOfYear(now)),
    yearToDate: sum(startOfYear(now), endOfDay(now)),
    prevYearLikeForLike: sum(startOfYear(prevYear), prevYearSameDay),
    yearMonths,
    foodMonth: sum(startOfMonth(now), endOfMonth(now), (e) => e.category === 'Food & Dining'),
  }
}

describe.each(CLOCKS)('analytics agree with the reference at %s', (_name, now) => {
  const ref = reference(now)
  const today = todayKey(now)
  const index = getLedgerIndex(fixture)

  it('month, month-to-date comparison, today and budgets', () => {
    const a = computeMonthAnalytics(index, { 'Food & Dining': 400 }, today)
    expect(cents(a.periodTotal)).toBe(ref.month)
    expect(cents(a.comparison.total)).toBe(ref.prevLikeForLike)
    const expectedPct =
      ref.prevLikeForLike > 0 && ref.monthToDate > 0
        ? (ref.monthToDate - ref.prevLikeForLike) / ref.prevLikeForLike
        : null
    if (expectedPct === null) expect(a.comparison.changePct).toBeNull()
    else expect(a.comparison.changePct).toBeCloseTo(expectedPct, 12)
    expect(cents(a.todayTotal)).toBe(ref.today)
    expect(a.daily.map((d) => cents(d.total))).toEqual(ref.daily)
    expect(cents(a.budget?.spent ?? 0)).toBe(ref.foodMonth)
  })

  it('past months are whole months whose daily points add up to the hero total', () => {
    for (const [i, offset] of [1, 2, 3].entries()) {
      const a = computeMonthAnalytics(index, {}, today, offset)
      expect(cents(a.periodTotal)).toBe(ref.pastMonths[i])
      expect(a.daily.reduce((s, d) => s + cents(d.total), 0)).toBe(ref.pastMonths[i])
    }
  })

  it('last 7 days equals the Ledger week, and the previous 7 days', () => {
    const w = computeWeekAnalytics(index, today)
    expect(cents(w.thisWeek)).toBe(ref.week)
    expect(cents(w.prevWeek)).toBe(ref.prevWeek)
    const ledgerWeek = sumRange(index, ledgerRange('week', today))
    expect(ledgerWeek.cents).toBe(ref.week)
    expect(rowsInRange(index, ledgerRange('week', today))).toHaveLength(ledgerWeek.count)
  })

  it('year, year-to-date comparison and monthly bars', () => {
    const y = computeYearAnalytics(index, today)
    expect(cents(y.periodTotal)).toBe(ref.year)
    expect(cents(y.comparison.total)).toBe(ref.prevYearLikeForLike)
    expect(y.monthlyTotals.map((m) => cents(m.total))).toEqual(ref.yearMonths)
    if (ref.prevYearLikeForLike > 0 && ref.yearToDate > 0)
      expect(y.comparison.changePct).toBeCloseTo(
        (ref.yearToDate - ref.prevYearLikeForLike) / ref.prevYearLikeForLike,
        12,
      )
  })

  it('Ledger month equals Pulse month, cent for cent', () => {
    const a = computeMonthAnalytics(index, {}, today)
    expect(sumRange(index, ledgerRange('month', today)).cents).toBe(cents(a.periodTotal))
  })
})
