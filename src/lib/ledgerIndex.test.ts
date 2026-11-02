import { describe, expect, it } from 'vitest'
import { format, parseISO } from 'date-fns'
import { entryDay, getLedgerIndex, rowsInRange, sumRange, toCents } from './ledgerIndex'
import type { Expense } from '../types'

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value')
  return value
}

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

// P2-2: every reader buckets an entry on its `day`. Run in Asia/Singapore, Pacific/Honolulu and
// Pacific/Kiritimati (PowerShell $env:TZ): each legacy form is built from a local wall time, so
// the day it must keep is the one 0.9.4 showed in that zone.
describe('the day contract (P2-2)', () => {
  /** A local wall time as 0.9.x stored it: the instant, in UTC with a Z. */
  const instant = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(y, m - 1, d, h, min).toISOString()

  it('buckets a row on its day, not on whatever its date reads as here', () => {
    // A date that reads as another day in every zone: the day wins.
    const expenses = [row({ id: 'v', day: '2026-10-17', date: '2026-10-19T12:00:00' })]
    const index = getLedgerIndex(expenses)
    expect(index.dayKeys).toEqual(['2026-10-17'])
    expect(index.byDay.get('2026-10-17')).toEqual({ cents: 500, count: 1 })
    expect(index.byDay.has('2026-10-19')).toBe(false)
    expect(rowsInRange(index, { start: '2026-10-17', end: '2026-10-17' })).toEqual([0])
    expect(entryDay(must(expenses[0]))).toBe('2026-10-17')
  })

  it('keeps the day 0.9.4 showed for Z-noon, raw-instant, floating and bare-day rows', () => {
    const expenses = [
      row({ id: 'z-noon', date: instant(2026, 10, 17, 12) }),
      row({ id: 'raw', date: instant(2026, 10, 17, 0, 30) }),
      row({ id: 'late', date: instant(2026, 10, 17, 23, 59) }),
      row({ id: 'floating', date: '2026-10-17T12:00:00' }),
      row({ id: 'bare', date: '2026-10-17' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(index.dayKeys).toEqual(Array<string>(5).fill('2026-10-17'))
    for (const e of expenses) expect(entryDay(e)).toBe('2026-10-17')
    // A view of the same rows (the engine derives each day the same way) lands identically.
    const views = expenses.map((e) => ({ ...e, day: '2026-10-17' }))
    expect(getLedgerIndex(views).dayKeys).toEqual(index.dayKeys)
  })

  it('keeps 31 Dec 23:59 in the old year and 1 Jan 00:00 in the new one', () => {
    const expenses = [
      row({ id: 'eve', date: instant(2025, 12, 31, 23, 59) }),
      row({ id: 'new', date: instant(2026, 1, 1, 0, 0) }),
      row({ id: 'eve-v5', day: '2025-12-31', date: '2025-12-31T12:00:00' }),
      row({ id: 'new-v5', day: '2026-01-01', date: '2026-01-01T12:00:00' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(index.dayKeys).toEqual(['2025-12-31', '2026-01-01', '2025-12-31', '2026-01-01'])
    expect(sumRange(index, { start: '2025-12-01', end: '2025-12-31' }).count).toBe(2)
    expect(sumRange(index, { start: '2026-01-01', end: '2026-01-31' }).count).toBe(2)
  })

  it('orders a day by stored time, then createdAt, whatever form each date has', () => {
    const expenses = [
      row({ id: 'noon', day: '2026-10-17', date: '2026-10-17T12:00:00' }),
      row({ id: 'raw-evening', day: '2026-10-17', date: instant(2026, 10, 17, 21) }),
      row({ id: 'raw-morning', day: '2026-10-17', date: instant(2026, 10, 17, 7) }),
      row({ id: 'next', day: '2026-10-18', date: '2026-10-18T12:00:00' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(ids(expenses, Array.from(index.order))).toEqual([
      'next',
      'raw-evening',
      'noon',
      'raw-morning',
    ])
  })

  it('falls back to the stored date when a day is missing or not a real day', () => {
    const expenses = [
      row({ id: 'feb30', day: '2026-02-30', date: '2026-02-27T12:00:00' }),
      row({ id: 'junk', day: 'yesterday', date: '2026-02-26' }),
      row({ id: 'none', date: '2026-02-25T12:00:00' }),
    ]
    expect(getLedgerIndex(expenses).dayKeys).toEqual(['2026-02-27', '2026-02-26', '2026-02-25'])
  })

  it('files a row with a real day and an unreadable date on its day, at noon', () => {
    const expenses = [
      row({ id: 'unreadable', day: '2026-10-17', date: 'last tuesday' }),
      row({ id: 'morning', day: '2026-10-17', date: instant(2026, 10, 17, 9) }),
      row({ id: 'evening', day: '2026-10-17', date: instant(2026, 10, 17, 18) }),
      row({ id: 'lost', date: 'last tuesday' }),
    ]
    const index = getLedgerIndex(expenses)
    expect(index.dayKeys).toEqual(['2026-10-17', '2026-10-17', '2026-10-17', null])
    expect(index.validCount).toBe(3)
    expect(ids(expenses, Array.from(index.order))).toEqual([
      'evening',
      'unreadable',
      'morning',
      'lost',
    ])
    expect(entryDay(must(expenses[3]))).toBeNull()
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
