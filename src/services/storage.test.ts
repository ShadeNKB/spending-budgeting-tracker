import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WRITER_VERSION, storage } from './storage'
import type { Expense } from '../types'

// Each case gets a fresh module: the device id is remembered for the session.
async function freshStorage() {
  vi.resetModules()
  return (await import('./storage')).storage
}

describe('storage.getDeviceId', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('creates a 6-char base36 id once and keeps it in spendtrack:dev', async () => {
    const s = await freshStorage()
    const id = s.getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(localStorage.getItem('spendtrack:dev')).toBe(id)
    expect(s.getDeviceId()).toBe(id)
  })

  it('is stable across reloads', async () => {
    const id = (await freshStorage()).getDeviceId()
    expect((await freshStorage()).getDeviceId()).toBe(id)
  })

  it('replaces a malformed stored id', async () => {
    localStorage.setItem('spendtrack:dev', 'not an id')
    const id = (await freshStorage()).getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(localStorage.getItem('spendtrack:dev')).toBe(id)
  })

  it('still returns one id for the session when storage refuses the write', async () => {
    const s = await freshStorage()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const id = s.getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(s.getDeviceId()).toBe(id)
  })
})

const sample: Expense = {
  id: 'abc',
  itemName: 'coffee',
  amount: 4.5,
  category: 'Food & Drink',
  date: '2026-05-02T10:00:00.000Z',
  createdAt: '2026-05-02T10:00:00.000Z',
}

describe('storage', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips expenses, categories, mappings, budgets, budget metadata, and tombstones via saveAll', () => {
    storage.saveAll(
      [sample],
      ['Food & Drink'],
      { coffee: 'Food & Drink' },
      { 'Food & Drink': 200 },
      { 'Food & Drink': '2026-05-08T12:00:00.000Z' },
      { Travel: '2026-05-08T13:00:00.000Z' },
      ['deleted-expense-id'],
    )

    expect(storage.getExpenses()).toEqual([sample])
    expect(storage.getCategories()).toEqual(['Food & Drink'])
    expect(storage.getCategoryMappings()).toEqual({ coffee: 'Food & Drink' })
    expect(storage.getBudgets()).toEqual({ 'Food & Drink': 200 })
    expect(storage.getBudgetUpdatedAt()).toEqual({ 'Food & Drink': '2026-05-08T12:00:00.000Z' })
    expect(storage.getBudgetDeletedAt()).toEqual({ Travel: '2026-05-08T13:00:00.000Z' })
    expect(storage.getDeletedIds()).toEqual(['deleted-expense-id'])
  })

  it('returns empty defaults when no data is stored', () => {
    expect(storage.getExpenses()).toEqual([])
    expect(storage.getCategories()).toBeNull()
    expect(storage.getCategoryMappings()).toEqual({})
    expect(storage.getBudgets()).toEqual({})
    expect(storage.getBudgetUpdatedAt()).toEqual({})
    expect(storage.getBudgetDeletedAt()).toEqual({})
    expect(storage.getDeletedIds()).toEqual([])
  })

  it('recovers from a trailing-comma-corrupted expenses payload', () => {
    localStorage.setItem(
      'expenses',
      '[{"id":"1","itemName":"x","amount":1,"category":"Other","date":"2026-05-01","createdAt":"2026-05-01"},]',
    )
    const result = storage.getExpenses()
    expect(result).toHaveLength(1)
    expect(result[0]?.itemName).toBe('x')
  })

  it('clears unrecoverable corrupted payloads instead of throwing', () => {
    localStorage.setItem('categoryMappings', '{not valid json}')
    expect(storage.getCategoryMappings()).toEqual({})
    expect(localStorage.getItem('categoryMappings')).toBeNull()
  })

  it('treats an empty array of categories as missing (returns null)', () => {
    storage.saveCategories([])
    expect(storage.getCategories()).toBeNull()
  })

  it('repairs well-formed JSON of the wrong shape to safe defaults', () => {
    localStorage.setItem('categories', '[1, null]')
    localStorage.setItem('categoryMappings', 'null')
    localStorage.setItem('categoryBudgets', '[200]')
    localStorage.setItem('categoryBudgetUpdatedAt', '"2026-05-08"')
    localStorage.setItem('categoryBudgetDeletedAt', '42')

    expect(storage.getCategories()).toBeNull()
    expect(storage.getCategoryMappings()).toEqual({})
    expect(storage.getBudgets()).toEqual({})
    expect(storage.getBudgetUpdatedAt()).toEqual({})
    expect(storage.getBudgetDeletedAt()).toEqual({})
  })

  it('writes the app marker after the data keys on every save', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    storage.saveAll([sample], ['Food & Drink'], {}, {}, {}, {}, [])
    expect(localStorage.getItem('spendtrack:app')).toBe(WRITER_VERSION)
    expect(WRITER_VERSION).toBe('0.8.5')
    expect(setItem.mock.calls.at(-1)?.[0]).toBe('spendtrack:app')
    expect(setItem.mock.calls.map((c) => c[0])).toContain('deletedExpenseIds')
    setItem.mockRestore()
  })

  it('drops individual entries of the wrong type and keeps the rest', () => {
    localStorage.setItem('categories', '["Food & Drink", 3]')
    localStorage.setItem('categoryMappings', '{"coffee":"Food & Drink","tea":7}')
    localStorage.setItem('categoryBudgets', '{"Food & Drink":200,"Travel":"300"}')

    expect(storage.getCategories()).toEqual(['Food & Drink'])
    expect(storage.getCategoryMappings()).toEqual({ coffee: 'Food & Drink' })
    expect(storage.getBudgets()).toEqual({ 'Food & Drink': 200 })
  })
})
