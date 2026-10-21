import { describe, expect, it } from 'vitest'
import {
  colorFromString,
  computeMonthAnalytics,
  computeTrailingDaily,
  computeWeekAnalytics,
  computeYearAnalytics,
  projectedMonthCents,
} from './analytics'
import { addDays, daysInMonth, enumerateDays, monthRange } from './dates'
import { getLedgerIndex } from './ledgerIndex'
import type { Expense } from '../types'

let seq = 0
/** Fixtures follow the app's storage convention: local noon, no `Z`. */
const at = (
  day: string,
  amount: number,
  category = 'Food & Dining',
  time = '12:00:00',
): Expense => {
  seq += 1
  return {
    id: `e${String(seq)}`,
    itemName: `item ${String(seq)}`,
    amount,
    category,
    date: `${day}T${time}`,
    createdAt: `${day}T${time}`,
  }
}
const index = (rows: Expense[]) => getLedgerIndex(rows)
const cents = (n: number) => Math.round(n * 100)

describe('colorFromString', () => {
  it('returns a stable color for the same input', () => {
    expect(colorFromString('Food')).toBe(colorFromString('Food'))
  })

  it('returns a fallback for empty input', () => {
    expect(colorFromString('')).toBe('#5A6478')
  })

  it('produces an hsl() value', () => {
    expect(colorFromString('Transport')).toMatch(/^hsl\(\d+, 65%, 62%\)$/)
  })
})

