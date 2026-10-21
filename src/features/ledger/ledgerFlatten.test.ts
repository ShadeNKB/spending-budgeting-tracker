import { describe, it, expect } from 'vitest'
import {
  filterLedgerRows,
  flattenLedgerGroups,
  groupLedgerRows,
  ledgerHeaderLabel,
  ledgerRowDateLabel,
  type LedgerGroup,
} from './ledgerFlatten'
import { getLedgerIndex, rowsInRange } from '../../lib/ledgerIndex'
import type { Expense } from '../../types'

const mkExpense = (id: string, date: string, amount: number): Expense => ({
  id,
  itemName: `Item ${id}`,
  amount,
  category: 'Food',
  date: date.length === 10 ? `${date}T12:00:00` : date,
  createdAt: `2026-06-13T04:00:00.000Z`,
})

const group = (key: string | null, items: Expense[]): LedgerGroup => ({
  key,
  label: key ?? 'Unknown date',
  rowDateLabel: key ?? 'Unknown date',
  items,
  total: items.reduce((s, e) => s + e.amount, 0),
})

describe('ledger labels', () => {
  const today = '2026-10-18'

  it('names today and yesterday, otherwise weekday / date', () => {
    expect(ledgerHeaderLabel('2026-10-18', today)).toBe('Today')
    expect(ledgerHeaderLabel('2026-10-17', today)).toBe('Yesterday')
    expect(ledgerHeaderLabel('2026-10-05', today)).toBe('Mon / Oct 5')
  })

  it('adds the year when it differs from this year (GAP3-06)', () => {
    expect(ledgerHeaderLabel('2025-10-05', today)).toBe('Sun / Oct 5, 2025')
    expect(ledgerRowDateLabel('2025-10-05', today)).toBe('Oct 5, 2025')
    expect(ledgerRowDateLabel('2026-10-05', today)).toBe('Oct 5')
    expect(ledgerHeaderLabel('2025-12-31', '2026-01-01')).toBe('Yesterday')
  })

  it('labels rows whose date cannot be read', () => {
    expect(ledgerHeaderLabel(null, today)).toBe('Unknown date')
    expect(ledgerRowDateLabel(null, today)).toBe('Unknown date')
  })
})

describe('groupLedgerRows', () => {
  it('groups indexed rows by day in one pass, totals exact to the cent, unknown dates last', () => {
    // Summed as floats, even ×100 per row, these give 1.9899999999999998; in cents, 1.99.
    const expenses = [
      mkExpense('a', '2026-10-18', 0.29),
      mkExpense('bad', 'not a date', 3),
      mkExpense('b', '2026-10-18T08:30:00', 0.57),
      mkExpense('b2', '2026-10-18T07:00:00', 1.13),
      mkExpense('c', '2025-10-17', 4),
    ]
    const index = getLedgerIndex(expenses)
    const groups = groupLedgerRows(index, rowsInRange(index, null), '2026-10-18')
    expect(groups.map((g) => [g.key, g.label, g.total, g.items.map((e) => e.id)])).toEqual([
      ['2026-10-18', 'Today', 1.99, ['a', 'b', 'b2']],
      ['2025-10-17', 'Fri / Oct 17, 2025', 4, ['c']],
      [null, 'Unknown date', 3, ['bad']],
    ])
    expect(groups[1]?.rowDateLabel).toBe('Oct 17, 2025')
  })

  it('returns no groups for no rows', () => {
    const index = getLedgerIndex([])
    expect(groupLedgerRows(index, [], '2026-10-18')).toEqual([])
  })
})

describe('filterLedgerRows', () => {
  const expenses: Expense[] = [
    { ...mkExpense('1', '2026-10-18', 1.6), itemName: 'Kopi O', category: 'Food' },
    { ...mkExpense('2', '2026-10-17', 2), itemName: 'breakfast', notes: 'kopi and kaya toast' },
    { ...mkExpense('3', '2026-10-16', 3), itemName: 'tea', category: 'KOPITIAM' },
    { ...mkExpense('4', '2026-10-15', 14), itemName: 'Grab', category: 'Transport' },
  ]
  const index = getLedgerIndex(expenses)
  const all = rowsInRange(index, null)
  const ids = (rows: number[]) => rows.map((r) => index.expenses[r]?.id)

  it('searches name, notes and category in any case, ignoring surrounding spaces', () => {
    for (const search of ['kopi', 'Kopi', 'KOPI', '  kOpI ']) {
      expect(ids(filterLedgerRows(index, all, { category: 'all', search }))).toEqual([
        '1',
        '2',
        '3',
      ])
    }
    expect(ids(filterLedgerRows(index, all, { category: 'all', search: 'Kaya Toast' }))).toEqual([
      '2',
    ])
  })

  it('narrows to one category, combined with the search, keeping the index order', () => {
    expect(ids(filterLedgerRows(index, all, { category: 'Food', search: '' }))).toEqual(['1', '2'])
    expect(ids(filterLedgerRows(index, all, { category: 'Food', search: 'KOPI' }))).toEqual([
      '1',
      '2',
    ])
    expect(ids(filterLedgerRows(index, all, { category: 'all', search: '' }))).toEqual(ids(all))
    expect(filterLedgerRows(index, all, { category: 'Shopping', search: '' })).toEqual([])
  })
})

describe('flattenLedgerGroups', () => {
  it('returns an empty array for no groups', () => {
    expect(flattenLedgerGroups([])).toEqual([])
  })

  it('emits one header per group followed by its rows, in order', () => {
    const flat = flattenLedgerGroups([
      group('2026-06-13', [mkExpense('a', '2026-06-13', 5), mkExpense('b', '2026-06-13', 7)]),
      group('2026-06-12', [mkExpense('c', '2026-06-12', 3)]),
    ])

    // 2 headers + 3 rows
    expect(flat).toHaveLength(5)
    expect(flat[0]).toEqual({
      kind: 'header',
      id: 'h:2026-06-13',
      key: '2026-06-13',
      label: '2026-06-13',
      total: 12,
    })
    expect(flat[1]).toMatchObject({ kind: 'row', expense: { id: 'a' }, dateLabel: '2026-06-13' })
    expect(flat[2]).toMatchObject({ kind: 'row', expense: { id: 'b' } })
    expect(flat[3]).toEqual({
      kind: 'header',
      id: 'h:2026-06-12',
      key: '2026-06-12',
      label: '2026-06-12',
      total: 3,
    })
    expect(flat[4]).toMatchObject({ kind: 'row', expense: { id: 'c' } })
  })

  it('gives every item a stable identity key (GAP1-01)', () => {
    const flat = flattenLedgerGroups([
      group('2026-06-13', [mkExpense('a', '2026-06-13', 5)]),
      group(null, [mkExpense('z', 'garbage', 1)]),
    ])
    expect(flat.map((f) => f.id)).toEqual(['h:2026-06-13', 'r:a', 'h:unknown', 'r:z'])
  })

  it('scales to large lists (1000 rows) with one header per day', () => {
    const groups: LedgerGroup[] = Array.from({ length: 50 }, (_, d) => {
      const date = `2026-05-${String((d % 28) + 1).padStart(2, '0')}`
      return group(
        date,
        Array.from({ length: 20 }, (_, i) => mkExpense(`${String(d)}-${String(i)}`, date, i + 1)),
      )
    })

    const flat = flattenLedgerGroups(groups)

    // 50 headers + 1000 rows
    expect(flat).toHaveLength(1050)
    expect(flat.filter((f) => f.kind === 'header')).toHaveLength(50)
    expect(flat.filter((f) => f.kind === 'row')).toHaveLength(1000)
  })
})
