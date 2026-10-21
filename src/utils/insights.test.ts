import { describe, expect, it } from 'vitest'
import { computeInsights } from './insights'
import { getLedgerIndex } from '../lib/ledgerIndex'
import type { Expense } from '../types'

let seq = 0
const at = (day: string, amount: number, category = 'Food', time = '12:00:00'): Expense => {
  seq += 1
  return {
    id: `i${String(seq)}`,
    itemName: `thing ${String(seq)}`,
    amount,
    category,
    date: `${day}T${time}`,
    createdAt: `${day}T${time}`,
  }
}

/** A marker formatter: proves every amount in the copy goes through the money formatter. */
const fmt = (n: number) => `<${n.toFixed(2)}>`
const run = (rows: Expense[], budgets: Record<string, number>, today: string) =>
  computeInsights(getLedgerIndex(rows), budgets, today, fmt)

describe('computeInsights', () => {
  it('AC-3: last month includes its final day (Sep 30), so the pace reads lower', () => {
    const insights = run(
      [at('2026-09-10', 50), at('2026-09-30', 100, 'Food', '23:30:00'), at('2026-10-05', 60)],
      {},
      '2026-10-18',
    )
    const pace = insights.find((i) => i.id === 'month-pace')
    expect(pace).toMatchObject({
      tone: 'good',
      title: 'Pacing 31% lower than last month',
      detail: 'Projected <103.33> · September <150.00>',
    })
  })

  it('compares the last 7 days with the previous 7 by calendar day, not by clock time', () => {
    const rows = [
      at('2026-10-18', 20, 'Food', '12:00:00'), // logged this morning, stored at noon
      at('2026-10-12', 10),
      at('2026-10-11', 10), // previous window
    ]
    const insights = run(rows, {}, '2026-10-18')
    expect(insights.find((i) => i.id === 'trend-Food')).toEqual({
      id: 'trend-Food',
      tone: 'up',
      title: 'Food up 200% in the last 7 days',
      detail: 'vs the previous 7 days (<20.00> more)',
    })
  })

  it('keeps the previous window to exactly 7 days (a row 14 days back is outside)', () => {
    const rows = [
      at('2026-10-18', 20), // last 7 days: Oct 12-18
      at('2026-10-05', 10), // previous 7 days: Oct 5-11
      at('2026-10-04', 100), // 14 days back: in neither window
    ]
    expect(run(rows, {}, '2026-10-18').find((i) => i.id === 'trend-Food')).toMatchObject({
      tone: 'up',
      title: 'Food up 100% in the last 7 days',
    })
  })

  it('says nothing about a week-on-week change under 5 in money, however large in percent', () => {
    const rows = [at('2026-10-17', 6), at('2026-10-10', 3)]
    expect(run(rows, {}, '2026-10-18').map((i) => i.id)).not.toContain('trend-Food')
  })

  it('calls a category over budget only past the cap, as Pulse does (at the cap is 100%)', () => {
    const atCap = run([at('2026-10-03', 150), at('2026-10-10', 150)], { Food: 300 }, '2026-10-18')
    expect(atCap.map((i) => i.id)).not.toContain('budget-over-Food')
    expect(atCap[0]).toMatchObject({ id: 'budget-near-Food', title: 'Food at 100% of budget' })
  })

  it('words budget alerts with the money formatter and days left (today included)', () => {
    const over = run([at('2026-10-02', 312.4)], { Food: 300 }, '2026-10-18')
    expect(over[0]).toEqual({
      id: 'budget-over-Food',
      tone: 'warn',
      title: 'Food is over budget',
      detail: '<312.40> of <300.00> · 14 days left in October',
    })
    const near = run([at('2026-10-02', 270)], { Food: 300 }, '2026-10-31')
    expect(near[0]).toEqual({
      id: 'budget-near-Food',
      tone: 'warn',
      title: 'Food at 90% of budget',
      detail: 'Last day of October',
    })
  })

  it('flags uncategorised rows and says all clear when nothing stands out', () => {
    const uncategorised = run(
      [at('2026-10-02', 1, 'Other'), at('2026-10-03', 1, ''), at('2026-10-04', 1, 'Uncategorized')],
      {},
      '2026-10-18',
    )
    expect(uncategorised.map((i) => i.id)).toContain('uncategorized')
    expect(run([at('2026-10-02', 5)], {}, '2026-10-18')).toEqual([
      {
        id: 'all-clear',
        tone: 'good',
        title: 'Everything looks on track',
        detail: 'No budget overruns or surges detected',
      },
    ])
    expect(run([], {}, '2026-10-18')).toEqual([])
  })

  it('leaves future-dated rows out of the month-to-date pace', () => {
    const rows = [
      at('2026-09-10', 50),
      at('2026-09-30', 100),
      at('2026-10-05', 60),
      at('2026-10-25', 1000), // logged ahead of time: in October, not in October so far
    ]
    expect(run(rows, {}, '2026-10-18').find((i) => i.id === 'month-pace')).toMatchObject({
      title: 'Pacing 31% lower than last month',
      detail: 'Projected <103.33> · September <150.00>',
    })
  })

  describe('monthly charges already paid are not projected (the rule Pulse budgets use)', () => {
    // Rent on the 1st of every month, lunch every day.
    const named = (day: string, itemName: string, amount: number, category: string) => ({
      ...at(day, amount, category),
      itemName,
    })
    const history = (octLunch: number, octDays: number) => [
      ...['2026-08', '2026-09', '2026-10'].map((m) => named(`${m}-01`, 'rent', 1200, 'Bills')),
      ...['2026-08', '2026-09'].flatMap((m) =>
        Array.from({ length: 30 }, (_, d) =>
          named(`${m}-${String(d + 1).padStart(2, '0')}`, 'lunch', 15, 'Food'),
        ),
      ),
      ...Array.from({ length: octDays }, (_, d) =>
        named(`2026-10-${String(d + 1).padStart(2, '0')}`, 'lunch', octLunch, 'Food'),
      ),
    ]

    it('rent on the 1st is not read as a month running several times higher', () => {
      // Oct 1-5: rent 1,200 + lunch 75 → 1,200 + 75 / 5 × 31 = 1,665 vs September 1,650.
      const insights = run(history(15, 5), {}, '2026-10-05')
      expect(insights.find((i) => i.id === 'month-pace')).toBeUndefined()
      expect(insights.map((i) => i.id)).toEqual(['all-clear'])
    })

    it('still flags variable spending that runs higher', () => {
      // Oct 1-10: rent 1,200 + lunch 300 → 1,200 + 300 / 10 × 31 = 2,130 vs 1,650.
      expect(run(history(30, 10), {}, '2026-10-10').find((i) => i.id === 'month-pace')).toEqual({
        id: 'month-pace',
        tone: 'up',
        title: 'Pacing 29% higher than last month',
        detail: 'Projected <2130.00> · September <1650.00>',
      })
    })
  })

  it('skips the pace insight in the first three days of a month', () => {
    const insights = run([at('2026-09-10', 50), at('2026-10-02', 60)], {}, '2026-10-03')
    expect(insights.find((i) => i.id === 'month-pace')).toBeUndefined()
  })

  it('never crashes on prototype-like category names and caps the list at 4', () => {
    const rows = [
      at('2026-10-17', 50, 'constructor'),
      at('2026-10-10', 10, 'constructor'),
      at('2026-10-17', 50, '__proto__'),
      at('2026-10-10', 10, '__proto__'),
      at('2026-10-17', 50, 'toString'),
      at('2026-10-10', 10, 'toString'),
      at('2026-10-02', 500, 'A'),
      at('2026-10-02', 500, 'B'),
    ]
    const insights = run(rows, { A: 100, B: 100, constructor: 1 }, '2026-10-18')
    expect(insights.length).toBeLessThanOrEqual(4)
    expect(insights[0]?.id).toBe('budget-over-A')
  })

  it('never reports a cap that rounds to zero cents as over budget', () => {
    const insights = run([at('2026-10-17', 5, 'Food')], { Food: 0.004 }, '2026-10-18')
    expect(insights.map((i) => i.id)).not.toContain('budget-over-Food')
  })
})
