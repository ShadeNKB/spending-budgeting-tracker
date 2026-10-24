// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0, docOf, genRecord } from '../__tests__/support/gen'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import {
  budgetSource,
  budgetView,
  displayList,
  isBudgetShown,
  isLive,
  joinBudget,
  liveMappingEntries,
  mappingKey,
  mappingLookup,
  resolve,
  resolver,
  totalBudget,
} from './categories'
import { EMPTY_DOC } from './doc'
import type { BudgetReg, ExpenseRec, RenameReg } from './types'

const ren = (to: string | null, s = T0): RenameReg => ({ to, s })
const bud = (value: number | null, set: number, del = 0): BudgetReg => ({ value, set, del })
const recIn = (id: string, category: string, C = T0): ExpenseRec => {
  const r = genRecord(makeRng(id.length), id, [C])
  return { ...r, C, c: { v: category, s: C, r: 2 } }
}

describe('resolve (§6.5.2)', HEAVY, () => {
  it('follows the chain; live names resolve to themselves', () => {
    const doc = docOf({
      renames: [
        ['Food', ren('Meals')],
        ['Meals', ren('Dining')],
        ['Dining', ren(null)],
      ],
    })
    expect(resolve(doc, 'Food')).toBe('Dining')
    expect(resolve(doc, 'Meals')).toBe('Dining')
    expect(resolve(doc, 'Dining')).toBe('Dining')
    expect(resolve(doc, 'Travel')).toBe('Travel')
    expect(isLive(doc, 'Food')).toBe(false)
    expect(isLive(doc, 'Dining')).toBe(true)
    expect(resolver(doc.renames)).toBe(resolver(doc.renames))
    expect(resolver(EMPTY_DOC.renames)('x')).toBe('x')
  })

  it('a cycle (hostile data only) resolves to its smallest name, from anywhere on it', () => {
    const doc = docOf({
      renames: [
        ['B', ren('C')],
        ['C', ren('A')],
        ['A', ren('B')],
        ['Z', ren('B')],
      ],
    })
    for (const n of ['A', 'B', 'C', 'Z']) expect(resolve(doc, n)).toBe('A')
    expect(isLive(doc, 'A')).toBe(true)
  })

  it('stops after 32 hops on a hostile chain', () => {
    const chain: [string, RenameReg][] = []
    for (let i = 0; i < 40; i++) chain.push([`c${i}`, ren(`c${i + 1}`)])
    expect(resolve(docOf({ renames: chain }), 'c0')).toBe('c32')
  })
})

describe('displayList (§6.5.4)', HEAVY, () => {
  it('is just Other for an empty doc', () => {
    expect(displayList(EMPTY_DOC)).toEqual(['Other'])
  })

  it('lists live listed names, then unlisted record names newest first, then Other', () => {
    const doc = docOf({
      categories: ['Food', 'Travel', 'Food'],
      renames: [
        ['Travel', ren('Trips')],
        ['Trips', ren(null)],
      ],
      expenses: [
        recIn('e1', 'Gym', T0),
        recIn('e2', 'Pets', T0 + 5),
        recIn('e3', 'Food'),
        recIn('e4', 'Travel'),
      ],
    })
    expect(displayList(doc)).toEqual(['Food', 'Pets', 'Gym', 'Trips', 'Other'])
    expect(displayList(doc)).toBe(displayList(doc))
  })
})

