import { describe, expect, it } from 'vitest'
import { format } from 'date-fns'
import {
  computeMonthAnalytics,
  computeTrailingDaily,
  computeWeekAnalytics,
  computeYearAnalytics,
} from './analytics'
import { todayKey } from './dates'
import { getLedgerIndex } from './ledgerIndex'
import { computeInsights } from '../utils/insights'
import type { Expense } from '../types'

/**
 * AC-P1 guard. Locally the cold recompute (fresh index + every Pulse/Insights figure) for
 * 5,000 rows has a median well under 16 ms; the committed bound leaves room for slow CI.
 */
const GUARD_MS = 50

function fixture(): Expense[] {
  const rows: Expense[] = []
  const start = new Date(2023, 9, 19, 12).getTime()
  const categories = ['Food & Dining', 'Transportation', 'Shopping', 'Subscriptions', 'Other']
  for (let i = 0; i < 5000; i++) {
    const when = new Date(start + ((i * 7919) % (3 * 365)) * 86_400_000 + (i % 13) * 3_600_000)
    const form = i % 3
    rows.push({
      id: `p${String(i)}`,
      itemName: `merchant ${String(i % 2000)}`,
      amount: 1 + ((i * 37) % 9000) / 100,
      category: categories[i % categories.length] ?? 'Other',
      date:
        form === 0
          ? format(when, "yyyy-MM-dd'T'12:00:00")
          : form === 1
            ? when.toISOString()
            : format(when, 'yyyy-MM-dd'),
      createdAt: when.toISOString(),
    })
  }
  // The store keeps rows newest first (adds are prepended), so measure that order.
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

describe('analytics performance', () => {
  it(`recomputes every figure for 5,000 rows from a cold index in < ${String(GUARD_MS)} ms (median)`, () => {
    const rows = fixture()
    const today = todayKey(new Date(2026, 9, 18, 9))
    const budgets = { 'Food & Dining': 400, Transportation: 150 }
    const fmt = (n: number) => n.toFixed(2)
    const once = () => {
      const index = getLedgerIndex([...rows]) // new identity → index rebuilt
      computeMonthAnalytics(index, budgets, today)
      computeYearAnalytics(index, today)
      computeWeekAnalytics(index, today)
      computeTrailingDaily(index, today, 30)
      computeInsights(index, budgets, today, fmt)
    }
    for (let i = 0; i < 3; i++) once()
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      once()
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const median = samples[10] ?? Number.POSITIVE_INFINITY
    expect(median).toBeLessThan(GUARD_MS)
  })
})
