// @vitest-environment node
// The incremental views (track spec §6.1, §8.3): after any op or merge, the views built from the
// previous ones equal a cold rebuild of the same doc, and every record that did not change keeps
// its ExpenseView object. Seeded random op sequences over a small owner-shaped doc.
import { describe, expect, it } from 'vitest'
import { mergeDoc } from '../../core/doc'
import * as ops from '../../core/ops'
import type { Doc, OpCtx } from '../../core/types'
import { T0, genDoc } from '../../__tests__/support/gen'
import { must } from '../../__tests__/support/must'
import { ownerDoc } from '../../__tests__/support/ownerShape'
import { HEAVY, type Rng, makeRng } from '../../__tests__/support/rng'
import { type Views, buildViews } from '../views'

const plain = (v: Views): unknown => ({
  expenses: v.expenses.map((e) => ({ ...e })),
  categories: [...v.categories],
  categoryMappings: { ...v.categoryMappings },
  budgets: { ...v.budgets },
  asideCategories: [...v.asideCategories],
  monthBudget: v.monthBudget,
  syncedCurrency: v.syncedCurrency,
  hasDemoRows: v.hasDemoRows,
})

const CATS = ['Food & Dining', 'Transport', 'Groceries', 'Kopi', 'Other'] as const

/** One random step: an op through core, or a merge with a random doc (a pull or another tab). */
function step(doc: Doc, rng: Rng, ctx: OpCtx): Doc {
  const ids = [...doc.expenses.keys()]
  const anyId = (): string => (ids.length === 0 ? 'none' : rng.pick(ids))
  const tryOp = (f: () => Doc): Doc => {
    try {
      return f()
    } catch {
      return doc
    }
  }
  switch (rng.int(9)) {
    case 0:
    case 1:
      return tryOp(
        () =>
          ops.addExpense(doc, ctx, {
            itemName: rng.pick(['Kopi', 'Chicken rice', 'Grab', `Item ${String(rng.int(50))}`]),
            amount: rng.between(1, 90),
            category: rng.pick(CATS),
            day: `2026-${String(rng.between(1, 12)).padStart(2, '0')}-1${String(rng.int(9))}`,
          }).doc,
      )
    case 2:
      return tryOp(() => ops.updateExpense(doc, ctx, anyId(), { amount: rng.between(1, 99) }).doc)
    case 3:
      return tryOp(() => ops.updateExpense(doc, ctx, anyId(), { day: '2026-10-31' }).doc)
    case 4:
      return tryOp(() => ops.deleteExpenses(doc, ctx, [anyId(), anyId()]).doc)
    case 5:
      return tryOp(() => ops.setBudget(doc, ctx, rng.pick(CATS), rng.between(10, 500)).doc)
    case 6:
      return tryOp(() => ops.renameCategory(doc, ctx, rng.pick(CATS), rng.pick(CATS)).doc)
    case 7:
      return tryOp(() => ops.addCategory(doc, ctx, `New ${String(rng.int(4))}`).doc)
    default:
      return mergeDoc(doc, genDoc(rng)).doc
  }
}

describe('incremental views', () => {
  it(
    'equal a cold rebuild after every op and merge, and keep unchanged rows (40 seeds × 40 steps)',
    HEAVY,
    () => {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = makeRng(seed)
        let doc = ownerDoc(60, seed)
        let views = buildViews(doc, null, null, false)
        for (let i = 0; i < 40; i++) {
          const ctx: OpCtx = {
            wall: T0 + i * 1000,
            clock: { last: 0 },
            dev: 'views1',
            rng: rng.next,
          }
          const next = step(doc, rng, ctx)
          const after = buildViews(next, doc, views, false)
          expect(plain(after), `seed ${String(seed)} step ${String(i)}`).toEqual(
            plain(buildViews(next, null, null, false)),
          )
          const before = new Map(views.expenses.map((v) => [v.id, v]))
          for (const v of after.expenses) {
            if (
              doc.expenses.get(v.id) === next.expenses.get(v.id) &&
              next.renames === doc.renames
            ) {
              expect(v).toBe(must(before.get(v.id)))
            }
          }
          if (next === doc) expect(after).toBe(views)
          doc = next
          views = after
        }
      }
    },
  )

  it('keep the list, mappings and budgets when only an unrelated register changes', () => {
    const doc = ownerDoc(200, 7)
    const views = buildViews(doc, null, null, false)
    const ctx: OpCtx = { wall: T0, clock: { last: 0 }, dev: 'views2', rng: makeRng(1).next }
    const next = ops.setCurrency(doc, ctx, 'EUR').doc
    const after = buildViews(next, doc, views, false)
    expect(after.expenses).toBe(views.expenses)
    expect(after.categories).toBe(views.categories)
    expect(after.categoryMappings).toBe(views.categoryMappings)
    expect(after.budgets).toBe(views.budgets)
    expect(after.syncedCurrency).toBe('EUR')
  })
})
