import { describe, expect, it } from 'vitest'
import { KIND_INCOME as CORE_INCOME, KIND_KEY as CORE_KEY } from '../data/core/constants'
import { expensesToCsv } from './csv'
import { KIND_INCOME, KIND_KEY, categoryOf, filedUnder, kindOf } from './kind'
import { getLedgerIndex, rowsInRange } from './ledgerIndex'
import { splitSpending } from './spending'
import { filterLedgerRows, groupLedgerRows } from '../features/ledger/ledgerFlatten'
import type { Expense, Json } from '../types'

let seq = 0
// Invented data, stored as the app stores it: local noon, no `Z`.
const at = (day: string, amount: number, category: string, ext?: Record<string, Json>): Expense => {
  seq += 1
  return {
    id: `k${String(seq)}`,
    itemName: `item ${String(seq)}`,
    amount,
    category,
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
    ...(ext === undefined ? {} : { ext }),
  }
}
const income = (day: string, amount: number, category = 'Other'): Expense =>
  at(day, amount, category, { kind: 'income' })

describe('kindOf (T8c)', () => {
  it('uses the data core’s own two words', () => {
    expect(KIND_KEY).toBe(CORE_KEY)
    expect(KIND_INCOME).toBe(CORE_INCOME)
  })

  it('an entry without the field is an expense, as every entry was before kinds', () => {
    expect(kindOf(at('2026-10-02', 5, 'Food'))).toBe('expense')
    expect(kindOf(at('2026-10-02', 5, 'Food', {}))).toBe('expense')
    expect(kindOf(at('2026-10-02', 5, 'Food', { tag: 'trip' }))).toBe('expense')
    expect(kindOf(at('2026-10-02', 5, 'Food', { kind: 'expense' }))).toBe('expense')
  })

  it('reads income, and calls anything else unknown rather than guessing', () => {
    expect(kindOf(income('2026-10-10', 790))).toBe('income')
    for (const raw of ['refund', 'Income', '', 0, 1, null, true, ['income'], { v: 'income' }]) {
      expect(kindOf(at('2026-10-02', 5, 'Food', { kind: raw })), JSON.stringify(raw)).toBe(
        'unknown',
      )
    }
  })

  it('only an own field counts: a kind on the prototype chain is not the entry’s', () => {
    const ext = Object.create({ kind: 'income' }) as Record<string, Json>
    expect(kindOf(at('2026-10-02', 5, 'Food', ext))).toBe('expense')
  })

  it('only an expense is in a category; the others say what they are', () => {
    expect(categoryOf(at('2026-10-02', 5, 'Food'))).toBe('Food')
    expect(categoryOf(income('2026-10-10', 790, 'Food'))).toBeNull()
    expect(filedUnder(at('2026-10-02', 5, 'Food'))).toBe('Food')
    expect(filedUnder(income('2026-10-10', 790))).toBe('Income')
    expect(filedUnder(at('2026-10-02', 5, 'Food', { kind: 'refund' }))).toBe('Newer kind of entry')
  })
})

