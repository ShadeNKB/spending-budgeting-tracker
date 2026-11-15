import { describe, expect, it } from 'vitest'
import { searchExpenses } from './expenseSearch'
import { KIND_INCOME, KIND_KEY, KIND_REFUND } from '../../lib/kind'
import type { ExpenseView } from '../../types'

// Characterisation tests: they hold the palette's search to what it does today (T9 slice 7, moved
// out of CommandPalette.tsx unchanged), quirks included.

const entry = (
  id: string,
  itemName: string,
  category: string,
  extra: { notes?: string; kind?: string; amount?: number } = {},
): ExpenseView => ({
  id,
  itemName,
  amount: extra.amount ?? 4.5,
  category,
  date: '2026-11-10T12:00:00.000Z',
  day: '2026-11-10',
  createdAt: '2026-11-10T12:00:00.000Z',
  ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  ext: extra.kind === undefined ? {} : { [KIND_KEY]: extra.kind },
})

const ids = (found: readonly ExpenseView[]) => found.map((e) => e.id)

const LIST: readonly ExpenseView[] = [
  entry('a', 'Kopi O', 'Food'),
  entry('b', 'Grab to work', 'Transport'),
  entry('c', 'Chicken rice', 'Food', { notes: 'with Wei' }),
  entry('d', 'Salary', 'Food', { kind: KIND_INCOME, amount: 3000 }),
  entry('e', 'Shoes', 'Shopping', { kind: KIND_REFUND }),
  entry('f', 'Café latte', 'Food'),
  entry('g', 'Kopi O', 'Food'),
]

describe('searchExpenses', () => {
  // Fuse matches every row for an empty or blank query. The palette never asks: it searches from
  // two characters (CommandPalette.tsx).
  it('returns the first `limit` entries, in list order, for an empty or blank query', () => {
    expect(ids(searchExpenses(LIST, '', 6))).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(ids(searchExpenses(LIST, '   ', 3))).toEqual(['a', 'b', 'c'])
  })

  it('finds nothing in an empty list', () => {
    expect(searchExpenses([], 'kopi', 6)).toEqual([])
  })

  it('finds by item name, case-insensitively', () => {
    expect(ids(searchExpenses(LIST, 'grab', 6))).toEqual(['b'])
    expect(ids(searchExpenses(LIST, 'GRAB', 6))).toEqual(['b'])
  })

  it('finds by category', () => {
    expect(ids(searchExpenses(LIST, 'transport', 6))).toEqual(['b'])
  })

  it('finds by notes', () => {
    expect(ids(searchExpenses(LIST, 'with wei', 6))).toEqual(['c'])
  })

  it('tolerates a typo (a fuzzy match)', () => {
    expect(ids(searchExpenses(LIST, 'chikcen', 6))).toEqual(['c'])
  })

  it('does not search amounts', () => {
    expect(searchExpenses(LIST, '3000', 6)).toEqual([])
    expect(searchExpenses(LIST, '4.5', 6)).toEqual([])
  })

  it('finds an income under "Income", not under its stored category', () => {
    expect(ids(searchExpenses(LIST, 'income', 6))).toEqual(['d'])
    expect(ids(searchExpenses(LIST, 'salary', 6))).toEqual(['d'])
  })

  it('finds a refund by its category and by the word "refund"', () => {
    expect(ids(searchExpenses(LIST, 'refund', 6))).toEqual(['e'])
    expect(ids(searchExpenses(LIST, 'shopping', 6))).toEqual(['e'])
  })

  it('does not fold diacritics: "cafe" and "café" find the same row only by fuzziness', () => {
    expect(ids(searchExpenses(LIST, 'café', 6))).toEqual(['f'])
    expect(ids(searchExpenses(LIST, 'cafe', 6))).toEqual(['f'])
  })

  it('returns entries that read the same in list order, newest (first) first', () => {
    expect(ids(searchExpenses(LIST, 'kopi', 6))).toEqual(['a', 'g'])
  })

  it('ranks a closer match before a looser one', () => {
    const list = [entry('x', 'Kopitiam lunch', 'Food'), entry('y', 'Kopi', 'Drinks')]
    expect(ids(searchExpenses(list, 'kopi', 6))).toEqual(['y', 'x'])
  })

  it('returns at most `limit` entries', () => {
    expect(ids(searchExpenses(LIST, 'food', 2))).toHaveLength(2)
    expect(searchExpenses(LIST, 'kopi', 0)).toEqual([])
  })

  it('returns the same entry objects it was given', () => {
    const [hit] = searchExpenses(LIST, 'grab', 6)
    expect(hit).toBe(LIST[1])
  })

  it('searches a new list afresh, not an index built for an earlier one', () => {
    expect(ids(searchExpenses(LIST, 'grab', 6))).toEqual(['b'])
    const next = [entry('z', 'Grab home', 'Transport'), ...LIST]
    expect(ids(searchExpenses(next, 'grab', 6))).toEqual(['z', 'b'])
  })

  it('on a large history, matches what a ranking of every row gives, newest first', () => {
    const list: ExpenseView[] = []
    for (let i = 0; i < 5000; i++) {
      list.push(
        i % 50 === 0
          ? entry(`k${i}`, 'Kopi O', 'Food')
          : entry(`n${i}`, `Item ${i % 7}`, i % 2 === 0 ? 'Transport' : 'Shopping'),
      )
    }
    expect(ids(searchExpenses(list, 'kopi', 6))).toEqual([
      'k0',
      'k50',
      'k100',
      'k150',
      'k200',
      'k250',
    ])
    expect(searchExpenses(list, 'kopi', 500)).toHaveLength(100)
  })
})