describe('budgets (§6.7)', HEAVY, () => {
  it('joinBudget is a join and returns an input when it equals it', () => {
    const r = makeRng(5)
    // canonical registers only: a hidden register carries no value
    const g = (): BudgetReg => {
      const set = r.pick([0, T0, T0 + 1])
      const del = r.pick([0, T0, T0 + 1])
      const hidden = del > 0 && del >= set
      return bud(r.chance(0.2) || hidden ? null : r.pick([100, 200]), set, del)
    }
    const key = (b: BudgetReg): string => JSON.stringify(b)
    for (let i = 0; i < 2000; i++) {
      const [a, b, c] = [g(), g(), g()]
      expect(key(joinBudget(a, b))).toBe(key(joinBudget(b, a)))
      expect(key(joinBudget(joinBudget(a, b), c))).toBe(key(joinBudget(a, joinBudget(b, c))))
      expect(joinBudget(a, a)).toBe(a)
    }
    const p = bud(300, T0 + 5, 0)
    expect(joinBudget(p, bud(100, T0, T0 + 1))).toEqual(bud(300, T0 + 5, T0 + 1))
    // a deletion newer than the winning set hides it, and the hidden value is not kept
    expect(joinBudget(p, bud(null, 0, T0 + 5))).toEqual(bud(null, T0 + 5, T0 + 5))
  })

  it('joinBudget: at equal set stamps the larger value wins, in either order (§6.7 maxBy(set, value))', () => {
    const lo: BudgetReg = { value: 100, set: T0, del: 0 }
    const hi: BudgetReg = { value: 300, set: T0, del: 0 }
    expect(joinBudget(lo, hi)).toBe(hi)
    expect(joinBudget(hi, lo)).toBe(hi)
    // any value beats a value-less register at the same stamp
    const none: BudgetReg = { value: null, set: T0, del: 0 }
    expect(joinBudget(none, lo)).toBe(lo)
    expect(joinBudget(lo, none)).toBe(lo)
  })

  it('isBudgetShown is exactly the v4 rule (a tie goes to the deletion)', () => {
    expect(isBudgetShown(bud(300, T0))).toBe(true)
    expect(isBudgetShown(bud(300, 0))).toBe(true)
    expect(isBudgetShown(bud(300, T0, T0))).toBe(false)
    expect(isBudgetShown(bud(300, T0, T0 - 1))).toBe(true)
    expect(isBudgetShown(bud(null, T0))).toBe(false)
  })

  it('a rename never doubles a budget; the own key is authoritative after merge-into', () => {
    const renamed = docOf({
      categories: ['Food', 'Meals'],
      renames: [
        ['Food', ren('Meals')],
        ['Meals', ren(null)],
      ],
      budgets: [['Food', bud(300, T0)]],
    })
    expect({ ...budgetView(renamed) }).toEqual({ Meals: 300 })
    expect(totalBudget(renamed)).toBe(300)
    expect(budgetSource(renamed, 'Meals')).toBe('Food')

    const mergedInto = docOf({
      categories: ['Food', 'Meals'],
      renames: [
        ['Food', ren('Meals')],
        ['Meals', ren(null)],
      ],
      budgets: [
        ['Food', bud(300, T0 + 9)],
        ['Meals', bud(200, T0)],
      ],
    })
    expect({ ...budgetView(mergedInto) }).toEqual({ Meals: 200 })
    expect(totalBudget(mergedInto)).toBe(200)

    const twoOld = docOf({
      renames: [
        ['A', ren('C')],
        ['B', ren('C')],
        ['C', ren(null)],
      ],
      budgets: [
        ['A', bud(100, T0 + 1)],
        ['B', bud(200, T0)],
      ],
      categories: ['C'],
    })
    expect({ ...budgetView(twoOld) }).toEqual({ C: 100 })
    expect(Object.getPrototypeOf(budgetView(twoOld))).toBeNull()
  })

  it('two inherited keys with EQUAL set stamps (the v0.8 1970/0 case) show the larger value', () => {
    for (const [first, second] of [
      ['A', 'B'],
      ['B', 'A'],
    ] as const) {
      const value = (k: string): number => (k === 'A' ? 300 : 100)
      for (const set of [0, T0]) {
        const doc = docOf({
          renames: [
            ['A', ren('C')],
            ['B', ren('C')],
            ['C', ren(null)],
          ],
          budgets: [
            [first, bud(value(first), set)],
            [second, bud(value(second), set)],
          ],
          categories: ['C'],
        })
        expect({ ...budgetView(doc) }, `${first} first, set ${String(set)}`).toEqual({ C: 300 })
        expect(budgetSource(doc, 'C')).toBe('A')
      }
    }
  })

  it('reserved-looking keys stay data, never prototype lookups', () => {
    const doc = docOf({ categories: ['Food'], budgets: [['Food', bud(50, T0)]] })
    const view = budgetView(doc)
    expect('constructor' in view).toBe(false)
    expect('toString' in view).toBe(false)
    expect(view.Food).toBe(50)
  })
})

describe('mappings (§6.6, P-8)', HEAVY, () => {
  const doc = docOf({
    categories: ['Food', 'Meals', 'Gym'],
    renames: [
      ['Food', ren('Meals')],
      ['Meals', ren(null)],
      ['Gym', ren('Other')],
      ['Other', ren(null)],
    ],
    mappings: [
      ['chicken rice', { v: 'Food', s: 0 }],
      ['gym pass', { v: 'Gym', s: 0 }],
      ['grab', { v: 'Transport', s: T0 }],
    ],
  })

  it('exact lookup is resolved: a stale mapping never files into a dead category', () => {
    expect(mappingLookup(doc, '  Chicken Rice ')).toBe('Meals')
    expect(mappingLookup(doc, 'gym pass')).toBe('Other')
    expect(mappingLookup(doc, 'grab')).toBe('Transport')
    expect(mappingLookup(doc, 'unknown')).toBeNull()
    expect(mappingLookup(doc, 'constructor')).toBeNull()
    expect(mappingLookup(doc, '__proto__')).toBeNull()
    expect(mappingLookup(doc, 'toString')).toBeNull()
    expect(mappingKey(' Kopi O ')).toBe('kopi o')
  })

  it('liveMappingEntries are resolved and sorted by key', () => {
    expect(liveMappingEntries(doc)).toEqual([
      ['chicken rice', 'Meals'],
      ['grab', 'Transport'],
      ['gym pass', 'Other'],
    ])
  })
})
