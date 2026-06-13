import { describe, it, expect } from 'vitest'
import { flattenLedgerGroups, type LedgerGroup } from './ledgerFlatten'
import type { Expense } from '../../types'

const mkExpense = (id: string, date: string, amount: number): Expense => ({
  id,
  itemName: `Item ${id}`,
  amount,
  category: 'Food',
  date: `${date}T12:00:00.000Z`,
  createdAt: `${date}T12:00:00.000Z`,
})

describe('flattenLedgerGroups', () => {
  it('returns an empty array for no groups', () => {
    expect(flattenLedgerGroups([])).toEqual([])
  })

  it('emits one header per group followed by its rows, in order', () => {
    const groups: LedgerGroup[] = [
      {
        date: '2026-06-13',
        items: [mkExpense('a', '2026-06-13', 5), mkExpense('b', '2026-06-13', 7)],
        total: 12,
      },
      { date: '2026-06-12', items: [mkExpense('c', '2026-06-12', 3)], total: 3 },
    ]

    const flat = flattenLedgerGroups(groups)

    // 2 headers + 3 rows
    expect(flat).toHaveLength(5)
    expect(flat[0]).toEqual({ kind: 'header', date: '2026-06-13', total: 12 })
    expect(flat[1]).toMatchObject({ kind: 'row', expense: { id: 'a' } })
    expect(flat[2]).toMatchObject({ kind: 'row', expense: { id: 'b' } })
    expect(flat[3]).toEqual({ kind: 'header', date: '2026-06-12', total: 3 })
    expect(flat[4]).toMatchObject({ kind: 'row', expense: { id: 'c' } })
  })

  it('scales to large lists (1000 rows) with one header per day', () => {
    const groups: LedgerGroup[] = Array.from({ length: 50 }, (_, d) => {
      const date = `2026-05-${String((d % 28) + 1).padStart(2, '0')}`
      const items = Array.from({ length: 20 }, (_, i) => mkExpense(`${d}-${i}`, date, i + 1))
      return { date, items, total: items.reduce((s, e) => s + e.amount, 0) }
    })

    const flat = flattenLedgerGroups(groups)

    // 50 headers + 1000 rows
    expect(flat).toHaveLength(1050)
    expect(flat.filter((f) => f.kind === 'header')).toHaveLength(50)
    expect(flat.filter((f) => f.kind === 'row')).toHaveLength(1000)
  })
})
