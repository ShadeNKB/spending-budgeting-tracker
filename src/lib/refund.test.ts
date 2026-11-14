import { describe, expect, it } from 'vitest'
import { KIND_REFUND as CORE_REFUND } from '../data/core/constants'
import {
  computeMonthAnalytics,
  computeWeekAnalytics,
  computeYearAnalytics,
  projectedMonthCents,
} from './analytics'
import { expensesToCsv } from './csv'
import { formatMoney } from './format'
import { KIND_REFUND, categoryOf, filedUnder, inSpending, kindOf, shownAmount } from './kind'
import { getLedgerIndex, rowsInRange, signedCents, sumRange } from './ledgerIndex'
import { splitSpending } from './spending'
import {
  filterLedgerRows,
  flattenLedgerGroups,
  groupLedgerRows,
} from '../features/ledger/ledgerFlatten'
import { computeInsights } from '../utils/insights'
import type { Expense, Json } from '../types'

// Refunds (F-058, second slice). A refund keeps its category and its positive amount; the one
// index every screen sums from counts it below zero. These are the sums, the split and the
// figures a negative could bend: shares, budgets, comparisons, projections.

let seq = 0
// Invented data, stored as the app stores it: local noon, no `Z`.
const at = (
  day: string,
  amount: number,
  category: string,
  ext?: Record<string, Json>,
  itemName?: string,
): Expense => {
  seq += 1
  return {
    id: `r${String(seq)}`,
    itemName: itemName ?? `item ${String(seq)}`,
    amount,
    category,
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
    ...(ext === undefined ? {} : { ext }),
  }
}
const refund = (day: string, amount: number, category: string, itemName?: string): Expense =>
  at(day, amount, category, { kind: 'refund' }, itemName)
const income = (day: string, amount: number): Expense =>
  at(day, amount, 'Other', { kind: 'income' })
const fmt = (n: number) => formatMoney(n, {}, 'SGD')
const TODAY = '2026-10-18'

describe('a refund, as a row reads it', () => {
  it('uses the data core’s own word', () => {
    expect(KIND_REFUND).toBe(CORE_REFUND)
  })

  it('is a kind of its own, in the category it comes off, shown with a minus', () => {
    const e = refund('2026-10-12', 20, 'Shopping')
    expect(kindOf(e)).toBe('refund')
    expect(inSpending(kindOf(e))).toBe(true)
    expect(categoryOf(e)).toBe('Shopping')
    expect(filedUnder(e)).toBe('Shopping')
    expect(shownAmount(e, fmt)).toBe('-S$20.00')
    expect(inSpending('income')).toBe(false)
    expect(inSpending('unknown')).toBe(false)
  })
})

describe('the index counts a refund below zero', () => {
  const FOOD = at('2026-10-10', 12.5, 'Food')
  const BACK = refund('2026-10-10', 20, 'Food')
  const LATER = at('2026-10-11', 8, 'Food')
  const index = getLedgerIndex([FOOD, BACK, LATER])

  it('in a row, a day, a range and the whole', () => {
    expect(signedCents(BACK)).toBe(-2000)
    expect(signedCents(FOOD)).toBe(1250)
    expect(index.totalCents).toBe(50)
    expect(index.byDay.get('2026-10-10')).toEqual({ cents: -750, count: 2 })
    expect(sumRange(index, { start: '2026-10-10', end: '2026-10-11' })).toEqual({
      cents: 50,
      count: 3,
    })
  })

  it('and never changes the amount the entry holds', () => {
    expect(BACK.amount).toBe(20)
  })
})

describe('splitSpending with refunds', () => {
  const FOOD = at('2026-10-02', 12.5, 'Food')
  const BACK = refund('2026-10-03', 5, 'Food')
  const INVEST = at('2026-10-04', 300, 'Investment')
  const SOLD = refund('2026-10-05', 40, 'Investment')
  const PAY = income('2026-10-10', 790)

  it('a refund goes where an expense of its category goes, and is no outgoing charge', () => {
    const s = splitSpending([FOOD, BACK, INVEST, SOLD, PAY], ['Investment'])
    expect(s.spending).toEqual([FOOD, BACK])
    expect(s.aside).toEqual([INVEST, SOLD])
    expect(s.income).toEqual([PAY])
    expect(s.outgoing).toEqual([FOOD, INVEST])
    expect(getLedgerIndex(s.spending).totalCents).toBe(750)
    expect(getLedgerIndex(s.aside).totalCents).toBe(26000)
  })

  it('expenses and refunds alone: spending is the array given, outgoing leaves the refunds out', () => {
    const rows = [FOOD, BACK, INVEST]
    const s = splitSpending(rows, [])
    expect(s.spending).toBe(rows)
    expect(s.outgoing).toEqual([FOOD, INVEST])
  })

  it('with income beside them too', () => {
    const s = splitSpending([FOOD, BACK, PAY], [])
    expect(s.spending).toEqual([FOOD, BACK])
    expect(s.outgoing).toEqual([FOOD])
  })
})

