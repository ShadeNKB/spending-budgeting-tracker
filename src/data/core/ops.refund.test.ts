// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0 } from '../__tests__/support/gen'
import { must, parseJson } from '../__tests__/support/must'
import { makeRng } from '../__tests__/support/rng'
import { mappingLookup } from './categories'
import { KIND_KEY, KIND_REFUND, OTHER } from './constants'
import { EMPTY_DOC, mergeDoc } from './doc'
import { contentKey } from './ids'
import { OpError, addExpense, undo, updateExpense } from './ops'
import { editRecord, encodeRecord } from './record'
import type { Doc, ExpenseRec, Hlc, Json, OpCtx } from './types'
import { decodeWire, wireString } from './wire'

// Refunds (F-058, second slice): money back for something paid for. A refund is a record like an
// expense, category and all, marked `kind: "refund"` in its extras register. Its amount stays
// positive: the sums count it below zero, the record does not.

const mk = (wall = T0, clock: Hlc = { last: 0 }, seed = 1): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(seed).next,
})

const code = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof OpError) return e.code
    throw e
  }
  return 'no-throw'
}

const only = (doc: Doc): ExpenseRec => must([...doc.expenses.values()][0])
const kindOf = (rec: ExpenseRec): Json | undefined => rec.x.v[KIND_KEY]
const overWire = (doc: Doc): Doc => decodeWire(parseJson(wireString(doc)), 'remote').doc

describe('addExpense: a refund', () => {
  it('is filed in the category it comes off, marked in its extras, with a positive amount', () => {
    const r = addExpense(EMPTY_DOC, mk(), {
      itemName: 'Returned shoes',
      amount: 89.9,
      category: 'Shopping',
      kind: 'refund',
    })
    const rec = must(r.created)
    expect(kindOf(rec)).toBe(KIND_REFUND)
    expect(Object.keys(rec.x.v)).toEqual([KIND_KEY])
    expect(rec.c.v).toBe('Shopping')
    expect(rec.a.v).toBe(89.9)
    expect(r.undo?.label).toBe('Added "Returned shoes"')
  })

  it('with no category given takes the one its name has learned, else Other', () => {
    const c: Hlc = { last: 0 }
    const learned = addExpense(EMPTY_DOC, mk(T0, c), {
      itemName: 'Shoes',
      amount: 89.9,
      category: 'Shopping',
    }).doc
    const r = addExpense(learned, mk(T0 + 1, c, 2), {
      itemName: 'Shoes',
      amount: 89.9,
      kind: 'refund',
    })
    expect(must(r.created).c.v).toBe('Shopping')
    const fresh = addExpense(EMPTY_DOC, mk(), {
      itemName: 'Deposit back',
      amount: 50,
      kind: 'refund',
    })
    expect(must(fresh.created).c.v).toBe(OTHER)
  })

  it('teaches its name the category, as an expense does: the choice is the owner’s own', () => {
    const r = addExpense(EMPTY_DOC, mk(), {
      itemName: 'Dinner split',
      amount: 30,
      category: 'Food',
      kind: 'refund',
    })
    expect(mappingLookup(r.doc, 'Dinner split')).toBe('Food')
  })

  it('keeps the amount rule: money back is entered above zero', () => {
    const add = (amount: number): string =>
      code(() => addExpense(EMPTY_DOC, mk(), { itemName: 'x', amount, kind: 'refund' }))
    expect(add(-5)).toBe('amount')
    expect(add(0)).toBe('amount')
    expect(add(5)).toBe('no-throw')
  })

  it('survives the wire as a top-level field of its record, and comes back the same record', () => {
    const doc = addExpense(EMPTY_DOC, mk(), {
      itemName: 'Returned shoes',
      amount: 89.9,
      category: 'Shopping',
      kind: 'refund',
    }).doc
    const rec = only(doc)
    const wire = encodeRecord(rec)
    expect(wire[KIND_KEY]).toBe(KIND_REFUND)
    // what every version reads as the amount is the amount typed: no sign on the wire
    expect(wire.amount).toBe(89.9)
    expect(only(overWire(doc))).toEqual(rec)
  })

  it('a refund and an expense that otherwise match are different entries', () => {
    const c: Hlc = { last: 0 }
    const input = { itemName: 'Shoes', amount: 89.9, category: 'Shopping' }
    const a = must(addExpense(EMPTY_DOC, mk(T0, c), input).created)
    const b = must(addExpense(EMPTY_DOC, mk(T0, c, 2), { ...input, kind: 'refund' }).created)
    expect(contentKey(a, a.c.v)).not.toBe(contentKey(b, b.c.v))
  })

  it('undo of the add deletes it', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Shoes', amount: 5, kind: 'refund' })
    expect(undo(r.doc, mk(T0 + 1, c), must(r.undo)).doc.expenses.size).toBe(0)
  })
})

