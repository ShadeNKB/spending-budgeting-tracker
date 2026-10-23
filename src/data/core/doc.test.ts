// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DAY,
  HOUR,
  T0,
  docOf,
  extrasOf,
  freezeDoc,
  genDoc,
  genRecord,
} from '../__tests__/support/gen'
import { must } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { displayList } from './categories'
import {
  EMPTY_DOC,
  deriveExpenses,
  digestDoc,
  docsEqual,
  joinDevice,
  joinMap,
  joinPref,
  joinRename,
  joinTomb,
  keyUnion,
  maxStampDoc,
  mergeDoc,
  recordsJsonOf,
  sortedIdsOf,
} from './doc'
import { FNV_A, FNV_B, canon, fnvLane, hex8 } from './hash'
import {
  OpError,
  addExpense,
  deleteAllEverywhere,
  deleteExpenses,
  renameCategory,
  updateExpense,
} from './ops'
import { addRecord, editRecord, encodeRecord, maxStampRec, recordString } from './record'
import type { Doc, ExpenseRec, Hlc, OpCtx } from './types'

const ctx = (wall: number, clock: Hlc): OpCtx => ({ wall, clock, dev: 'd', rng: makeRng(1).next })
const kopi = (clock: Hlc, wall = T0): ExpenseRec =>
  addRecord(
    'e1',
    { n: 'chicken rice', a: 4.5, c: 'Food', day: '2026-10-18', o: null },
    ctx(wall, clock),
  )

/** A structural copy: same content, new objects everywhere (what a decoded pull looks like). */
function copyDoc(d: Doc): Doc {
  const copyRec = (r: ExpenseRec): ExpenseRec => ({
    ...r,
    n: { ...r.n },
    a: { ...r.a },
    c: { ...r.c },
    d: { ...r.d },
    o: { ...r.o },
    x: { ...r.x },
  })
  return {
    expenses: new Map([...d.expenses].map(([k, r]) => [k, copyRec(r)])),
    tombs: new Map(d.tombs),
    categories: [...d.categories],
    renames: new Map([...d.renames].map(([k, v]) => [k, { ...v }])),
    mappings: new Map([...d.mappings].map(([k, v]) => [k, { ...v }])),
    budgets: new Map([...d.budgets].map(([k, v]) => [k, { ...v }])),
    prefs: new Map([...d.prefs].map(([k, v]) => [k, { ...v }])),
    devices: new Map([...d.devices].map(([k, v]) => [k, { ...v }])),
  }
}

describe('mergeDoc identity and no-churn (§6.1, §6.9, T-002-2)', HEAVY, () => {
  it('merge(a, EMPTY).doc === a and merging an unchanged remote returns a itself', () => {
    const r = makeRng(7)
    for (let i = 0; i < 300; i++) {
      const a = mergeDoc(genDoc(r), genDoc(r)).doc
      expect(mergeDoc(a, EMPTY_DOC).doc).toBe(a)
      expect(mergeDoc(a, a).doc).toBe(a)
      const m = mergeDoc(a, copyDoc(a))
      expect(m.doc).toBe(a)
      expect(m.removed).toEqual([])
      expect(m.replaced).toEqual([])
    }
  })

  it('keeps every untouched collection and record object when one record changes', () => {
    const c: Hlc = { last: 0 }
    const e1 = kopi(c)
    const e2 = { ...kopi(c), id: 'e2' }
    const L = docOf({
      expenses: [e1, e2],
      categories: ['Food'],
      mappings: [['kopi', { v: 'Food', s: T0 }]],
    })
    const R = copyDoc(L)
    const edited = editRecord(must(R.expenses.get('e2')), { a: 9 }, ctx(T0 + 5000, c))
    const R2: Doc = { ...R, expenses: new Map([...R.expenses, ['e2', edited]]) }
    const m = mergeDoc(L, R2)
    expect(m.doc).not.toBe(L)
    expect(m.doc.expenses.get('e1')).toBe(e1)
    expect(recordString(must(m.doc.expenses.get('e2')))).toBe(recordString(edited))
    expect(m.doc.categories).toBe(L.categories)
    expect(m.doc.mappings).toBe(L.mappings)
    expect(m.doc.tombs).toBe(L.tombs)
    expect(m.replaced.map((x) => [x.before.id, x.fields])).toEqual([['e2', ['a']]])
  })
})

