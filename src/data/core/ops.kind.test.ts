// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0 } from '../__tests__/support/gen'
import { must, parseJson } from '../__tests__/support/must'
import { makeRng } from '../__tests__/support/rng'
import { mappingLookup } from './categories'
import { KIND_INCOME, KIND_KEY, OTHER, nullRecord } from './constants'
import { EMPTY_DOC, mergeDoc } from './doc'
import { contentKey } from './ids'
import { OpError, addExpense, undo, updateExpense } from './ops'
import { editRecord, encodeRecord } from './record'
import type { Doc, ExpenseRec, Extras, Hlc, Json, OpCtx } from './types'
import { decodeWire, wireString } from './wire'

// T8c, money in: the kind of an entry lives in its extras register (`x`), the register every v5
// version keeps verbatim for fields it does not know. No wire, merge or file change.

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

function extras(pairs: Readonly<Record<string, Json>>): Extras {
  const out = nullRecord<Json>()
  for (const k of Object.keys(pairs).sort()) {
    Object.defineProperty(out, k, { value: pairs[k], enumerable: true })
  }
  return Object.freeze(out)
}

/** `rec` with these extras, as a newer version would have written them (stamp kept). */
const withExtras = (doc: Doc, rec: ExpenseRec, x: Extras): Doc => ({
  ...doc,
  expenses: new Map(doc.expenses).set(rec.id, { ...rec, x: { ...rec.x, v: x } }),
})

describe('addExpense with a kind (T8c)', () => {
  it('an income is a record like any other, marked in its extras and filed nowhere', () => {
    const r = addExpense(EMPTY_DOC, mk(), { itemName: 'Allowance', amount: 790, kind: 'income' })
    const rec = must(r.created)
    expect(kindOf(rec)).toBe(KIND_INCOME)
    expect(Object.keys(rec.x.v)).toEqual([KIND_KEY])
    expect(rec.x).toMatchObject({ s: rec.C, r: 2 })
    expect(rec.c.v).toBe(OTHER)
    expect(rec.a.v).toBe(790)
    // Other is listed by its first entry, as an expense filed there would list it
    expect(r.touched).toEqual([
      [`ex:${rec.id}`, rec.C],
      [`cat:${OTHER}`, rec.C],
    ])
    expect(r.undo?.label).toBe('Added "Allowance"')
  })

  it('an expense, with the kind left out or named, carries no extras at all', () => {
    const plain = must(addExpense(EMPTY_DOC, mk(), { itemName: 'kopi', amount: 1.8 }).created)
    const named = must(
      addExpense(EMPTY_DOC, mk(), { itemName: 'kopi', amount: 1.8, kind: 'expense' }).created,
    )
    expect(Object.keys(plain.x.v)).toEqual([])
    expect(Object.keys(named.x.v)).toEqual([])
    expect(encodeRecord(named)).toEqual(encodeRecord(plain))
  })

  it('an income takes no category: not the one given, not the one learned, and teaches none', () => {
    const c: Hlc = { last: 0 }
    const learned = addExpense(EMPTY_DOC, mk(T0, c), {
      itemName: 'Carousell',
      amount: 20,
      category: 'Shopping',
    }).doc
    expect(mappingLookup(learned, 'Carousell')).toBe('Shopping')
    const r = addExpense(learned, mk(T0 + 1, c, 2), {
      itemName: 'Carousell',
      amount: 200,
      category: 'Food',
      kind: 'income',
    })
    expect(must(r.created).c.v).toBe(OTHER)
    expect(mappingLookup(r.doc, 'Carousell')).toBe('Shopping')
    expect(r.touched.some(([k]) => k.startsWith('map:'))).toBe(false)
    // a name no expense has used learns nothing from an income either
    const fresh = addExpense(EMPTY_DOC, mk(), { itemName: 'Pay', amount: 1, kind: 'income' })
    expect(mappingLookup(fresh.doc, 'Pay')).toBeNull()
  })

  it('refuses a kind it does not write', () => {
    const add = (kind: unknown): string =>
      code(() =>
        addExpense(EMPTY_DOC, mk(), {
          itemName: 'x',
          amount: 1,
          // what a caller outside the types could send
          kind: kind as 'income',
        }),
      )
    expect(add('transfer')).toBe('kind')
    expect(add('')).toBe('kind')
    expect(add(1)).toBe('kind')
    expect(add(null)).toBe('kind')
    expect(add('income')).toBe('no-throw')
  })

  it('amounts keep their rule: an income is a positive amount too', () => {
    const add = (amount: number): string =>
      code(() => addExpense(EMPTY_DOC, mk(), { itemName: 'x', amount, kind: 'income' }))
    expect(add(-5)).toBe('amount')
    expect(add(0)).toBe('amount')
  })

  it('survives the wire as a top-level field of its record, and comes back the same record', () => {
    const doc = addExpense(EMPTY_DOC, mk(), {
      itemName: 'Allowance',
      amount: 790,
      kind: 'income',
    }).doc
    const rec = only(doc)
    expect(encodeRecord(rec)[KIND_KEY]).toBe(KIND_INCOME)
    const back = only(overWire(doc))
    expect(back).toEqual(rec)
  })

  it('undo of the add deletes it', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Pay', amount: 5, kind: 'income' })
    const back = undo(r.doc, mk(T0 + 1, c), must(r.undo))
    expect(back.doc.expenses.size).toBe(0)
  })

  it('an income and an expense that otherwise match are different entries', () => {
    const c: Hlc = { last: 0 }
    const a = must(addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Pay', amount: 5 }).created)
    const b = must(
      addExpense(EMPTY_DOC, mk(T0, c, 2), { itemName: 'Pay', amount: 5, kind: 'income' }).created,
    )
    expect(contentKey(a, a.c.v)).not.toBe(contentKey(b, b.c.v))
  })
})

