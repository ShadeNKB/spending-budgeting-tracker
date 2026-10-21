import { describe, expect, it } from 'vitest'
import { format, parseISO } from 'date-fns'
import { getLedgerIndex, rowsInRange, sumRange, toCents } from './ledgerIndex'
import type { Expense } from '../types'

let seq = 0
const row = (over: Partial<Expense> & { date: string }): Expense => ({
  id: over.id ?? `r${String(++seq).padStart(4, '0')}`,
  itemName: over.itemName ?? 'coffee',
  amount: over.amount ?? 5,
  category: over.category ?? 'Food & Dining',
  createdAt: over.createdAt ?? '2026-10-18T04:00:00.000Z',
  ...over,
})

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ids = (expenses: readonly Expense[], rows: readonly number[]) =>
  rows.map((i) => expenses[i]?.id)

describe('getLedgerIndex', () => {
  it('orders newest day first, then time, then createdAt, then id; unreadable dates last', () => {
    const expenses = [
      row({ id: 'bad', date: 'not a date' }),
      row({ id: 'old', date: '2026-10-11T12:00:00' }),
      row({ id: 'b', date: '2026-10-18T12:00:00', createdAt: '2026-10-18T01:00:00.000Z' }),
      row({ id: 'a', date: '2026-10-18T12:00:00', createdAt: '2026-10-18T01:00:00.000Z' }),
      row({ id: 'newer', date: '2026-10-18T12:00:00', createdAt: '2026-10-18T02:00:00.000Z' }),
      row({ id: 'evening', date: '2026-10-18T20:00:00' }),
      row({ id: 'legacy', date: '2026-10-18' }),
      row({ id: 'future', date: '2026-10-25T12:00:00' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(ids(expenses, Array.from(index.order))).toEqual([
      'future',
      'evening',
      'newer',
      'a',
      'b',
      'legacy',
      'old',
      'bad',
    ])
    expect(index.validCount).toBe(7)
    expect(index.orderedKeys.at(-1)).toBeNull()
    expect(index.dayKeys[0]).toBeNull()
  })

  it('sums integer cents: order independent, non-finite amounts count 0', () => {
    const expenses = [
      row({ date: '2026-10-18T12:00:00', amount: 0.1 }),
      row({ date: '2026-10-18T09:00:00', amount: 0.2 }),
      row({ date: '2026-10-17', amount: Number.NaN }),
      row({ date: '2026-10-17', amount: Number.POSITIVE_INFINITY }),
      row({ date: '2026-10-17', amount: 19.99 }),
    ]
    const index = getLedgerIndex(expenses)
    expect(Array.from(index.cents)).toEqual([10, 20, 0, 0, 1999])
    expect(index.totalCents).toBe(2029)
    expect(index.byDay.get('2026-10-18')).toEqual({ cents: 30, count: 2 })
    expect(index.byDay.get('2026-10-17')).toEqual({ cents: 1999, count: 3 })
    expect(toCents(1.15)).toBe(115)
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(toCents(-4.5)).toBe(-450)
  })

  it('memoises on the array identity', () => {
    const expenses = [row({ date: '2026-10-18' })]
    const a = getLedgerIndex(expenses)
    expect(getLedgerIndex(expenses)).toBe(a)
    expect(getLedgerIndex([...expenses])).not.toBe(a)
  })

  it('builds lowercased search text per row, fields kept apart', () => {
    const expenses = [
      row({ date: '2026-10-18', itemName: 'Kopi O', category: 'Food', notes: 'Tiong BAHRU' }),
      row({ date: '2026-10-18', itemName: 'Grab', category: 'Transport' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(index.searchText(0)).toBe('kopi o\0food\0tiong bahru')
    expect(index.searchText(1)).toBe('grab\0transport\0')
    expect(index.searchText(1)).toBe(index.searchText(1))
    expect(index.searchText(0).includes('o\0f')).toBe(true)
    expect(index.searchText(0).includes('ofood')).toBe(false)
  })

  it('handles prototype-like names and an empty ledger', () => {
    const expenses = [
      row({ date: '2026-10-18', itemName: '__proto__', category: 'constructor' }),
      row({ date: '2026-10-18', itemName: 'toString', category: 'hasOwnProperty' }),
    ]
    expect(getLedgerIndex(expenses).byDay.get('2026-10-18')?.count).toBe(2)
    const empty = getLedgerIndex([])
    expect(empty.validCount).toBe(0)
    expect(rowsInRange(empty, { start: '2026-01-01', end: '2026-12-31' })).toEqual([])
    expect(sumRange(empty, null)).toEqual({ cents: 0, count: 0 })
  })
})

describe('rowsInRange / sumRange', () => {
  const rand = mulberry32(641)
  const forms = (d: Date): string => {
    const r = rand()
    if (r < 0.4) return format(d, "yyyy-MM-dd'T'12:00:00")
    if (r < 0.75) return d.toISOString()
    if (r < 0.97) return format(d, 'yyyy-MM-dd')
    return 'corrupt'
  }
  const start = new Date(2025, 0, 1).getTime()
  const expenses: Expense[] = Array.from({ length: 1500 }, (_, i) =>
    row({
      id: `p${String(i)}`,
      date: forms(new Date(start + Math.floor(rand() * 700 * 86_400_000))),
      amount: Math.round(rand() * 10_000) / 100,
      createdAt: new Date(start + Math.floor(rand() * 700 * 86_400_000)).toISOString(),
    }),
  )
  const index = getLedgerIndex(expenses)
  const keyOf = (s: string): string | null => {
    try {
      return format(parseISO(s), 'yyyy-MM-dd')
    } catch {
      return null
    }
  }

  it('returns exactly the rows whose day falls in the range, already in index order', () => {
    const position = new Map(Array.from(index.order, (r, p) => [r, p]))
    const keyed = expenses.map((e, i) => ({ i, k: keyOf(e.date) }))
    for (let t = 0; t < 200; t++) {
      const a = format(new Date(start + Math.floor(rand() * 720 * 86_400_000)), 'yyyy-MM-dd')
      const b = format(new Date(start + Math.floor(rand() * 720 * 86_400_000)), 'yyyy-MM-dd')
      const range = a <= b ? { start: a, end: b } : { start: b, end: a }
      const got = rowsInRange(index, range)
      const want = keyed
        .filter(({ k }) => k !== null && k >= range.start && k <= range.end)
        .map(({ i }) => i)
      expect([...got].sort((x, y) => x - y)).toEqual(want)
      const positions = got.map((r) => position.get(r) ?? -1)
      expect(positions).toEqual([...positions].sort((x, y) => x - y))
      const cents = want.reduce((s, i) => s + Math.round((expenses[i]?.amount ?? 0) * 100), 0)
      expect(sumRange(index, range)).toEqual({ cents, count: want.length })
    }
  })

  it('null range = every row, unreadable dates included', () => {
    expect(rowsInRange(index, null)).toHaveLength(expenses.length)
    expect(sumRange(index, null).cents).toBe(index.totalCents)
    expect(index.validCount).toBeLessThan(expenses.length)
  })
})