describe('mergeDoc semantics', HEAVY, () => {
  it('absence is never deletion; only tombstones remove, and every removal is reported', () => {
    const c: Hlc = { last: 0 }
    const e1 = kopi(c)
    const L = docOf({ expenses: [e1] })
    expect(mergeDoc(L, EMPTY_DOC).doc.expenses.has('e1')).toBe(true)
    expect(mergeDoc(L, docOf({ categories: ['Food'] })).doc.expenses.has('e1')).toBe(true)
    const killed = mergeDoc(L, docOf({ tombs: [['e1', 0]] }))
    expect(killed.doc.expenses.has('e1')).toBe(false)
    expect(killed.removed).toEqual([e1])
    expect(killed.doc.tombs.get('e1')).toBe(0)
  })

  it('a copy edited after its known deletion is reported as edit-after-delete', () => {
    const c: Hlc = { last: 0 }
    const e1 = kopi(c)
    const later = editRecord(e1, { a: 5 }, ctx(T0 + HOUR, c))
    const m = mergeDoc(docOf({ tombs: [['e1', T0 + 1000]] }), docOf({ expenses: [later] }))
    expect(m.editAfterDelete).toEqual([later])
    expect(m.doc.expenses.size).toBe(0)
    const unknownTime = mergeDoc(docOf({ tombs: [['e1', 0]] }), docOf({ expenses: [later] }))
    expect(unknownTime.editAfterDelete).toEqual([])
  })

  it('judge probe core form: rename on A after B offline amount edit gives [45, Meals]', () => {
    const ca: Hlc = { last: 0 }
    const cb: Hlc = { last: 0 }
    const x = kopi(ca)
    const b = editRecord(x, { a: 45 }, ctx(T0 + HOUR, cb))
    const A = docOf({
      expenses: [{ ...x, c: { ...x.c, v: 'Meals' } }],
      categories: ['Food', 'Meals'],
      renames: [
        ['Food', { to: 'Meals', s: T0 + 3 * DAY }],
        ['Meals', { to: null, s: T0 + 3 * DAY }],
      ],
    })
    const B = docOf({ expenses: [b], categories: ['Food'] })
    for (const m of [mergeDoc(A, B).doc, mergeDoc(B, A).doc]) {
      const e = must(m.expenses.get('e1'))
      expect([e.a.v, e.c.v]).toEqual([45, 'Meals'])
      expect(e.c.s).toBe(x.c.s) // never re-stamped
    }
    // materialisation alone is not a loss
    expect(mergeDoc(B, A).replaced.flatMap((r) => r.fields)).toEqual([])
  })

  it('collection joins are total orders (commutative, idempotent) and return an input', () => {
    expect(joinTomb(0, 5)).toBe(5)
    expect(joinTomb(7, 5)).toBe(5)
    expect(joinTomb(0, 0)).toBe(0)
    const a = { to: 'Meals', s: 5 }
    const b = { to: null, s: 5 }
    expect(joinRename(a, b)).toBe(b)
    expect(joinRename(b, a)).toBe(b)
    expect(joinRename({ to: 'A', s: 5 }, { to: 'B', s: 5 }).to).toBe('B')
    expect(joinRename({ to: 'A', s: 6 }, b).to).toBe('A')
    expect(joinMap({ v: 'A', s: 1 }, { v: 'B', s: 1 }).v).toBe('B')
    expect(joinPref({ v: 'SGD', s: 1 }, { v: 'EUR', s: 1 }).v).toBe('SGD')
    const d1 = { name: 'Phone', app: '0.9.0', mode: 'table' as const, e2e: false, seen: 5 }
    const d2 = { ...d1, app: '0.9.1' }
    expect(joinDevice(d1, d2)).toBe(joinDevice(d2, d1))
    const m = new Map([['k', 1]])
    expect(keyUnion(m, new Map([['k', 1]]), joinTomb)).toBe(m)
    expect(keyUnion(new Map<string, number>(), m, joinTomb)).toBe(m)
  })

  it('never mutates its inputs (deep-frozen docs, maps that throw on mutation)', () => {
    const r = makeRng(9)
    for (let i = 0; i < 300; i++) {
      const a = freezeDoc(genDoc(r))
      const b = freezeDoc(genDoc(r))
      expect(() => mergeDoc(a, b)).not.toThrow()
    }
  })
})