describe('updateExpense with a kind (T8c)', () => {
  const seeded = (c: Hlc): Doc =>
    addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Sold bike', amount: 200, category: 'Shopping' })
      .doc

  it('stamps only the extras register; the category and every other field stay as they were', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const before = only(doc)
    const r = updateExpense(doc, mk(T0 + 10, c), before.id, { kind: 'income' })
    const after = only(r.doc)
    expect(kindOf(after)).toBe(KIND_INCOME)
    expect(after.x.s).toBeGreaterThan(before.x.s)
    expect(after.x.r).toBe(2)
    for (const f of ['n', 'a', 'c', 'd', 'o'] as const) expect(after[f]).toBe(before[f])
    expect(after.c.v).toBe('Shopping')
    expect(r.touched).toEqual([[`ex:${before.id}`, after.x.s]])
  })

  it('the same kind again changes nothing; back to an expense removes the key', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const id = only(doc).id
    expect(updateExpense(doc, mk(T0 + 1, c), id, { kind: 'expense' }).doc).toBe(doc)
    const income = updateExpense(doc, mk(T0 + 2, c), id, { kind: 'income' }).doc
    expect(updateExpense(income, mk(T0 + 3, c), id, { kind: 'income' }).doc).toBe(income)
    const again = only(updateExpense(income, mk(T0 + 4, c), id, { kind: 'expense' }).doc)
    expect(Object.keys(again.x.v)).toEqual([])
    expect(again.x.s).toBeGreaterThan(only(income).x.s)
  })

  it('undo puts the earlier kind back; an edit of another field made since is kept', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const id = only(doc).id
    const r = updateExpense(doc, mk(T0 + 1, c), id, { kind: 'income' })
    const edited = updateExpense(r.doc, mk(T0 + 2, c), id, { amount: 250 }).doc
    const back = undo(edited, mk(T0 + 3, c), must(r.undo))
    expect(Object.keys(only(back.doc).x.v)).toEqual([])
    expect(only(back.doc).a.v).toBe(250)
    expect(back.report).toEqual({ applied: 1, skipped: 0 })
  })

  it('keeps every field a newer version put in the extras', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const rec = only(doc)
    const carried = withExtras(doc, rec, extras({ tag: 'trip', zz: [1, 2] }))
    const income = only(updateExpense(carried, mk(T0 + 1, c), rec.id, { kind: 'income' }).doc)
    expect(income.x.v).toEqual({ kind: 'income', tag: 'trip', zz: [1, 2] })
    expect(Object.keys(income.x.v)).toEqual(['kind', 'tag', 'zz'])
    const back = only(
      updateExpense({ ...carried, expenses: new Map([[rec.id, income]]) }, mk(T0 + 2, c), rec.id, {
        kind: 'expense',
      }).doc,
    )
    expect(back.x.v).toEqual({ tag: 'trip', zz: [1, 2] })
  })

  it('refuses a kind it does not write, and a change the wire would drop', () => {
    const c: Hlc = { last: 0 }
    const doc = seeded(c)
    const rec = only(doc)
    const set = (d: Doc, kind: unknown): string =>
      code(() => updateExpense(d, mk(T0 + 1, c), rec.id, { kind: kind as 'income' }))
    expect(set(doc, 'transfer')).toBe('kind')
    // sixteen extras already: a seventeenth key would be dropped on the next decode
    const full = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${String(i)}`, i]))
    const crowded = withExtras(doc, rec, extras(full))
    expect(set(crowded, 'income')).toBe('kind')
    expect(only(overWire(crowded)).x.v).toEqual(full)
    // and the proof of that limit: written past the op, the last key in order is lost on the way
    const past = withExtras(doc, rec, extras({ ...full, kind: 'income' }))
    expect(Object.keys(only(overWire(past)).x.v)).toHaveLength(16)
  })

  it('a corrected category on an income teaches nothing', () => {
    const c: Hlc = { last: 0 }
    const r = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Pay', amount: 5, kind: 'income' })
    const id = must(r.created).id
    const next = updateExpense(r.doc, mk(T0 + 1, c), id, { category: 'Food' }).doc
    expect(only(next).c.v).toBe('Food')
    expect(mappingLookup(next, 'Pay')).toBeNull()
  })
})

describe('a kind across two devices and versions (T8c)', () => {
  it('a kind set here and an amount edited there are both kept, whichever way they merge', () => {
    const base = addExpense(EMPTY_DOC, mk(T0, { last: 0 }), { itemName: 'Pay', amount: 5 }).doc
    const id = only(base).id
    const here = updateExpense(base, mk(T0 + 10, { last: T0 }), id, { kind: 'income' }).doc
    const there = updateExpense(base, mk(T0 + 20, { last: T0 }), id, { amount: 6 }).doc
    for (const merged of [mergeDoc(here, there).doc, mergeDoc(there, here).doc]) {
      expect(kindOf(only(merged))).toBe(KIND_INCOME)
      expect(only(merged).a.v).toBe(6)
    }
  })

  it('two kinds written apart: the later one wins on both sides', () => {
    const base = addExpense(EMPTY_DOC, mk(T0, { last: 0 }), { itemName: 'Pay', amount: 5 }).doc
    const id = only(base).id
    const income = updateExpense(base, mk(T0 + 10, { last: T0 }), id, { kind: 'income' }).doc
    const later = updateExpense(income, mk(T0 + 30, { last: T0 + 10 }), id, { kind: 'expense' }).doc
    expect(Object.keys(only(mergeDoc(income, later).doc).x.v)).toEqual([])
    expect(Object.keys(only(mergeDoc(later, income).doc).x.v)).toEqual([])
  })

  // What 0.10 to 0.18 do with it: they read the record off the wire, edit the fields they know
  // (their editRecord never touches `x`), and write it back.
  it('a version that does not know the kind keeps it through its own edit and push', () => {
    const c: Hlc = { last: 0 }
    const doc = addExpense(EMPTY_DOC, mk(T0, c), {
      itemName: 'Allowance',
      amount: 790,
      kind: 'income',
    }).doc
    const old = only(overWire(doc))
    const edited = editRecord(old, { a: 800 }, mk(T0 + 60_000, { last: T0 }))
    const pushed: Doc = { ...doc, expenses: new Map([[edited.id, edited]]) }
    const home = only(mergeDoc(doc, overWire(pushed)).doc)
    expect(kindOf(home)).toBe(KIND_INCOME)
    expect(home.a.v).toBe(800)
  })

  it('a kind this version does not know is kept as it is by an edit of another field', () => {
    const c: Hlc = { last: 0 }
    const doc = addExpense(EMPTY_DOC, mk(T0, c), { itemName: 'Shopee', amount: 25 }).doc
    const rec = only(doc)
    const newer = withExtras(doc, rec, extras({ kind: 'transfer' }))
    const edited = only(updateExpense(newer, mk(T0 + 1, c), rec.id, { amount: 26 }).doc)
    expect(kindOf(edited)).toBe('transfer')
    expect(kindOf(only(overWire({ ...newer, expenses: new Map([[rec.id, edited]]) })))).toBe(
      'transfer',
    )
  })
})