describe('a month with refunds', () => {
  const rows = [
    at('2026-10-02', 100, 'Food'),
    at('2026-10-05', 80, 'Shopping', undefined, 'Shoes'),
    refund('2026-10-10', 30, 'Shopping', 'Shoes'),
  ]
  const month = computeMonthAnalytics(getLedgerIndex(rows), { Shopping: 100 }, TODAY)

  it('totals are net, and what the refunds took off is said beside them', () => {
    expect(month.periodTotal).toBe(150)
    expect(month.periodRefunded).toBe(30)
    expect(month.periodCount).toBe(3)
    expect(month.dailyAverage).toBeCloseTo(150 / 18, 10)
  })

  it('a category is its spending less its refunds; shares still add up to the whole', () => {
    expect(month.topCategories).toEqual([
      { category: 'Food', total: 100, share: 100 / 150 },
      { category: 'Shopping', total: 50, share: 50 / 150 },
    ])
  })

  it('a budget measures the net: the refund gives its room back', () => {
    expect(month.categoryBudgets).toEqual([
      expect.objectContaining({ category: 'Shopping', total: 50, used: 0.5, left: 50 }),
    ])
    expect(month.budget).toMatchObject({ spent: 50, used: 0.5, left: 50, unbudgeted: 100 })
  })

  it('the largest entry is never a refund, whatever its size', () => {
    const big = [
      at('2026-10-02', 10, 'Food', undefined, 'Lunch'),
      refund('2026-10-03', 500, 'Food'),
    ]
    expect(computeMonthAnalytics(getLedgerIndex(big), {}, TODAY).biggest?.itemName).toBe('Lunch')
    const none = [refund('2026-10-03', 500, 'Food')]
    expect(computeMonthAnalytics(getLedgerIndex(none), {}, TODAY).biggest).toBeNull()
  })

  it('a day whose refunds pass its spending is a point below zero, and no busiest day', () => {
    const day = month.daily.find((d) => d.date === '2026-10-10')
    expect(day?.total).toBe(-30)
    expect(month.heatmap.days.find((d) => d.date === '2026-10-10')?.total).toBe(-30)
  })
})

describe('refunds past the spending they come off', () => {
  const rows = [
    at('2026-10-02', 100, 'Food'),
    at('2026-10-05', 20, 'Shopping'),
    refund('2026-10-10', 50, 'Shopping'),
  ]
  const index = getLedgerIndex(rows)

  it('the category is not listed, and the others do not pass 100% between them', () => {
    const month = computeMonthAnalytics(index, {}, TODAY)
    expect(month.periodTotal).toBe(70)
    expect(month.topCategories).toEqual([{ category: 'Food', total: 100, share: 1 }])
  })

  it('its budget reads 0% used, never less, with the money back as room', () => {
    const [shopping] = computeMonthAnalytics(index, { Shopping: 100 }, TODAY).categoryBudgets
    expect(shopping).toMatchObject({ total: -30, used: 0, left: 130, status: 'onTrack' })
    const whole = computeMonthAnalytics(
      getLedgerIndex([refund('2026-10-10', 50, 'Food')]),
      {},
      TODAY,
      0,
      200,
    )
    expect(whole.budget).toMatchObject({ spent: -50, used: 0, left: 250, status: 'onTrack' })
  })

  it('a finished month below zero is 100% less than the one before, not more than all of it', () => {
    const past = [
      at('2026-08-10', 100, 'Food'),
      at('2026-09-05', 10, 'Food'),
      refund('2026-09-20', 40, 'Food'),
    ]
    const september = computeMonthAnalytics(getLedgerIndex(past), {}, TODAY, 1)
    expect(september.periodTotal).toBe(-30)
    expect(september.comparison.changePct).toBe(-1)
  })

  it('the last 7 days below zero: the same floor', () => {
    const week = [
      at('2026-10-08', 100, 'Food'),
      at('2026-10-15', 10, 'Food'),
      refund('2026-10-16', 60, 'Food'),
    ]
    const w = computeWeekAnalytics(getLedgerIndex(week), TODAY)
    expect(w.thisWeek).toBe(-50)
    expect(w.changePct).toBe(-1)
    const insights = computeInsights(getLedgerIndex(week), {}, TODAY, fmt)
    expect(insights[0]).toMatchObject({
      id: 'trend-Food',
      title: 'Food down 100% in the last 7 days',
      detail: 'vs the previous 7 days (S$150.00 less)',
    })
  })
})

