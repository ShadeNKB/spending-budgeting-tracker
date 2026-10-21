import { describe, expect, it } from 'vitest'
import type { Expense } from '../types'
import {
  MAX_AMOUNT,
  isAmountTooLarge,
  isUnusualAmount,
  unusualAmountThreshold,
} from './amountGuard'

let nextId = 0
function rows(...amounts: number[]): Expense[] {
  return amounts.map((amount) => {
    nextId += 1
    return {
      id: `row-${String(nextId)}`,
      itemName: 'item',
      amount,
      category: 'Other',
      date: '2026-10-18T12:00:00',
      createdAt: '2026-10-18T04:00:00.000Z',
    }
  })
}

const repeat = (value: number, times: number) => Array.from({ length: times }, () => value)

// Sorted: 1 2 3 4 5×13 6 20 20 → median 5, p95 (nearest rank, 19th of 20) 20.
const MEDIAN_5_P95_20 = [1, 2, 3, 4, ...repeat(5, 13), 6, 20, 20]

describe('unusualAmountThreshold', () => {
  it('uses 10,000 while there are fewer than 10 rows of history', () => {
    expect(unusualAmountThreshold([])).toBe(10_000)
    expect(unusualAmountThreshold(rows(...repeat(5, 9)))).toBe(10_000)
  })

  it('is the larger of 10 × median and 2 × p95 once there are 10 rows', () => {
    expect(unusualAmountThreshold(rows(...MEDIAN_5_P95_20))).toBe(50)
    // Median 6, p95 60: 2 × p95 = 120 wins over 10 × median = 60.
    expect(unusualAmountThreshold(rows(...repeat(6, 18), 60, 60))).toBe(120)
  })

  it('averages the two middle values for an even count', () => {
    expect(unusualAmountThreshold(rows(...repeat(4, 5), ...repeat(8, 5)))).toBe(60)
  })

  it('only reads the 200 newest rows (the store keeps the newest first)', () => {
    const history = rows(...repeat(5, 200), ...repeat(1000, 300))
    expect(unusualAmountThreshold(history)).toBe(50)
  })

  it('ignores rows whose amount is not a positive finite number', () => {
    const history = rows(...repeat(5, 9), Number.NaN, -20, 0, Number.POSITIVE_INFINITY)
    expect(unusualAmountThreshold(history)).toBe(10_000)
  })

  it('is computed once per expenses array', () => {
    const history = rows(...MEDIAN_5_P95_20)
    expect(unusualAmountThreshold(history)).toBe(50)
    history.unshift(...rows(...repeat(900, 50)))
    expect(unusualAmountThreshold(history)).toBe(50)
    expect(unusualAmountThreshold([...history])).toBe(9000)
  })
})

describe('isUnusualAmount', () => {
  const history = rows(...MEDIAN_5_P95_20)

  it('asks for a second look at a mistyped amount', () => {
    expect(isUnusualAmount(4500, history)).toBe(true)
    expect(isUnusualAmount(50, history)).toBe(true)
  })

  it('lets everyday amounts through at once', () => {
    expect(isUnusualAmount(45, history)).toBe(false)
    expect(isUnusualAmount(49.99, history)).toBe(false)
  })

  it('flags 10,000 and more on a new profile', () => {
    expect(isUnusualAmount(9999.99, [])).toBe(false)
    expect(isUnusualAmount(10_000, [])).toBe(true)
  })
})

describe('isAmountTooLarge', () => {
  it('allows up to 10,000,000 and blocks anything above', () => {
    expect(MAX_AMOUNT).toBe(10_000_000)
    expect(isAmountTooLarge(10_000_000)).toBe(false)
    expect(isAmountTooLarge(10_000_000.01)).toBe(true)
    expect(isAmountTooLarge(99_999_999)).toBe(true)
  })
})