describe('computeMonthAnalytics — current month', () => {
  it('sums the month and today, and compares month-to-date like for like', () => {
    const a = computeMonthAnalytics(
      index([
        at('2026-05-15', 10), // today
        at('2026-05-10', 20),
        at('2026-04-20', 30), // after Apr 15: outside the like-for-like window
        at('2026-04-10', 15),
        at('2026-03-01', 40),
      ]),
      {},
      '2026-05-15',
    )
    expect(a.periodTotal).toBe(30)
    expect(a.periodCount).toBe(2)
    expect(a.todayTotal).toBe(10)
    expect(a.todayCount).toBe(1)
    expect(a.todayEntries.map((e) => e.amount)).toEqual([10])
    expect(a.label).toBe('May 2026')
    expect(a.isCurrent).toBe(true)
    expect(a.comparison).toMatchObject({ total: 15, changePct: 1, label: 'vs Apr 1–15' })
  })

  it('AC-2: Oct 1–18 = 708.80 vs Sep 1–18 = 502.67 reads +41.0% (not −29% vs all of Sep)', () => {
    const rows = [
      at('2026-09-03', 300),
      at('2026-09-18', 202.67, 'Transport', '23:30:00'),
      at('2026-09-19', 400), // after the like-for-like window
      at('2026-09-30', 95.2),
      at('2026-10-01', 400),
      at('2026-10-18', 308.8, 'Shopping', '09:00:00'),
    ]
    const a = computeMonthAnalytics(index(rows), {}, '2026-10-18')
    expect(a.periodTotal).toBeCloseTo(708.8, 10)
    expect(a.comparison.total).toBeCloseTo(502.67, 10)
    expect(a.comparison.label).toBe('vs Sep 1–18')
    expect((a.comparison.changePct ?? 0) * 100).toBeCloseTo(41.0, 1)
    const past = computeMonthAnalytics(index(rows), {}, '2026-10-18', 1)
    expect(past.periodTotal).toBeCloseTo(997.87, 10)
  })

  it('labels a clamped comparison by the whole previous month', () => {
    const a = computeMonthAnalytics(
      index([at('2026-02-10', 50), at('2026-03-30', 60)]),
      {},
      '2026-03-30',
    )
    expect(a.comparison).toEqual({
      total: 50,
      changePct: 0.2,
      against: 'February',
      label: 'vs February',
    })
  })

  it('has no comparison when the previous window is empty', () => {
    const a = computeMonthAnalytics(index([at('2026-10-02', 5)]), {}, '2026-10-18')
    expect(a.comparison.changePct).toBeNull()
  })

  it('has no comparison before anything is logged this period (not "down 100%" on the 1st)', () => {
    const rows = [at('2026-10-01', 9), at('2026-10-31', 40)]
    const nov1 = computeMonthAnalytics(index(rows), {}, '2026-11-01')
    expect(nov1.comparison).toMatchObject({ total: 9, changePct: null, label: 'vs Oct 1' })
    const jan1 = computeYearAnalytics(index(rows), '2027-01-01')
    expect(jan1.comparison).toMatchObject({ total: 0, changePct: null })
    const withRow = computeMonthAnalytics(index([...rows, at('2026-11-01', 3)]), {}, '2026-11-01')
    expect(withRow.comparison.changePct).toBeCloseTo(-6 / 9, 10)
    // A finished month that had nothing is a real 100% drop.
    const past = computeMonthAnalytics(index(rows), {}, '2026-12-05', 1)
    expect(past.comparison.changePct).toBe(-1)
  })

  it('counts days left including today, and averages over elapsed days', () => {
    const rows = [at('2026-10-02', 36)]
    const mid = computeMonthAnalytics(index(rows), {}, '2026-10-18')
    expect(mid.daysLeft).toBe(14)
    expect(mid.daysElapsed).toBe(18)
    expect(mid.daysInPeriod).toBe(31)
    expect(mid.dailyAverage).toBe(2)
    expect(computeMonthAnalytics(index(rows), {}, '2026-10-31').daysLeft).toBe(1)
  })

  it('counts future-dated rows in the month but not in the month-to-date comparison', () => {
    const a = computeMonthAnalytics(
      index([at('2026-10-05', 10), at('2026-10-25', 90), at('2026-09-05', 10)]),
      {},
      '2026-10-18',
    )
    expect(a.periodTotal).toBe(100)
    expect(a.comparison.changePct).toBe(0)
  })

  it('ranks top categories by amount with shares, prototype-like names included', () => {
    const a = computeMonthAnalytics(
      index([
        at('2026-05-01', 100, 'Food'),
        at('2026-05-02', 50, 'constructor'),
        at('2026-05-03', 50, 'Food'),
        at('2026-05-03', 25, '__proto__'),
      ]),
      {},
      '2026-05-15',
    )
    expect(a.topCategories.map((c) => c.category)).toEqual(['Food', 'constructor', '__proto__'])
    expect(a.topCategories[0]?.total).toBe(150)
    expect(a.topCategories[0]?.share).toBeCloseTo(150 / 225, 10)
  })

  it('builds a trailing 30-day series and a 14-week heatmap ending today', () => {
    const a = computeMonthAnalytics(
      index([at('2026-10-18', 7), at('2026-09-19', 3), at('2026-09-18', 99)]),
      {},
      '2026-10-18',
    )
    expect(a.daily).toHaveLength(30)
    expect(a.daily[0]).toEqual({ date: '2026-09-19', total: 3 })
    expect(a.daily.at(-1)).toEqual({ date: '2026-10-18', total: 7 })
    expect(a.heatmap.end).toBe('2026-10-18')
    // 13 weeks back is Sun Jul 19 itself: 13 full weeks plus today's (partial) week.
    expect(a.heatmap.start).toBe('2026-07-19')
    expect(a.heatmap.days).toHaveLength(92)
    expect(a.heatmap.days.at(-1)?.date).toBe('2026-10-18')
    expect(a.heatmap.days[0]?.date).toBe('2026-07-19')
    const sat = computeMonthAnalytics(index([]), {}, '2026-10-17')
    expect(sat.heatmap.start).toBe('2026-07-12')
    expect(sat.heatmap.days).toHaveLength(98)
  })

  it('returns zeros, no comparison and no budget for an empty ledger', () => {
    const a = computeMonthAnalytics(index([]), {}, '2026-10-18')
    expect(a.periodTotal).toBe(0)
    expect(a.comparison.changePct).toBeNull()
    expect(a.budget).toBeNull()
    expect(a.categoryBudgets).toEqual([])
    expect(a.daily.every((d) => d.total === 0)).toBe(true)
  })
})

