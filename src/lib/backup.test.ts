import { describe, expect, it } from 'vitest'
import {
  BackupTooLargeError,
  MAX_IMPORT_EXPENSES,
  isNumber,
  isRecord,
  isString,
  listOf,
  parseBackup,
  parseBackupExpense,
  recordOf,
} from './backup'

const valid = {
  id: 'a1',
  itemName: 'coffee',
  amount: 4.5,
  category: 'Food & Drink',
  date: '2026-05-02T12:00:00',
  createdAt: '2026-05-02T12:00:00',
}

describe('guards', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('listOf keeps well-typed items and turns non-arrays into []', () => {
    expect(listOf(['a', 1, null, 'b'], isString)).toEqual(['a', 'b'])
    expect(listOf({ 0: 'a' }, isString)).toEqual([])
    expect(listOf(null, isString)).toEqual([])
  })

  it('recordOf keeps well-typed entries and turns non-objects into {}', () => {
    expect(recordOf({ coffee: 'Food', bad: 3 }, isString)).toEqual({ coffee: 'Food' })
    expect(recordOf({ Food: 200, Travel: '300' }, isNumber)).toEqual({ Food: 200 })
    expect(recordOf(null, isString)).toEqual({})
    expect(recordOf(['Food'], isString)).toEqual({})
    expect(recordOf('Food', isString)).toEqual({})
  })
})

describe('parseBackupExpense', () => {
  it('returns a typed copy of a valid expense', () => {
    expect(parseBackupExpense({ ...valid, notes: 'oat milk', updatedAt: valid.date })).toEqual({
      ...valid,
      notes: 'oat milk',
      updatedAt: valid.date,
    })
  })

  it('falls back to the expense date when createdAt is missing (older backups)', () => {
    const { createdAt: _createdAt, ...legacy } = valid
    expect(parseBackupExpense(legacy).createdAt).toBe(valid.date)
  })

  it('treats null optional fields as not set', () => {
    const parsed = parseBackupExpense({ ...valid, notes: null, updatedAt: null })
    expect(parsed).not.toHaveProperty('notes')
    expect(parsed).not.toHaveProperty('updatedAt')
  })

  it('drops fields the app does not know about', () => {
    expect(parseBackupExpense({ ...valid, legacyFlag: true })).not.toHaveProperty('legacyFlag')
  })

  it.each([
    ['a non-object', 'coffee', 'malformed expense'],
    ['an array', [valid], 'malformed expense'],
    ['a missing id', { ...valid, id: '' }, 'missing id'],
    ['a non-string itemName', { ...valid, itemName: 3 }, 'missing itemName'],
    ['a zero amount', { ...valid, amount: 0 }, 'bad amount'],
    ['a negative amount', { ...valid, amount: -5 }, 'bad amount'],
    ['a string amount', { ...valid, amount: '5' }, 'bad amount'],
    ['a missing date', { ...valid, date: undefined }, 'bad date'],
    ['an unparseable date', { ...valid, date: 'not-a-date' }, 'bad date'],
    ['a non-string category', { ...valid, category: null }, 'missing category'],
    ['a non-string createdAt', { ...valid, createdAt: 123 }, 'bad createdAt'],
    ['an object as notes', { ...valid, notes: { text: 'x' } }, 'bad notes'],
  ])('rejects %s', (_label, input, message) => {
    expect(() => parseBackupExpense(input)).toThrow(message)
  })
})

describe('parseBackup', () => {
  it('keeps only well-typed entries in the side collections', () => {
    const data = parseBackup({
      expenses: [valid],
      categories: ['Food & Drink', 7, null],
      categoryMappings: { coffee: 'Food & Drink', tea: 1 },
      budgets: { 'Food & Drink': 200, Travel: '300' },
      budgetUpdatedAt: { 'Food & Drink': '2026-05-08T12:00:00', Travel: 5 },
      budgetDeletedAt: 'nope',
      deletedIds: ['x', 2],
      exportDate: '2026-05-08T12:00:00',
      version: '4.0',
    })

    expect(data).toEqual({
      expenses: [valid],
      categories: ['Food & Drink'],
      categoryMappings: { coffee: 'Food & Drink' },
      budgets: { 'Food & Drink': 200 },
      budgetUpdatedAt: { 'Food & Drink': '2026-05-08T12:00:00' },
      budgetDeletedAt: {},
      deletedIds: ['x'],
      exportDate: '2026-05-08T12:00:00',
      version: '4.0',
    })
  })

  it('fills defaults for missing optional sections', () => {
    const data = parseBackup({ expenses: [] })
    expect(data.categories).toEqual([])
    expect(data.categoryMappings).toEqual({})
    expect(data.budgets).toEqual({})
    expect(data.deletedIds).toEqual([])
    expect(data.version).toBe('4.0')
    expect(typeof data.exportDate).toBe('string')
  })

  it('rejects files that are not a backup', () => {
    expect(() => parseBackup(null)).toThrow('not an object')
    expect(() => parseBackup([])).toThrow('not an object')
    expect(() => parseBackup({ expenses: 'none' })).toThrow('missing expenses[]')
  })

  it('rejects the whole file when any expense is malformed', () => {
    expect(() => parseBackup({ expenses: [valid, { ...valid, amount: -1 }] })).toThrow('bad amount')
  })

  it('refuses backups above the expense cap', () => {
    const expenses = Array.from({ length: MAX_IMPORT_EXPENSES + 1 }, () => valid)
    expect(() => parseBackup({ expenses })).toThrow(BackupTooLargeError)
  })
})
