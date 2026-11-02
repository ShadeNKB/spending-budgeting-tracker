import { describe, expect, it } from 'vitest'
import { DEMO_EXPENSES } from './seedData'
import source from './seedData.ts?raw'

// Only demo builds (VITE_DEMO_MODE) read the seed. Its top-level computations are marked pure,
// so every other build, each real install, drops the whole module (about 4 KB of the first load's
// JS). One unmarked top-level call would bring it all back without a sound.
describe('demo seed data', () => {
  it('computes nothing at the top level that a non-demo build cannot drop', () => {
    expect(source).toMatch(/^const today = \/\*#__PURE__\*\/ new Date\(\)$/m)
    expect(source).toMatch(
      /^export const DEMO_EXPENSES: Expense\[\] = \/\*#__PURE__\*\/ RAW\.map\(/m,
    )
    const unmarked = source
      .split('\n')
      .filter((line) =>
        /^(export )?const \w+[^=]*= (?!\/\*#__PURE__\*\/)(new |[\w.]+\()/.test(line),
      )
    expect(unmarked).toEqual([])
  })
})

describe('demo rows', () => {
  it('carry their day and its floating local noon (P2-2), under demo-N ids', () => {
    expect(DEMO_EXPENSES.length).toBeGreaterThan(20)
    DEMO_EXPENSES.forEach((e, i) => {
      expect(e.id).toBe(`demo-${String(i + 1)}`)
      expect(e.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.date).toBe(`${e.day ?? ''}T12:00:00`)
    })
  })
})