describe('computeMonthAnalytics — budgets', () => {
  it('AC-5: measures only budgeted categories against their caps', () => {
    const a = computeMonthAnalytics(
      index([at('2026-10-03', 9, 'Food'), at('2026-10-04', 400, 'Investment')]),
      { Food: 300 },
      '2026-10-18',
    )
    expect(a.budget).toMatchObject({
      cap: 300,
      spent: 9,
      used: 0.03,
      left: 291,
      status: 'onTrack',
      unbudgeted: 400,
      isFinal: false,
    })
    expect(a.budget?.expected).toBeCloseTo(18 / 31, 10)
    expect(a.budget?.perDay).toBeCloseTo(291 / 14, 10)
  })

  it('AC-6: a day-1 purchase at 00:05 is neither over nor projected', () => {
    const a = computeMonthAnalytics(
      index([at('2026-10-01', 20.84, 'Transport', '00:03:00')]),
      { Transport: 100 },
      '2026-10-01',
    )
    expect(a.categoryBudgets[0]).toMatchObject({ status: 'onTrack', projected: null })
    expect(a.budget?.status).toBe('onTrack')
  })

  it('flags "ahead" from day 5 when the run rate would pass the cap, and "over" past it', () => {
    const ahead = computeMonthAnalytics(
      index([at('2026-10-02', 30, 'Transport')]),
      { Transport: 100 },
      '2026-10-05',
    )
    expect(ahead.categoryBudgets[0]?.status).toBe('ahead')
    expect(ahead.categoryBudgets[0]?.projected).toBeCloseTo(186, 10)
    const day4 = computeMonthAnalytics(
      index([at('2026-10-02', 30, 'Transport')]),
      { Transport: 100 },
      '2026-10-04',
    )
    expect(day4.categoryBudgets[0]?.status).toBe('onTrack')
    const over = computeMonthAnalytics(
      index([at('2026-10-02', 120, 'Transport'), at('2026-10-02', 1, 'Food')]),
      { Transport: 100, Food: 200 },
      '2026-10-18',
    )
    expect(over.categoryBudgets.map((c) => [c.category, c.status])).toEqual([
      ['Transport', 'over'],
      ['Food', 'onTrack'],
    ])
    expect(over.categoryBudgets[0]?.left).toBe(0)
  })

  /** A row with a real item name (the default fixture names every row uniquely). */
  const named = (day: string, itemName: string, amount: number, category: string): Expense => ({
    ...at(day, amount, category),
    itemName,
  })

  it('does not project a monthly charge already paid (Spotify on the 1st, Netflix on the 12th)', () => {
    const rows = ['08', '09', '10'].flatMap((m) => [
      named(`2026-${m}-01`, 'Spotify', 9.99, 'Subscriptions'),
      named(`2026-${m}-12`, 'netflix ', 15.98, 'Subscriptions'),
    ])
    const a = computeMonthAnalytics(index(rows), { Subscriptions: 30 }, '2026-10-19')
    expect(a.categoryBudgets[0]).toMatchObject({ status: 'onTrack', projected: null })
    expect(a.budget).toMatchObject({ status: 'onTrack', projected: null })
  })

  it('projects only the variable part of a category at the daily run rate', () => {
    const pass = ['08', '09', '10'].map((m) => named(`2026-${m}-03`, 'MRT pass', 64, 'Transport'))
    const rides = [
      named('2026-10-05', 'grab', 10, 'Transport'),
      named('2026-10-09', 'grab', 10, 'Transport'),
    ]
    const a = computeMonthAnalytics(index([...pass, ...rides]), { Transport: 120 }, '2026-10-10')
    // 64 paid once + 20 over 10 days × 31 = 126 (the old run rate said 260.40).
    expect(a.categoryBudgets[0]?.status).toBe('ahead')
    expect(a.categoryBudgets[0]?.projected).toBeCloseTo(126, 10)
    expect(a.budget?.projected).toBeCloseTo(126, 10)
  })

  it('treats a name seen more than once a month, or not in each of the two months before, as variable', () => {
    const rows = [
      named('2026-08-02', 'kopi', 2, 'Food'),
      named('2026-09-02', 'kopi', 2, 'Food'),
      named('2026-10-02', 'kopi', 20, 'Food'),
      named('2026-10-04', 'kopi', 20, 'Food'), // twice this month
      named('2026-09-03', 'haircut', 40, 'Food'),
      named('2026-10-03', 'haircut', 40, 'Food'), // only one month before
    ]
    const a = computeMonthAnalytics(index(rows), { Food: 150 }, '2026-10-10')
    expect(a.categoryBudgets[0]?.projected).toBeCloseTo((80 / 10) * 31, 10)
  })

  it('projects the whole month from month to date by the same rule (Insights pace)', () => {
    const rent = ['08', '09', '10'].map((m) => named(`2026-${m}-01`, 'rent', 1200, 'Bills'))
    const lunches = ['01', '03', '05'].map((d) => named(`2026-10-${d}`, 'lunch', 20, 'Food'))
    // 1,200 paid once + 60 over 5 days × 31 = 1,572.
    expect(projectedMonthCents(index([...rent, ...lunches]), '2026-10-05')).toBe(157_200)
    // A charge logged ahead of time (Oct 28, today Oct 18) is neither to date nor paid.
    const early = [
      ...['08', '09', '10'].map((m) => named(`2026-${m}-28`, 'rent', 1200, 'Bills')),
      named('2026-10-09', 'lunch', 36, 'Food'),
    ]
    expect(projectedMonthCents(index(early), '2026-10-18')).toBe(6200) // 36 / 18 × 31
    expect(projectedMonthCents(index([]), '2026-10-18')).toBe(0)
  })

  it('ignores zero, sub-cent, negative and non-finite caps and inherited keys', () => {
    const a = computeMonthAnalytics(
      index([at('2026-10-02', 10, 'Food'), at('2026-10-03', 2, 'Health')]),
      { Food: 0, Transport: -5, Shopping: Number.NaN, Health: 0.004 },
      '2026-10-18',
    )
    expect(a.budget).toBeNull()
    expect(a.categoryBudgets).toEqual([])
  })
})

