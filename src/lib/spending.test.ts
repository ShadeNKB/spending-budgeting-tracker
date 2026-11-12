import { describe, expect, it } from 'vitest'
import { computeMonthAnalytics, computeYearAnalytics } from './analytics'
import { monthRange } from './dates'
import { getLedgerIndex, sumRange } from './ledgerIndex'
import { spendingBudgets, splitSpending } from './spending'
import type { CategoryBudgets, Expense } from '../types'

let seq = 0
// Invented data, stored as the app stores it: local noon, no `Z`.
const at = (day: string, amount: number, category: string): Expense => {
  seq += 1
  return {
    id: `s${String(seq)}`,
    itemName: `item ${String(seq)}`,
    amount,
    category,
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
  }
}

const ROWS: readonly Expense[] = [
  at('2026-10-02', 12.5, 'Food'),
  at('2026-10-03', 300, 'Investment'),
  at('2026-10-05', 40, 'Transport'),
  at('2026-10-09', 150, 'Savings'),
  at('2026-09-20', 80, 'Food'),
  at('2026-09-21', 300, 'Investment'),
]

describe('splitSpending', () => {
  it('with no not-spending category, spending is the very array it was given', () => {
    const split = splitSpending(ROWS, [])
    expect(split.spending).toBe(ROWS)
    expect(split.aside).toEqual([])
  })

  it('moves the entries of not-spending categories out, keeping the order of both', () => {
    const split = splitSpending(ROWS, ['Investment', 'Savings'])
    expect(split.spending.map((e) => e.category)).toEqual(['Food', 'Transport', 'Food'])
    expect(split.aside.map((e) => e.amount)).toEqual([300, 150, 300])
    // every entry is in exactly one of the two
    expect(split.spending.length + split.aside.length).toBe(ROWS.length)
  })

  it('a not-spending category with no entries leaves the array, and its index, as they were', () => {
    const split = splitSpending(ROWS, ['Crypto'])
    expect(split.spending).toBe(ROWS)
    expect(getLedgerIndex(split.spending)).toBe(getLedgerIndex(ROWS))
  })

  it('gives the same arrays for the same two inputs, so the index over them is built once', () => {
    const names = ['Investment']
    const a = splitSpending(ROWS, names)
    const b = splitSpending(ROWS, names)
    expect(b.spending).toBe(a.spending)
    expect(b.aside).toBe(a.aside)
    expect(getLedgerIndex(b.spending)).toBe(getLedgerIndex(a.spending))
    // another list of names is another answer
    expect(splitSpending(ROWS, ['Savings']).aside.map((e) => e.amount)).toEqual([150])
  })

  it('a category named like an Object key is a name like any other', () => {
    const rows = [at('2026-10-02', 5, 'constructor'), at('2026-10-02', 7, '__proto__')]
    expect(splitSpending(rows, ['constructor']).aside.map((e) => e.amount)).toEqual([5])
    expect(splitSpending(rows, ['__proto__']).aside.map((e) => e.amount)).toEqual([7])
  })
})

describe('spendingBudgets', () => {
  const budgets: CategoryBudgets = { Food: 400, Investment: 500 }

  it('drops the cap of a not-spending category, and nothing else', () => {
    expect({ ...spendingBudgets(budgets, ['Investment']) }).toEqual({ Food: 400 })
  })

  it('is the same object when it loses none, and for the same two inputs', () => {
    expect(spendingBudgets(budgets, [])).toBe(budgets)
    expect(spendingBudgets(budgets, ['Savings'])).toBe(budgets)
    const names = ['Investment']
    expect(spendingBudgets(budgets, names)).toBe(spendingBudgets(budgets, names))
  })

  it('never reads a prototype value as a cap', () => {
    const out = spendingBudgets(budgets, ['Investment'])
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(Object.hasOwn(out, 'constructor')).toBe(false)
  })
})

describe('the figures over spending only (F-057)', () => {
  const names = ['Investment', 'Savings']
  const { spending, aside } = splitSpending(ROWS, names)
  const today = '2026-10-18'

  it('the month total, its comparison and its categories leave not-spending entries out', () => {
    const all = computeMonthAnalytics(getLedgerIndex(ROWS), {}, today)
    const a = computeMonthAnalytics(getLedgerIndex(spending), {}, today)
    expect(all.periodTotal).toBe(502.5)
    expect(a.periodTotal).toBe(52.5)
    expect(a.periodCount).toBe(2)
    // September to the 18th had nothing; the whole-month figure it compares with is spending too
    expect(a.topCategories.map((c) => c.category)).toEqual(['Transport', 'Food'])
    expect(a.topCategories.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 10)
  })

  it('what was not spending is summed on its own, and the two account for every cent', () => {
    const range = monthRange('2026-10')
    const spent = sumRange(getLedgerIndex(spending), range).cents
    const moved = sumRange(getLedgerIndex(aside), range).cents
    expect(moved).toBe(45_000)
    expect(spent + moved).toBe(sumRange(getLedgerIndex(ROWS), range).cents)
  })

  it('the year leaves them out too', () => {
    const y = computeYearAnalytics(getLedgerIndex(spending), today)
    expect(y.periodTotal).toBe(132.5)
    expect(y.topCategories.map((c) => c.category)).toEqual(['Food', 'Transport'])
  })

  it('a cap on a not-spending category measures nothing, and its row is gone', () => {
    const budgets = spendingBudgets({ Food: 100, Investment: 200 }, names)
    const a = computeMonthAnalytics(getLedgerIndex(spending), budgets, today)
    expect(a.categoryBudgets.map((b) => b.category)).toEqual(['Food'])
    expect(a.budget).toMatchObject({ cap: 100, spent: 12.5, unbudgeted: 40 })
  })
})
