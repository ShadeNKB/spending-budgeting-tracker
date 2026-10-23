// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0 } from '../__tests__/support/gen'
import { must } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { budgetView, displayList, resolve, totalBudget } from './categories'
import { EMPTY_DOC, mergeDoc } from './doc'
import { reviveId } from './ids'
import {
  addCategory,
  addExpense,
  deleteAllEverywhere,
  deleteExpenses,
  removeBudget,
  removeCategory,
  renameCategory,
  setBudget,
  setCurrency,
  undo,
  updateExpense,
} from './ops'
import type { Doc, ExpenseRec, Hlc, OpCtx, OpResult } from './types'

const mk = (wall: number, clock: Hlc, seed = 1): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(seed).next,
})
const entry = (r: OpResult) => must(r.undo, 'undo entry')
const only = (d: Doc) => must([...d.expenses.values()][0], 'record')

function seeded(c: Hlc): Doc {
  return addExpense(EMPTY_DOC, mk(T0, c), {
    itemName: 'chicken rice',
    amount: 4.5,
    category: 'Food',
  }).doc
}

describe('undo is a guarded forward write (§7.2, F-011)', HEAVY, () => {
  it('undo of add tombstones the record when untouched since', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'kopi', amount: 1.8 })
    const u = undo(r.doc, mk(T0 + 1, c), entry(r))
    expect(u.doc.expenses.size).toBe(0)
    expect(u.doc.tombs.has(must(r.created).id)).toBe(true)
    expect(u.report).toEqual({ applied: 1, skipped: 0 })
  })

  it('undo of add is skipped when the record was edited elsewhere since', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'kopi', amount: 1.8 })
    const edited = updateExpense(r.doc, mk(T0 + 5, { last: T0 }), must(r.created).id, {
      amount: 2,
    }).doc
    const u = undo(edited, mk(T0 + 6, c), entry(r))
    expect(u.doc).toBe(edited)
    expect(u.report).toEqual({ applied: 0, skipped: 1 })
  })

  it('undo of an edit writes the previous value at a NEWER stamp, so it survives a sync (T-011-2)', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const id = only(d).id
    const edit = updateExpense(d, mk(T0 + 10, c), id, { amount: 45 })
    const other = edit.doc // the other device received the edit
    const u = undo(edit.doc, mk(T0 + 20, c), entry(edit))
    const rec = must(u.doc.expenses.get(id))
    expect(rec.a.v).toBe(4.5)
    expect(rec.a.s).toBeGreaterThan(T0 + 10)
    for (const m of [mergeDoc(u.doc, other).doc, mergeDoc(other, u.doc).doc]) {
      expect(must(m.expenses.get(id)).a.v).toBe(4.5)
    }
  })

  it('a field changed elsewhere in between is skipped and counted; the others are applied (T-011-3)', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const id = only(d).id
    const edit = updateExpense(d, mk(T0 + 10, c), id, { amount: 45, notes: 'to camp' })
    const elsewhere = updateExpense(edit.doc, mk(T0 + 15, { last: T0 + 10 }), id, {
      amount: 46,
    }).doc
    const u = undo(elsewhere, mk(T0 + 20, c), entry(edit))
    const rec = must(u.doc.expenses.get(id))
    expect(rec.a.v).toBe(46)
    expect(rec.o.v).toBeNull()
    expect(u.report).toEqual({ applied: 0, skipped: 1 })
  })

  it('the edit guard compares each field with ITS stamp, not the record max (newer untouched field)', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const id = only(d).id
    // the amount arrived from a device whose clock runs 3 days fast (beyond the 24 h follow cap)
    const ahead = updateExpense(d, mk(T0 + 3 * 86_400_000, { last: T0 }), id, { amount: 9 }).doc
    const edit = updateExpense(ahead, mk(T0 + 10, c), id, { notes: 'to camp' })
    expect(must(edit.doc.expenses.get(id)).o.s).toBeLessThan(must(edit.doc.expenses.get(id)).a.s)
    const u = undo(edit.doc, mk(T0 + 20, c), entry(edit))
    expect(must(u.doc.expenses.get(id)).o.v).toBeNull()
    expect(must(u.doc.expenses.get(id)).a.v).toBe(9)
    expect(u.report).toEqual({ applied: 1, skipped: 0 })
  })

  it('a merge-into undo counts per entry: rows recategorised elsewhere are skipped, the rest move back', () => {
    const c: Hlc = { last: 0 }
    let d: Doc = EMPTY_DOC
    for (const [i, name] of ['ramen', 'laksa', 'satay'].entries())
      d = addExpense(d, mk(T0 + i, c, i + 1), { itemName: name, amount: 5, category: 'Food' }).doc
    d = addExpense(d, mk(T0 + 5, c, 9), { itemName: 'udon', amount: 7, category: 'Meals' }).doc
    const merge = renameCategory(d, mk(T0 + 10, c), 'Food', 'Meals')
    const laksa = must([...merge.doc.expenses.values()].find((r) => r.n.v === 'laksa')).id
    const elsewhere = updateExpense(merge.doc, mk(T0 + 15, { last: T0 + 10 }), laksa, {
      category: 'Gym',
    }).doc
    const u = undo(elsewhere, mk(T0 + 20, c), entry(merge))
    const cats = [...u.doc.expenses.values()].map((r) => [r.n.v, r.c.v]).sort()
    expect(cats).toEqual([
      ['laksa', 'Gym'],
      ['ramen', 'Food'],
      ['satay', 'Food'],
      ['udon', 'Meals'],
    ])
    expect(u.report).toEqual({ applied: 2, skipped: 1 })
  })

  it('undo of a delete revives under a deterministic new id; the old id stays dead (T-011-1)', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const old = only(d)
    const del = deleteExpenses(d, mk(T0 + 10, c), [old.id])
    const other = del.doc
    const u = undo(del.doc, mk(T0 + 20, c), entry(del))
    const revived = only(u.doc)
    expect(revived.id).toMatch(new RegExp(`^${old.id}~r[0-9a-z]+$`))
    expect(u.doc.tombs.has(old.id)).toBe(true)
    expect([revived.n.v, revived.a.v, revived.c.v, revived.createdAt]).toEqual([
      old.n.v,
      old.a.v,
      old.c.v,
      old.createdAt,
    ])
    for (const m of [mergeDoc(u.doc, other).doc, mergeDoc(other, u.doc).doc])
      expect([...m.expenses.keys()]).toEqual([revived.id])
    // applying the same undo twice adds nothing
    const again = undo(u.doc, mk(T0 + 30, c), entry(del))
    expect(again.doc).toBe(u.doc)
    expect(again.report).toEqual({ applied: 0, skipped: 1 })
    // two devices undoing the same delete derive the same id
    const c2: Hlc = { last: 0 }
    expect(only(undo(del.doc, mk(T0 + 99, c2), entry(del)).doc).id).toBe(revived.id)
  })

  it('undo of delete-everywhere revives every row (§7.3)', () => {
    const c: Hlc = { last: 0 }
    let d: Doc = EMPTY_DOC
    for (let i = 0; i < 12; i++)
      d = addExpense(d, mk(T0 + i, c, i + 1), { itemName: `row ${i}`, amount: i + 1 }).doc
    const clear = deleteAllEverywhere(d, mk(T0 + 100, c))
    expect(clear.doc.expenses.size).toBe(0)
    const u = undo(clear.doc, mk(T0 + 200, c), entry(clear))
    expect(u.doc.expenses.size).toBe(12)
    expect(u.report).toEqual({ applied: 12, skipped: 0 })
  })

  it('undo of a 3,000-row clear is one batch: linear, every row back under its revive id', () => {
    const c: Hlc = { last: 0 }
    const records = new Map<string, ExpenseRec>()
    let d: Doc = EMPTY_DOC
    for (let i = 0; i < 3000; i++) {
      const r = addExpense(EMPTY_DOC, mk(T0 + i, c, i + 1), { itemName: `row ${i}`, amount: 1 })
      const rec = must(r.created)
      records.set(rec.id, rec)
    }
    d = { ...EMPTY_DOC, expenses: records }
    const clear = deleteAllEverywhere(d, mk(T0 + 9000, c))
    const u = undo(clear.doc, mk(T0 + 9001, c), entry(clear))
    expect(u.doc.expenses.size).toBe(3000)
    expect(u.report).toEqual({ applied: 3000, skipped: 0 })
    for (const id of records.keys()) expect(u.doc.tombs.has(id)).toBe(true)
  })

  it('undo of a rename to a new name redirects it back; undo of a merge moves only those rows back', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const ren = renameCategory(d, mk(T0 + 10, c), 'Food', 'Meals')
    const back = undo(ren.doc, mk(T0 + 20, c), entry(ren))
    expect(displayList(back.doc)).toEqual(['Food', 'Other'])
    expect(only(back.doc).c.v).toBe('Food')

    let two = addExpense(d, mk(T0 + 1, c, 2), {
      itemName: 'ramen',
      amount: 9,
      category: 'Meals',
    }).doc
    two = setBudget(two, mk(T0 + 2, c), 'Food', 300).doc
    const merge = renameCategory(two, mk(T0 + 10, c), 'Food', 'Meals')
    const undone = undo(merge.doc, mk(T0 + 20, c), entry(merge))
    const cats = [...undone.doc.expenses.values()].map((r) => [r.n.v, r.c.v]).sort()
    expect(cats).toEqual([
      ['chicken rice', 'Food'],
      ['ramen', 'Meals'],
    ])
    expect({ ...budgetView(undone.doc) }).toEqual({ Food: 300 })
  })

  it('a rename onto a renamed-away name re-adds it (budgets stay put); undo restores the table', () => {
    const c: Hlc = { last: 0 }
    let d = addCategory(EMPTY_DOC, mk(T0, c), 'Food').doc
    d = setBudget(d, mk(T0 + 1, c), 'Food', 400).doc
    d = addExpense(d, mk(T0 + 2, c, 2), { itemName: 'rice', amount: 5, category: 'Food' }).doc
    d = renameCategory(d, mk(T0 + 3, c), 'Food', 'Meals').doc
    d = addCategory(d, mk(T0 + 4, c), 'Drinks').doc
    d = addExpense(d, mk(T0 + 5, c, 3), { itemName: 'teh', amount: 1.5, category: 'Drinks' }).doc
    const catOf = (doc: Doc, name: string): string =>
      must([...doc.expenses.values()].find((r) => r.n.v === name)).c.v
    const r = renameCategory(d, mk(T0 + 6, c), 'Drinks', 'Food')
    expect(displayList(r.doc)).toEqual(['Food', 'Meals', 'Other'])
    expect({ ...budgetView(r.doc) }).toEqual({ Meals: 400 })
    expect([catOf(r.doc, 'rice'), catOf(r.doc, 'teh')]).toEqual(['Meals', 'Food'])
    const u = undo(r.doc, mk(T0 + 7, c), entry(r))
    expect(u.report?.skipped).toBe(0)
    // the old name points where it did before (a row still filed under it lands in Meals)
    expect(resolve(u.doc, 'Food')).toBe('Meals')
    expect([catOf(u.doc, 'rice'), catOf(u.doc, 'teh')]).toEqual(['Meals', 'Drinks'])
    expect(displayList(u.doc)).toEqual(['Meals', 'Drinks', 'Other'])
    expect({ ...budgetView(u.doc) }).toEqual({ Meals: 400 })
    expect(totalBudget(u.doc)).toBe(400)
    // re-added elsewhere since: the name is not sent back, and that part is counted as skipped
    const elsewhere = renameCategory(r.doc, mk(T0 + 8, { last: T0 + 7 }), 'Food', 'Cafe').doc
    const partial = undo(elsewhere, mk(T0 + 9, c), entry(r))
    expect(resolve(partial.doc, 'Food')).toBe('Cafe')
    expect(partial.report?.skipped).toBeGreaterThan(0)
  })

  it('undo of remove restores the category, its rows and its budget', () => {
    const c: Hlc = { last: 0 }
    let d = seeded(c)
    d = setBudget(d, mk(T0 + 1, c), 'Food', 120).doc
    const rm = removeCategory(d, mk(T0 + 10, c), 'Food')
    const u = undo(rm.doc, mk(T0 + 20, c), entry(rm))
    expect(only(u.doc).c.v).toBe('Food')
    expect({ ...budgetView(u.doc) }).toEqual({ Food: 120 })
  })

  it('a currency changed elsewhere since is skipped; a rename renamed again elsewhere is skipped', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const cur = setCurrency(d, mk(T0 + 7, c), 'EUR')
    const elsewhere = setCurrency(cur.doc, mk(T0 + 8, { last: T0 + 7 }), 'USD').doc
    const u = undo(elsewhere, mk(T0 + 9, c), entry(cur))
    expect(u.report).toEqual({ applied: 0, skipped: 1 })
    expect(must(u.doc.prefs.get('currency')).v).toBe('USD')
    const ren = renameCategory(d, mk(T0 + 10, c), 'Food', 'Meals')
    // the other device re-added Food meanwhile: the rename register is no longer ours
    const again = addCategory(ren.doc, mk(T0 + 11, { last: T0 + 10 }), 'Food').doc
    expect(undo(again, mk(T0 + 12, c), entry(ren)).report).toEqual({ applied: 0, skipped: 1 })
  })

  it('an entry mixing register and record items applies each run in reverse order', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const cur = setCurrency(d, mk(T0 + 1, c), 'EUR')
    const add = addExpense(cur.doc, mk(T0 + 2, c, 7), { itemName: 'kopi', amount: 1.8 })
    const mixed = { ...entry(add), items: [...entry(cur).items, ...entry(add).items] }
    const u = undo(add.doc, mk(T0 + 3, c), mixed)
    expect(u.report).toEqual({ applied: 2, skipped: 0 })
    expect(u.doc.expenses.size).toBe(1)
    expect(must(u.doc.prefs.get('currency')).v).toBeNull()
  })

  it('budget and currency undo are guarded register writes', () => {
    const c: Hlc = { last: 0 }
    let d = seeded(c)
    const set = setBudget(d, mk(T0 + 1, c), 'Food', 300)
    expect({ ...budgetView(undo(set.doc, mk(T0 + 2, c), entry(set)).doc) }).toEqual({})
    d = set.doc
    const rm = removeBudget(d, mk(T0 + 3, c), 'Food')
    expect({ ...budgetView(undo(rm.doc, mk(T0 + 4, c), entry(rm)).doc) }).toEqual({ Food: 300 })
    const changedElsewhere = setBudget(rm.doc, mk(T0 + 5, { last: T0 + 3 }), 'Food', 99).doc
    const skipped = undo(changedElsewhere, mk(T0 + 6, c), entry(rm))
    expect(skipped.report).toEqual({ applied: 0, skipped: 1 })
    const cur = setCurrency(d, mk(T0 + 7, c), 'EUR')
    const back = undo(cur.doc, mk(T0 + 8, c), entry(cur))
    expect(must(back.doc.prefs.get('currency')).v).toBeNull()
  })

  it('undo of a merge-into skips a row re-filed elsewhere since, even under the same name', () => {
    const c: Hlc = { last: 0 }
    let d = seeded(c)
    const id = only(d).id
    d = addCategory(d, mk(T0 + 1, c), 'Meals').doc
    const merged = renameCategory(d, mk(T0 + 2, c), 'Food', 'Meals')
    // a device that never saw the merge files the row under Meals itself, at a newer stamp
    const other = updateExpense(d, mk(T0 + 3, { last: T0 + 2 }), id, { category: 'Meals' }).doc
    const both = mergeDoc(merged.doc, other).doc
    expect(only(both).c).toEqual({ v: 'Meals', s: T0 + 3, r: 2 })
    const u = undo(both, mk(T0 + 4, c), entry(merged))
    expect(u.report).toEqual({ applied: 0, skipped: 1 })
    expect(only(u.doc).c).toBe(only(both).c)
    expect(displayList(u.doc)).toContain('Food')
  })

  it('undo of a delete whose every revive id is taken is skipped and counted, never forced', () => {
    const c: Hlc = { last: 0 }
    const d = seeded(c)
    const rec = only(d)
    const del = deleteExpenses(d, mk(T0 + 1, c), [rec.id])
    const first = must(reviveId(rec, 'Food', () => false))
    const used = [first, ...Array.from({ length: 998 }, (_, i) => `${first}.${String(i + 2)}`)]
    const full: Doc = {
      ...del.doc,
      tombs: new Map([...del.doc.tombs, ...used.map((id) => [id, T0] as const)]),
    }
    const u = undo(full, mk(T0 + 2, c), entry(del))
    expect(u.doc).toBe(full)
    expect(u.report).toEqual({ applied: 0, skipped: 1 })
  })
})