describe('the month-end projection with refunds', () => {
  it('money back named like a monthly charge is not a charge paid this month', () => {
    const rows = [
      at('2026-08-03', 50, 'Health', undefined, 'Gym'),
      at('2026-09-03', 50, 'Health', undefined, 'Gym'),
      // October: the gym gave September's fee back, and no fee was paid
      refund('2026-10-03', 50, 'Health', 'Gym'),
      at('2026-10-05', 100, 'Food'),
    ]
    // 50 net over 10 days of 31, at the daily rate: nothing held out as paid for the month
    expect(projectedMonthCents(getLedgerIndex(rows), '2026-10-10')).toBe(15500)
  })
})

describe('a year with refunds', () => {
  it('months and the total are net; the refunds are summed beside them', () => {
    const rows = [
      at('2026-03-02', 100, 'Food'),
      refund('2026-03-09', 25, 'Food'),
      at('2026-05-02', 40, 'Food'),
      refund('2026-06-01', 10, 'Food'),
    ]
    const year = computeYearAnalytics(getLedgerIndex(rows), TODAY)
    expect(year.periodTotal).toBe(105)
    expect(year.periodRefunded).toBe(35)
    expect(year.monthlyTotals[2]?.total).toBe(75)
    expect(year.monthlyTotals[5]?.total).toBe(-10)
    expect(year.highestMonth?.month).toBe(2)
    expect(year.topCategories).toEqual([{ category: 'Food', total: 105, share: 1 }])
  })
})

describe('the Ledger with refunds', () => {
  const FOOD = at('2026-10-10', 12.5, 'Food', undefined, 'Lunch')
  const BACK = refund('2026-10-10', 20, 'Food', 'Dinner split')
  const PAY = income('2026-10-09', 790)
  const ALONE = refund('2026-10-08', 5, 'Shopping', 'Returned cable')
  const EVEN_OUT = at('2026-10-07', 9, 'Food')
  const EVEN_BACK = refund('2026-10-07', 9, 'Food')
  const index = getLedgerIndex([FOOD, BACK, PAY, ALONE, EVEN_OUT, EVEN_BACK])
  const rows = rowsInRange(index, null)

  it('a day’s figure is its spending less its refunds, and its rows add up to it', () => {
    const groups = groupLedgerRows(index, rows, TODAY)
    expect(groups.map((g) => [g.key, g.total, g.counted])).toEqual([
      ['2026-10-10', -7.5, 2],
      // income only: nothing to sum, so no figure is shown
      ['2026-10-09', 0, 0],
      ['2026-10-08', -5, 1],
      // an expense and its refund: a real S$0.00
      ['2026-10-07', 0, 2],
    ])
    const headers = flattenLedgerGroups(groups).filter((i) => i.kind === 'header')
    expect(headers.map((h) => h.counted)).toEqual([2, 0, 1, 2])
  })

  it('a refund in a not-spending category is listed and left out of the day’s sum', () => {
    const [day] = groupLedgerRows(index, rows, TODAY, new Set(['Food']))
    expect(day).toMatchObject({ total: 0, counted: 0 })
  })

  it('a category lists its refunds with its expenses', () => {
    const names = filterLedgerRows(index, rows, { category: 'Food', search: '' }).map(
      (r) => index.expenses[r]?.itemName,
    )
    expect(new Set(names)).toEqual(
      new Set(['Dinner split', 'Lunch', EVEN_BACK.itemName, EVEN_OUT.itemName]),
    )
    expect(names).toHaveLength(4)
    expect(
      filterLedgerRows(index, rows, { category: 'all', search: 'shopping' }).map(
        (r) => index.expenses[r]?.itemName,
      ),
    ).toEqual(['Returned cable'])
  })
})

describe('the CSV export with refunds', () => {
  it('a refund keeps its category and a positive amount; the Type column says what it is', () => {
    const csv = expensesToCsv([
      { ...at('2026-10-02', 89.9, 'Shopping'), itemName: 'Shoes' },
      refund('2026-10-12', 89.9, 'Shopping', 'Returned shoes'),
    ])
    expect(csv).toBe(
      '﻿Date,Item,Category,Amount,Notes,Type\r\n' +
        '"2026-10-02","Shoes","Shopping","89.9","","expense"\r\n' +
        '"2026-10-12","Returned shoes","Shopping","89.9","","refund"\r\n',
    )
  })
})