describe('splitSpending with kinds (T8c)', () => {
  const FOOD = at('2026-10-02', 12.5, 'Food')
  const INVEST = at('2026-10-03', 300, 'Investment')
  const PAY = income('2026-10-10', 790)
  // an income keeps whatever category it is stored with, a not-spending one too
  const SOLD = income('2026-10-11', 200, 'Investment')
  const NEWER = at('2026-10-12', 25, 'Food', { kind: 'refund' })
  const ROWS: readonly Expense[] = [FOOD, INVEST, PAY, SOLD, NEWER]

  it('every entry is in exactly one of spending, aside, income and unknown', () => {
    const s = splitSpending(ROWS, ['Investment'])
    expect(s.spending).toEqual([FOOD])
    expect(s.aside).toEqual([INVEST])
    expect(s.income).toEqual([PAY, SOLD])
    expect(s.unknown).toEqual([NEWER])
    expect(s.outgoing).toEqual([FOOD, INVEST])
  })

  it('money in leaves spending with no not-spending category at all', () => {
    const s = splitSpending(ROWS, [])
    expect(s.spending).toEqual([FOOD, INVEST])
    expect(s.outgoing).toBe(s.spending)
    expect(s.income).toEqual([PAY, SOLD])
    expect(getLedgerIndex(s.spending).totalCents).toBe(31250)
  })

  it('with nothing but expenses each whole part is the array it was given', () => {
    const rows = [FOOD, INVEST]
    const s = splitSpending(rows, [])
    expect(s.spending).toBe(rows)
    expect(s.outgoing).toBe(rows)
    expect(s.income).toEqual([])
    expect(s.unknown).toEqual([])
    // expenses only, some of them not spending: every expense is still outgoing
    const t = splitSpending(rows, ['Investment'])
    expect(t.outgoing).toBe(rows)
    expect(t.spending).toEqual([FOOD])
  })

  it('gives the same arrays for the same two inputs', () => {
    const none: readonly string[] = []
    const a = splitSpending(ROWS, none)
    const b = splitSpending(ROWS, none)
    expect(b.spending).toBe(a.spending)
    expect(b.income).toBe(a.income)
    expect(b.outgoing).toBe(a.outgoing)
  })
})

describe('the Ledger with kinds (T8c)', () => {
  const today = '2026-10-18'
  const FOOD = at('2026-10-10', 12.5, 'Food')
  const PAY: Expense = { ...income('2026-10-10', 790), itemName: 'Allowance' }
  const OTHER = at('2026-10-10', 3, 'Other')
  const NEWER = at('2026-10-10', 25, 'Food', { kind: 'refund' })
  const index = getLedgerIndex([FOOD, PAY, OTHER, NEWER])
  const rows = rowsInRange(index, null)

  it('a day’s total is its spending: money in and unknown kinds are listed, not summed', () => {
    const [day] = groupLedgerRows(index, rows, today)
    expect(day?.items).toHaveLength(4)
    expect(day?.total).toBe(15.5)
  })

  it('a category lists its expenses only: an income is not "in" the category it is stored with', () => {
    const names = (category: string) =>
      filterLedgerRows(index, rows, { category, search: '' }).map(
        (r) => index.expenses[r]?.itemName,
      )
    expect(names('Other')).toEqual([OTHER.itemName])
    expect(names('Food')).toEqual([FOOD.itemName])
    expect(names('all')).toHaveLength(4)
  })

  it('a search finds an income by its name or by "income", never by its stored category', () => {
    const find = (search: string) =>
      filterLedgerRows(index, rows, { category: 'all', search }).map(
        (r) => index.expenses[r]?.itemName,
      )
    expect(find('allow')).toEqual(['Allowance'])
    expect(find('INCOME')).toEqual(['Allowance'])
    expect(find('other')).toEqual([OTHER.itemName])
  })
})

describe('the CSV export with kinds (T8c)', () => {
  it('says the type of every row in a last column; only an expense has a category', () => {
    const csv = expensesToCsv([
      { ...at('2026-10-02', 12.5, 'Food'), itemName: 'Lunch' },
      { ...income('2026-10-10', 790), itemName: 'Allowance', notes: 'November' },
      { ...at('2026-10-12', 25, 'Shopping', { kind: 'refund' }), itemName: 'Shopee' },
      { ...at('2026-10-13', 1, 'Food', { kind: 7 }), itemName: 'Odd' },
    ])
    expect(csv).toBe(
      '﻿Date,Item,Category,Amount,Notes,Type\r\n' +
        '"2026-10-02","Lunch","Food","12.5","","expense"\r\n' +
        '"2026-10-10","Allowance","","790","November","income"\r\n' +
        '"2026-10-12","Shopee","","25","","refund"\r\n' +
        '"2026-10-13","Odd","","1","","other"\r\n',
    )
  })

  it('a kind that could run as a formula is written as text, like any other cell', () => {
    const csv = expensesToCsv([at('2026-10-12', 25, 'Food', { kind: '=cmd|x' })])
    expect(csv).toContain(`,"'=cmd|x"\r\n`)
  })
})