describe('updateExpense: to a refund and back', () => {
  const seeded = (c: Hlc): Doc =>
    addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Shoes', amount: 89.9, category: 'Shopping' }).doc

  it('an expense made a refund keeps its category: only the extras register is stamped', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const before = only(doc)
    const r = updateExpense(doc, mk(T0 + 10, c), before.id, { kind: 'refund' })
    const after = only(r.doc)
    expect(kindOf(after)).toBe(KIND_REFUND)
    for (const f of ['n', 'a', 'c', 'd', 'o'] as const) expect(after[f]).toBe(before[f])
    expect(r.touched).toEqual([[`ex:${before.id}`, after.x.s]])
    const back = only(updateExpense(r.doc, mk(T0 + 20, c), before.id, { kind: 'expense' }).doc)
    expect(Object.keys(back.x.v)).toEqual([])
    expect(back.c.v).toBe('Shopping')
  })

  it('an income made a refund takes the category sent with it, in the same edit', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'From Sam', amount: 30, kind: 'income' })
    const id = must(r.created).id
    expect(must(r.created).c.v).toBe(OTHER)
    const next = updateExpense(r.doc, mk(T0 + 1, c), id, { kind: 'refund', category: 'Food' })
    const rec = only(next.doc)
    expect(kindOf(rec)).toBe(KIND_REFUND)
    expect(rec.c.v).toBe('Food')
    // one Undo takes back both
    const back = only(undo(next.doc, mk(T0 + 2, c), must(next.undo)).doc)
    expect(kindOf(back)).toBe('income')
    expect(back.c.v).toBe(OTHER)
  })

  it('a corrected category on a refund is learned, as on an expense', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Lazada', amount: 12, kind: 'refund' })
    const next = updateExpense(r.doc, mk(T0 + 1, c), must(r.created).id, { category: 'Shopping' })
    expect(mappingLookup(next.doc, 'Lazada')).toBe('Shopping')
  })
})

describe('a refund across two devices and versions', () => {
  it('made a refund here and its amount edited there: both are kept, whichever way they merge', () => {
    const base = addExpense(EMPTY_DOC, mk(T0, { last: 0 }), {
      itemName: 'Shoes',
      amount: 89.9,
      category: 'Shopping',
    }).doc
    const id = only(base).id
    const here = updateExpense(base, mk(T0 + 10, { last: T0 }), id, { kind: 'refund' }).doc
    const there = updateExpense(base, mk(T0 + 20, { last: T0 }), id, { amount: 80 }).doc
    for (const merged of [mergeDoc(here, there).doc, mergeDoc(there, here).doc]) {
      expect(kindOf(only(merged))).toBe(KIND_REFUND)
      expect(only(merged).a.v).toBe(80)
      expect(only(merged).c.v).toBe('Shopping')
    }
  })

  // What 0.10 to 0.19 do with it: they read the record off the wire, edit the fields they know
  // (their editRecord never touches `x` unless the kind switch is moved), and write it back.
  it('a version that does not know refunds keeps one through its own edit and push', () => {
    const c: Hlc = { last: 0 }
    const doc = addExpense(EMPTY_DOC, mk(T0, c), {
      itemName: 'Shoes',
      amount: 89.9,
      category: 'Shopping',
      kind: 'refund',
    }).doc
    const old = only(overWire(doc))
    const edited = editRecord(old, { a: 80, c: 'Clothes' }, mk(T0 + 60_000, { last: T0 }))
    const pushed: Doc = { ...doc, expenses: new Map([[edited.id, edited]]) }
    const home = only(mergeDoc(doc, overWire(pushed)).doc)
    expect(kindOf(home)).toBe(KIND_REFUND)
    expect(home.a.v).toBe(80)
    expect(home.c.v).toBe('Clothes')
  })
})