/** A zone-independent record (fixed date text) for golden pins. */
function fixedRec(): ExpenseRec {
  const reg = <T>(v: T): { v: T; s: number; r: 2 } => ({ v, s: T0, r: 2 })
  return {
    id: 'e1',
    createdAt: '2026-10-19T08:00:00.000Z',
    C: T0,
    n: reg('chicken rice'),
    a: reg(4.5),
    c: reg('Food'),
    d: reg({ date: '2026-10-18T04:00:00.000Z', day: '2026-10-18' }),
    o: reg(null),
    x: reg(extrasOf({})),
  }
}

describe('digestDoc (P-13, golden: persisted in the envelope)', HEAVY, () => {
  it('pins EMPTY_DOC and two fixed docs', () => {
    expect(digestDoc(EMPTY_DOC)).toBe('0cbd116d4d1cf5d9')
    const one = docOf({ expenses: [fixedRec()], categories: ['Food', 'Other'] })
    expect(digestDoc(one)).toBe('d42460e6e261035c')
    const two = docOf({
      expenses: [fixedRec()],
      tombs: [
        ['old1', 0],
        ['old2', T0],
      ],
      categories: ['Other', 'Food'],
      renames: [
        ['Food', { to: 'Meals', s: T0 }],
        ['Meals', { to: null, s: T0 }],
      ],
      mappings: [['chicken rice', { v: 'Food', s: 0 }]],
      budgets: [['Food', { value: 300, set: T0, del: 0 }]],
      prefs: [['currency', { v: 'SGD', s: T0 }]],
    })
    expect(digestDoc(two)).toBe('25f6975ecaf23c4e')
  })

  it('is independent of insertion order and of devices[*].seen', () => {
    const r = makeRng(3)
    for (let i = 0; i < 200; i++) {
      const d = genDoc(r)
      const shuffled: Doc = {
        ...d,
        expenses: new Map(r.shuffle([...d.expenses])),
        tombs: new Map(r.shuffle([...d.tombs])),
        categories: r.shuffle(d.categories),
        renames: new Map(r.shuffle([...d.renames])),
        mappings: new Map(r.shuffle([...d.mappings])),
        budgets: new Map(r.shuffle([...d.budgets])),
        prefs: new Map(r.shuffle([...d.prefs])),
        devices: new Map([...d.devices].map(([k, v]) => [k, { ...v, seen: v.seen + 1 }])),
      }
      expect(digestDoc(shuffled)).toBe(digestDoc(d))
      expect(docsEqual(shuffled, d)).toBe(true)
    }
  })

  it('changes with any record byte and with any collection', () => {
    const c: Hlc = { last: 0 }
    const base = docOf({ expenses: [kopi(c)] })
    const edited = docOf({
      expenses: [editRecord(kopi({ last: 0 }), { a: 5 }, ctx(T0 + 1, { last: 0 }))],
    })
    expect(digestDoc(edited)).not.toBe(digestDoc(base))
    expect(digestDoc({ ...base, tombs: new Map([['x', 0]]) })).not.toBe(digestDoc(base))
    expect(digestDoc({ ...base, categories: ['Gym'] })).not.toBe(digestDoc(base))
  })
})

