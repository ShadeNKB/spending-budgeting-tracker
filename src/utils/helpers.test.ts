import { describe, expect, it } from 'vitest'
import { generateId, validateExpenseData } from './helpers'

describe('generateId', () => {
  it('returns unique-ish ids on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()))
    expect(ids.size).toBe(50)
  })
})

describe('validateExpenseData', () => {
  it('requires a 2+ char name, positive amount, and date', () => {
    const r = validateExpenseData({ itemName: 'a', amount: 0 })
    expect(r.isValid).toBe(false)
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('passes a valid record', () => {
    const r = validateExpenseData({
      itemName: 'coffee',
      amount: 4.5,
      date: '2026-05-01',
    })
    expect(r.isValid).toBe(true)
    expect(r.errors).toEqual([])
  })
})
