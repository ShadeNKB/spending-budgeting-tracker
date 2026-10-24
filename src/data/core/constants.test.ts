// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  AMOUNT_MAX,
  EXTRA_KEY_RE,
  FIELD_KEYS,
  GUARD_ABS,
  GUARD_FRAC,
  GUARD_MIN,
  MAX_AHEAD,
  MAX_T,
  MEMO_WINDOW,
  MIN_T,
  MIRROR_ORDER,
  NOTES_INPUT_MAX,
  RESERVED_NAMES,
  V4_KEYS,
  WIRE_PUSH_MAX,
  WIRE_WARN,
  isReserved,
} from './constants'

describe('constants (§3.2)', () => {
  it('pins the stamp window and clock reach', () => {
    expect(new Date(MIN_T).toISOString()).toBe('2000-01-01T00:00:00.000Z')
    expect(new Date(MAX_T).toISOString()).toBe('2100-01-01T00:00:00.000Z')
    expect(MAX_AHEAD).toBe(86_400_000)
    expect(MEMO_WINDOW).toBe(600_000)
  })

  it('pins the boundary limits and thresholds', () => {
    expect(AMOUNT_MAX).toBe(10_000_000)
    expect(NOTES_INPUT_MAX).toBe(500)
    expect([WIRE_WARN, WIRE_PUSH_MAX]).toEqual([630_000, 900_000])
    expect(WIRE_WARN / WIRE_PUSH_MAX).toBeCloseTo(0.7, 10)
    expect([GUARD_MIN, GUARD_ABS, GUARD_FRAC]).toEqual([10, 50, 0.1])
  })

  it('RESERVED_NAMES is a frozen literal covering every Object.prototype name of this engine (P-4)', () => {
    expect(Object.isFrozen(RESERVED_NAMES)).toBe(true)
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(RESERVED_NAMES).toContain(name)
    }
    expect(RESERVED_NAMES).toContain('prototype')
    expect(RESERVED_NAMES).toContain('__proto__')
    expect(isReserved('constructor')).toBe(true)
    expect(isReserved('Constructor')).toBe(false)
    expect(isReserved('toString')).toBe(true)
    expect(isReserved('Food')).toBe(false)
  })

  it('field keys, v4 keys and the crash-safe mirror order', () => {
    expect(FIELD_KEYS).toEqual(['n', 'a', 'c', 'd', 'o', 'x'])
    expect(MIRROR_ORDER).toEqual([
      'categoryBudgetDeletedAt',
      'categoryBudgets',
      'categoryBudgetUpdatedAt',
      'categoryMappings',
      'categories',
      'deletedExpenseIds',
      'expenses',
    ])
    expect([...V4_KEYS].sort()).toEqual([...MIRROR_ORDER].sort())
    // tombstones are written before expenses, a deletion stamp before its value removal
    expect(MIRROR_ORDER.indexOf('deletedExpenseIds')).toBeLessThan(MIRROR_ORDER.indexOf('expenses'))
    expect(MIRROR_ORDER.indexOf('categoryBudgetDeletedAt')).toBeLessThan(
      MIRROR_ORDER.indexOf('categoryBudgets'),
    )
  })

  it('extras key pattern', () => {
    expect(EXTRA_KEY_RE.test('kind')).toBe(true)
    expect(EXTRA_KEY_RE.test('a_1')).toBe(true)
    expect(EXTRA_KEY_RE.test('1a')).toBe(false)
    expect(EXTRA_KEY_RE.test('_a')).toBe(false)
    expect(EXTRA_KEY_RE.test('a'.repeat(33))).toBe(false)
    expect(EXTRA_KEY_RE.test('a'.repeat(32))).toBe(true)
  })
})