describe('maxStampDoc', HEAVY, () => {
  it('is the largest stamp anywhere except devices[*].seen', () => {
    expect(maxStampDoc(EMPTY_DOC)).toBe(0)
    const r = genRecord(makeRng(1), 'e1', [T0])
    const d = docOf({ expenses: [r], budgets: [['Food', { value: 1, set: 0, del: T0 + 9 * DAY }]] })
    expect(maxStampDoc(d)).toBe(T0 + 9 * DAY)
    expect(
      maxStampDoc({
        ...d,
        devices: new Map([
          ['x', { name: 'P', app: '1', mode: 'table', e2e: false, seen: T0 + 99 * DAY }],
        ]),
      }),
    ).toBe(T0 + 9 * DAY)
    expect(recordString(r).length).toBeGreaterThan(0)
  })
})

/** P-13 recomputed from its definition with nothing cached per collection (records via JSON). */
function referenceDigest(doc: Doc): string {
  let ra = 0
  let rb = 0
  for (const rec of doc.expenses.values()) {
    const s = JSON.stringify(encodeRecord(rec))
    ra = (ra + fnvLane(s, FNV_A)) >>> 0
    rb = (rb + fnvLane(s, FNV_B)) >>> 0
  }
  const sorted = <V>(m: ReadonlyMap<string, V>): [string, V][] =>
    [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const rest = canon([
    sorted(doc.tombs),
    [...new Set(doc.categories)].sort(),
    sorted(doc.renames),
    sorted(doc.mappings),
    sorted(doc.budgets),
    sorted(doc.prefs),
    sorted(doc.devices).map(([k, d]) => [
      k,
      { name: d.name, app: d.app, mode: d.mode, rpcSince: d.rpcSince, e2e: d.e2e },
    ]),
  ])
  return (
    hex8(fnvLane(`${ra}|${fnvLane(rest, FNV_A)}`, FNV_A)) +
    hex8(fnvLane(`${rb}|${fnvLane(rest, FNV_B)}`, FNV_B))
  )
}

/** The records' JSON array joined from scratch in id order. */
const referenceText = (doc: Doc): string =>
  JSON.stringify(
    [...doc.expenses.keys()].sort().map((id) => encodeRecord(must(doc.expenses.get(id)))),
  )

function referenceMax(doc: Doc): number {
  let m = 0
  for (const rec of doc.expenses.values()) m = Math.max(m, maxStampRec(rec))
  for (const s of doc.tombs.values()) m = Math.max(m, s)
  for (const g of doc.renames.values()) m = Math.max(m, g.s)
  for (const g of doc.mappings.values()) m = Math.max(m, g.s)
  for (const g of doc.budgets.values()) m = Math.max(m, g.set, g.del)
  for (const g of doc.prefs.values()) m = Math.max(m, g.s)
  return m
}

describe(
  'O(changed) facts (§9.12): derived maps give exactly the from-scratch values',
  HEAVY,
  () => {
    it('digest, max stamp and id order match the reference over 400 random op/merge chains', () => {
      const r = makeRng(913)
      const names = ['kopi', 'grab', 'constructor', 'mrt']
      for (let run = 0; run < 400; run++) {
        const clock: Hlc = { last: 0 }
        let doc: Doc = genDoc(r, { ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] })
        for (let step = 0; step < 12; step++) {
          const c = ctx(T0 + run * DAY + step * 1000, clock)
          const ids = [...doc.expenses.keys()]
          const roll = r.next()
          try {
            if (roll < 0.3 || ids.length === 0) {
              doc = addExpense(doc, c, { itemName: r.pick(names), amount: 1 + r.int(9) }).doc
            } else if (roll < 0.5) {
              doc = updateExpense(doc, c, r.pick(ids), { amount: 2 + r.int(9) }).doc
            } else if (roll < 0.65) {
              doc = deleteExpenses(doc, c, [r.pick(ids), r.pick(ids)]).doc
            } else if (roll < 0.75) {
              doc = renameCategory(doc, c, r.pick(displayList(doc)), r.pick(['Meals', 'Food'])).doc
            } else if (roll < 0.85) {
              doc = mergeDoc(doc, genDoc(r, { ids: ['a', 'k', 'l', 'b'] })).doc
            } else {
              doc = deleteAllEverywhere(doc, c).doc
            }
          } catch (e) {
            if (!(e instanceof OpError)) throw e
          }
          // resolve some intermediate maps and leave others pending, so derivations also compose
          if (r.chance(0.5)) {
            expect(digestDoc(doc)).toBe(referenceDigest(doc))
            expect(maxStampDoc(doc)).toBe(referenceMax(doc))
            expect(sortedIdsOf(doc.expenses)).toEqual([...doc.expenses.keys()].sort())
            if (r.chance(0.7)) expect(recordsJsonOf(doc.expenses)).toBe(referenceText(doc))
          }
        }
        expect(digestDoc(doc)).toBe(referenceDigest(doc))
        expect(maxStampDoc(doc)).toBe(referenceMax(doc))
        expect(sortedIdsOf(doc.expenses)).toEqual([...doc.expenses.keys()].sort())
        expect(recordsJsonOf(doc.expenses)).toBe(referenceText(doc))
      }
    })

    it('a large insertion batch falls back to one sort; removing the newest record recomputes the max', () => {
      const base = docOf({ expenses: [genRecord(makeRng(5), 'm', [T0 + 9 * DAY])] })
      expect(maxStampDoc(base)).toBe(referenceMax(base))
      const many = deriveExpenses(
        base.expenses,
        Array.from({ length: 100 }, (_, i) => genRecord(makeRng(i), `n${String(99 - i)}`, [T0])),
      )
      expect(sortedIdsOf(many)).toEqual([...many.keys()].sort())
      const dropped: Doc = { ...base, expenses: deriveExpenses(many, [], ['m']) }
      expect(maxStampDoc(dropped)).toBe(referenceMax(dropped))
      expect(digestDoc(dropped)).toBe(referenceDigest(dropped))
      expect(recordsJsonOf(dropped.expenses)).toBe(referenceText(dropped))
      // single inserts, removals and replacements at the front, middle and end splice exactly
      let d: Doc = { ...base, expenses: many }
      expect(recordsJsonOf(d.expenses)).toBe(referenceText(d))
      for (const [set, drop] of [
        [[genRecord(makeRng(70), '0000', [T0])], []],
        [[genRecord(makeRng(71), 'zzzz', [T0])], []],
        [[genRecord(makeRng(72), 'n50', [T0 + DAY])], []],
        [[], ['0000']],
        [[], ['zzzz']],
        [[], ['n50', 'n51']],
        [[genRecord(makeRng(73), 'n7', [T0 + 2 * DAY])], ['n8']],
      ] as const) {
        d = { ...d, expenses: deriveExpenses(d.expenses, set, drop) }
        expect(recordsJsonOf(d.expenses)).toBe(referenceText(d))
      }
      const one: Doc = docOf({ expenses: [genRecord(makeRng(80), 'solo', [T0])] })
      expect(recordsJsonOf(one.expenses)).toBe(referenceText(one))
      const none = deriveExpenses(one.expenses, [], ['solo'])
      expect(recordsJsonOf(none)).toBe('[]')
      expect(recordsJsonOf(deriveExpenses(none, [genRecord(makeRng(81), 'x', [T0])]))).toBe(
        referenceText({ ...one, expenses: new Map([['x', genRecord(makeRng(81), 'x', [T0])]]) }),
      )
      expect(deriveExpenses(many, [], ['absent'])).toBe(many)
      expect(deriveExpenses(many, [must(many.get('n5'))])).toBe(many)
    })
  },
)