describe('computeMonthAnalytics — past month (final state)', () => {
  const rows = [
    at('2026-09-01', 10),
    at('2026-09-15', 20, 'Transport'),
    at('2026-09-30', 30, 'Food & Dining', '23:59:00'),
    at('2026-08-31', 5),
    at('2026-10-18', 999), // today: never on a past month
  ]

  it('AC-7: full month vs full previous month, no today, every day of the month', () => {
    const a = computeMonthAnalytics(index(rows), { Transport: 15 }, '2026-10-18', 1)
    expect(a.isCurrent).toBe(false)
    expect(a.label).toBe('September 2026')
    expect(a.periodTotal).toBe(60)
    expect(a.comparison).toMatchObject({ total: 5, changePct: 11, label: 'vs August' })
    expect(a.todayEntries).toEqual([])
    expect(a.todayTotal).toBe(0)
    expect(a.daysLeft).toBeNull()
    expect(a.daysElapsed).toBe(30)
    expect(a.dailyAverage).toBe(2)
    expect(a.daily.map((d) => d.date)).toEqual(enumerateDays(monthRange('2026-09')))
    expect(cents(a.daily.reduce((s, d) => s + d.total, 0))).toBe(cents(a.periodTotal))
    expect(a.heatmap.end).toBe('2026-09-30')
    expect(a.budget).toMatchObject({ isFinal: true, status: 'over', spent: 20, perDay: null })
    expect(a.categoryBudgets[0]).toMatchObject({ status: 'over', projected: null })
  })

  it('treats offsets as whole months back across a year boundary', () => {
    const a = computeMonthAnalytics(index([at('2025-12-05', 4)]), {}, '2026-01-02', 1)
    expect(a.label).toBe('December 2025')
    expect(a.periodTotal).toBe(4)
    expect(a.comparison.label).toBe('vs November')
  })
})

