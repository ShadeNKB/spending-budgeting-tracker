import { describe, expect, it } from 'vitest'
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