describe('computeYearAnalytics', () => {
  /** S$1,000 per month spread evenly over each month's days, up to today. */
  function evenYear(year: number, today: string): Expense[] {
    const out: Expense[] = []
    for (let m = 1; m <= 12; m++) {
      const dim = daysInMonth(year, m)
      for (let d = 1; d <= dim; d++) {
        const day = `${String(year)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        if (day > today) continue
        out.push(at(day, 1000 / dim))
      }
    }
    return out
  }

  it('AC-4: one monthly average that counts the current month as partial', () => {
    const y = computeYearAnalytics(index(evenYear(2026, '2026-10-18')), '2026-10-18')
    expect(y.monthsElapsed).toBeCloseTo(9 + 18 / 31, 10)
    expect(Math.abs(y.monthlyAverage - 1000)).toBeLessThanOrEqual(0.5)
  })

  it('never divides by less than one month (1 Jan: the average is what was spent)', () => {
    const y = computeYearAnalytics(index([at('2027-01-01', 100)]), '2027-01-01')
    expect(y.monthsElapsed).toBeCloseTo(1 / 31, 10)
    expect(y.monthlyAverage).toBe(100)
    const feb = computeYearAnalytics(index([at('2027-01-10', 310)]), '2027-02-14')
    expect(feb.monthlyAverage).toBeCloseTo(310 / (1 + 14 / 28), 10)
  })

  it('divides a past year by 12 and styles no month as current or future', () => {
    const y = computeYearAnalytics(index(evenYear(2025, '2025-12-31')), '2026-10-18', 1)
    expect(y.isCurrent).toBe(false)
    expect(y.monthsElapsed).toBe(12)
    expect(Math.abs(y.monthlyAverage - 1000)).toBeLessThanOrEqual(0.5)
    expect(y.monthlyTotals.every((m) => m.state === 'past')).toBe(true)
    expect(y.sparkline.labels).toEqual([
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
    ])
    expect(y.comparison.label).toBe('vs 2024')
    expect(y.heatmap.end).toBe('2025-12-31')
  })

  it('names the earlier month as the highest when two months tie', () => {
    const y = computeYearAnalytics(
      index([at('2026-03-10', 250), at('2026-07-02', 250), at('2026-05-02', 100)]),
      '2026-10-18',
    )
    expect(y.highestMonth).toMatchObject({ label: 'Mar', total: 250 })
  })

  it('marks past / current / future months and plots the current year to this month only', () => {
    const y = computeYearAnalytics(
      index([at('2026-09-10', 997.87), at('2026-10-02', 5), at('2025-03-02', 100)]),
      '2026-10-18',
    )
    expect(y.monthlyTotals.map((m) => m.state).join('')).toBe(
      ['past', 'past', 'past', 'past', 'past', 'past', 'past', 'past', 'past', 'current']
        .concat(['future', 'future'])
        .join(''),
    )
    expect(y.sparkline.values).toHaveLength(10)
    expect(y.sparkline.labels.at(-1)).toBe('Oct')
    expect(y.highestMonth).toMatchObject({ label: 'Sep', total: 997.87 })
    expect(y.comparison.total).toBe(100)
    expect(y.comparison.changePct).toBeCloseTo(9.0287, 10)
    expect(y.comparison.label).toBe('vs 2025 to Oct 18')
    expect(y.heatmap.end).toBe('2026-10-18')
  })
})

describe('computeWeekAnalytics', () => {
  it('totals the last 7 days vs the previous 7 by calendar day', () => {
    const w = computeWeekAnalytics(
      index([
        at('2026-05-15', 1, 'Food', '00:01:00'), // today, just after midnight
        at('2026-05-14', 30),
        at('2026-05-09', 10), // day 7 of 7
        at('2026-05-08', 50), // previous window
        at('2026-05-02', 7), // previous window, its first day
        at('2026-05-01', 1000), // outside both
      ]),
      '2026-05-15',
    )
    expect(w.thisWeek).toBe(41)
    expect(w.prevWeek).toBe(57)
    expect(w.range).toEqual({ start: '2026-05-09', end: '2026-05-15' })
    expect(w.label).toBe('Last 7 days · May 9 – May 15')
    expect(w.dailyThisWeek.map((d) => d.label)).toEqual([
      'Sat',
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
    ])
    expect(w.changePct).toBeCloseTo((41 - 57) / 57, 10)
    expect(w.dailyThisWeek.map((d) => [d.date, d.total])).toEqual([
      ['2026-05-09', 10],
      ['2026-05-10', 0],
      ['2026-05-11', 0],
      ['2026-05-12', 0],
      ['2026-05-13', 0],
      ['2026-05-14', 30],
      ['2026-05-15', 1],
    ])
  })

  it('has no change when the previous window is empty', () => {
    expect(computeWeekAnalytics(index([at('2026-05-15', 3)]), '2026-05-15').changePct).toBeNull()
  })
})

describe('computeTrailingDaily', () => {
  it('returns one point per day ending at the given day', () => {
    const series = computeTrailingDaily(index([at('2026-03-01', 4)]), '2026-03-02', 3)
    expect(series).toEqual([
      { date: addDays('2026-03-02', -2), total: 0 },
      { date: '2026-03-01', total: 4 },
      { date: '2026-03-02', total: 0 },
    ])
  })
})
