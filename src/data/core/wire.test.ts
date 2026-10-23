// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0, docOf, genDoc } from '../__tests__/support/gen'
import { arr, must, parseJson, prop, protoProbe } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { MIRROR_ORDER, WIRE_PUSH_MAX, WIRE_WARN } from './constants'
import { EMPTY_DOC, digestDoc, mergeDoc } from './doc'
import { updateExpense } from './ops'
import { addRecord, editRecord, recordString } from './record'
import { iso } from './stamp'
import { type BackupData, type Expense, mergeBackups } from '../__tests__/legacy/v084'
import type { BudgetReg, Doc, ExpenseRec, Hlc, OpCtx, V4Key } from './types'
import {
  adoptableNews,
  decodeWire,
  encodeBackupFile,
  encodeWire,
  fromV4Keys,
  mirrorSum,
  movedMarker,
  sizeClass,
  toV4Mirror,
  v08ts,
  wireChars,
  wireString,
} from './wire'

const ctx = (wall: number, clock: Hlc = { last: 0 }): OpCtx => ({
  wall,
  clock,
  dev: 'd',
  rng: makeRng(1).next,
})
const v4rec = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  itemName: 'Lunch',
  amount: 5.5,
  category: 'Food',
  date: '2026-10-18T04:00:00.000Z',
  createdAt: '2026-10-18T04:00:00.000Z',
  ...over,
})
const v4 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  expenses: [v4rec('e1')],
  categories: ['Food', 'Other'],
  categoryMappings: {},
  budgets: {},
  exportDate: '2026-10-18T04:00:00.000Z',
  version: '4.0',
  ...over,
})
const roundTrip = (d: Doc): Doc => decodeWire(parseJson(wireString(d)), 'remote').doc

describe('writer classes (§8.2)', HEAVY, () => {
  it('classifies every payload shape', () => {
    const cls = (raw: unknown, origin: 'remote' | 'file' = 'remote'): string =>
      decodeWire(raw, origin).writer
    expect(cls({ st: 5, k: 1, r: 'x', iv: 'y', z: 1, ct: 'z' })).toBe('e2e')
    expect(cls(movedMarker('private', iso(T0)))).toBe('moved')
    expect(cls({ ...v4(), x5: { schema: 5, moved: { why: 'stopped' } } })).toBe('moved')
    expect(cls({ ...v4(), x5: { schema: 6, min: 4 } })).toBe('newer')
    expect(cls({ ...v4(), x5: { schema: 5, min: 6 } })).toBe('newer')
    expect(cls({ ...v4(), x5: { schema: 5, min: 4 } })).toBe('v5')
    expect(cls({ ...v4(), wr: { app: '0.8.5', dev: 'a1b2c3', rev: 'r', at: iso(T0) } })).toBe(
      'v085',
    )
    expect(cls(v4())).toBe('v084')
    expect(cls({ ...v4(), version: '6.0' }, 'file')).toBe('newer')
    expect(cls({ ...v4(), expenses: null })).toBe('invalid')
    expect(cls([])).toBe('invalid')
    expect(cls(null)).toBe('invalid')
    expect(cls('garbage')).toBe('invalid')
  })

  it('moved and e2e decode to EMPTY_DOC without quarantine noise; invalid is reported', () => {
    for (const raw of [movedMarker('rotated', iso(T0)), { st: 5 }]) {
      const r = decodeWire(raw, 'remote')
      expect(r.doc).toBe(EMPTY_DOC)
      expect(r.report.quarantined).toEqual([])
    }
    const bad = decodeWire({ hello: 1 }, 'remote', { at: 42 })
    expect(bad.doc).toBe(EMPTY_DOC)
    expect(bad.report.quarantined.map((q) => [q.reason, q.at, q.origin])).toEqual([
      ['invalid-payload', 42, 'remote'],
    ])
  })

  it('newer payloads still decode what is understood (merge-only)', () => {
    const r = decodeWire({ ...v4(), x5: { schema: 6, min: 6 } }, 'remote')
    expect(r.writer).toBe('newer')
    expect(r.doc.expenses.has('e1')).toBe(true)
  })

  it('srcRank: v0.8.4 payloads and files rank 0; v5, v0.8.5 and local data rank 1', () => {
    const rank = (
      raw: unknown,
      origin: 'remote' | 'file' | 'local-v4' | 'local-envelope',
      legacyRank?: 0 | 1,
    ): number =>
      must(
        decodeWire(raw, origin, legacyRank === undefined ? {} : { legacyRank }).doc.expenses.get(
          'e1',
        ),
      ).a.r
    expect(rank(v4(), 'remote')).toBe(0)
    expect(
      rank({ ...v4(), wr: { app: '0.8.5', dev: 'abc', rev: 'r', at: iso(T0) } }, 'remote'),
    ).toBe(1)
    expect(rank({ ...v4(), x5: { schema: 5, min: 4 } }, 'remote')).toBe(1)
    expect(rank({ ...v4(), x5: { schema: 5, min: 4 } }, 'file')).toBe(0)
    expect(rank(fromV4Keys({ expenses: [v4rec('e1')] }), 'local-v4')).toBe(0)
    expect(rank(fromV4Keys({ expenses: [v4rec('e1')] }), 'local-v4', 1)).toBe(1)
    expect(rank(v4(), 'local-envelope')).toBe(1)
  })
})

describe('per-collection isolation (DAT-09, F-014)', HEAVY, () => {
  it('a wrong-shaped collection becomes empty plus a report entry and never blocks another', () => {
    const r = decodeWire(
      v4({
        budgets: null,
        categories: 5,
        categoryMappings: [1],
        deletedIds: 'x',
        budgetUpdatedAt: 'x',
        x5: { schema: 5, ren: 'x', mts: 3, pref: [], devs: 7, dts: 'x' },
      }),
      'remote',
    )
    expect(r.writer).toBe('v5')
    expect(r.doc.expenses.has('e1')).toBe(true)
    expect([...r.report.droppedKeys].sort()).toEqual(
      [
        'budgetUpdatedAt',
        'categories',
        'categoryMappings',
        'deletedIds',
        'x5.devs',
        'x5.mts',
        'x5.pref',
        'x5.ren',
      ].sort(),
    )
  })

  it('local origins decode every collection whatever the shape (never EMPTY_DOC by class)', () => {
    const r = decodeWire(
      fromV4Keys({ expenses: { not: 'an array' }, categories: ['Food'] }),
      'local-v4',
    )
    expect(r.doc.categories).toEqual(['Food'])
    expect(r.report.droppedKeys).toEqual(['expenses'])
  })

  it('an id listed twice in deletedIds keeps its earliest real deletion stamp (joinTomb, §6.3)', () => {
    const tomb = (dts: readonly number[]): number | undefined =>
      decodeWire(
        v4({ expenses: [], deletedIds: ['x', 'x'], x5: { schema: 5, min: 4, dts } }),
        'remote',
      ).doc.tombs.get('x')
    expect(tomb([T0 + 1, T0 + 2])).toBe(T0 + 1)
    expect(tomb([T0 + 2, T0 + 1])).toBe(T0 + 1)
    expect(tomb([0, T0 + 1])).toBe(T0 + 1)
    expect(tomb([T0 + 1, 0])).toBe(T0 + 1)
    expect(tomb([0, 0])).toBe(0)
  })

  it('P-16: misaligned x5.dts → every tombstone stamp 0 plus a report entry', () => {
    const r = decodeWire(v4({ deletedIds: ['a', 'b'], x5: { schema: 5, dts: [T0] } }), 'remote')
    expect([...r.doc.tombs]).toEqual([
      ['a', 0],
      ['b', 0],
    ])
    expect(r.report.droppedKeys).toContain('x5.dts')
  })

  it('never throws and is total for hostile top-level inputs', () => {
    let deep: unknown = {}
    for (let i = 0; i < 50_000; i++) deep = { x: deep }
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      'x',
      [],
      [[]],
      true,
      deep,
      { expenses: deep },
      { expenses: [deep] },
    ]
    for (const raw of inputs) {
      for (const origin of ['remote', 'file', 'local-v4', 'local-envelope', 'snapshot'] as const) {
        expect(() => decodeWire(raw, origin)).not.toThrow()
      }
    }
  })

  it('caps one source at 50,000 records and quarantines the excess as `cap`', () => {
    const many = Array.from({ length: 50_001 }, (_, i) => v4rec(`e${i}`))
    const r = decodeWire(v4({ expenses: many }), 'remote')
    expect(r.doc.expenses.size).toBe(50_000)
    expect(r.report.quarantined.map((q) => q.reason)).toEqual(['cap'])
  })
})

describe('dedupe within one source (§7.9, T-047-1 core)', HEAVY, () => {
  it('a duplicated id that is also deleted keeps its real deletion stamp; the copies get derived ids', () => {
    const copies = [
      v4rec('dup', { itemName: 'Lunch A' }),
      v4rec('dup', { itemName: 'Lunch B', amount: 9 }),
    ]
    const r = decodeWire(
      v4({ expenses: copies, deletedIds: ['dup'], x5: { schema: 5, min: 4, dts: [T0 + 7] } }),
      'remote',
    )
    expect(r.doc.tombs.get('dup')).toBe(T0 + 7)
    const live = [...r.doc.expenses.keys()]
    expect(live).toHaveLength(2)
    for (const id of live) expect(id).toMatch(/^dup~d[0-9a-z]{1,7}$/)
  })

  it('identical copies merge into one; differing copies get derived ids and the shared id dies', () => {
    const same = decodeWire(v4({ expenses: [v4rec('dup'), v4rec('dup')] }), 'file')
    expect([...same.doc.expenses.keys()]).toEqual(['dup'])
    expect(same.report.deduped).toBe(1)

    const raw = v4({
      expenses: [
        v4rec('dup', { itemName: 'Lunch A' }),
        v4rec('dup', { itemName: 'Lunch B', amount: 9 }),
      ],
    })
    const a = decodeWire(raw, 'file')
    const b = decodeWire(parseJson(JSON.stringify(raw)), 'remote')
    const ids = [...a.doc.expenses.keys()].sort()
    expect(ids).toHaveLength(2)
    expect([...b.doc.expenses.keys()].sort()).toEqual(ids)
    for (const id of ids) expect(id).toMatch(/^dup~d[0-9a-z]{1,7}$/)
    expect(a.doc.tombs.get('dup')).toBe(0)
    expect(a.report.deduped).toBe(2)
    // reversed input order gives the same ids
    const rev = decodeWire(v4({ expenses: [...arr(prop(raw, 'expenses'))].reverse() }), 'file')
    expect([...rev.doc.expenses.keys()].sort()).toEqual(ids)
  })
})

describe('live and tombstoned (§8.2)', HEAVY, () => {
  it('migrated local data revives under a deterministic id; elsewhere the tombstone wins, reported', () => {
    const raw = fromV4Keys({ expenses: [v4rec('e1')], deletedExpenseIds: ['e1'] })
    const local = decodeWire(raw, 'local-v4')
    const [id] = [...local.doc.expenses.keys()]
    expect(id).toMatch(/^e1~r[0-9a-z]+$/)
    expect(local.report.liveAndDeleted).toBe(1)
    expect(local.report.repairs).toEqual([])
    expect(local.doc.tombs.has('e1')).toBe(true)
    expect(decodeWire(raw, 'local-v4').doc.expenses.keys().next().value).toBe(id)
    for (const origin of ['remote', 'file'] as const) {
      const r = decodeWire(v4({ deletedIds: ['e1'] }), origin, { at: 4 })
      expect(r.doc.expenses.size, origin).toBe(0)
      expect(r.doc.tombs.has('e1'), origin).toBe(true)
      expect(r.report.liveAndDeleted, origin).toBe(1)
      expect(r.report.repairs.map((q) => [q.reason, q.at, q.origin, q.raw])).toEqual([
        ['live-and-deleted', 4, origin, JSON.stringify(v4rec('e1'))],
      ])
    }
  })

  it('a FOLD leaves an id listed live and deleted out entirely, so it decides nothing (§9.10)', () => {
    const raw = fromV4Keys({
      expenses: [v4rec('e1'), v4rec('e2')],
      deletedExpenseIds: ['e1', 'gone'],
    })
    const r = decodeWire(raw, 'local-v4', { legacyRank: 1, fold: true, at: 6 })
    expect([...r.doc.expenses.keys()]).toEqual(['e2'])
    expect([...r.doc.tombs.keys()]).toEqual(['gone'])
    expect(r.report.liveAndDeleted).toBe(1)
    expect(r.report.repairs.map((q) => [q.reason, q.at, q.origin, q.raw])).toEqual([
      ['live-and-deleted', 6, 'local-v4', JSON.stringify(v4rec('e1'))],
    ])
    // a live e1 here stays live and unremoved; a deleted e1 here stays deleted, under no new id
    const live = decodeWire(fromV4Keys({ expenses: [v4rec('e1')] }), 'local-v4', {
      legacyRank: 1,
    }).doc
    const kept = mergeDoc(live, r.doc)
    expect([...kept.doc.expenses.keys()].sort()).toEqual(['e1', 'e2'])
    expect(kept.removed).toEqual([])
    const dead: Doc = { ...EMPTY_DOC, tombs: new Map([['e1', T0]]) }
    const still = mergeDoc(dead, r.doc).doc
    expect([...still.expenses.keys()]).toEqual(['e2'])
    expect(still.tombs.get('e1')).toBe(T0)
    // without the fold flag the same keys migrate: the row is revived (v0.8 showed it)
    expect(decodeWire(raw, 'local-v4', { legacyRank: 1 }).doc.expenses.size).toBe(2)
  })
})

describe('budgets on the boundary (§6.7, P-12)', HEAVY, () => {
  it('a value without budgetUpdatedAt: 0 for local v4 keys, exportDate for payloads; 1970 is 0', () => {
    const local = decodeWire(fromV4Keys({ categoryBudgets: { Food: 300 } }), 'local-v4')
    expect(local.doc.budgets.get('Food')).toEqual({ value: 300, set: 0, del: 0 })
    const remote = decodeWire(v4({ budgets: { Food: 300 } }), 'remote')
    expect(remote.doc.budgets.get('Food')).toEqual({
      value: 300,
      set: Date.parse('2026-10-18T04:00:00.000Z'),
      del: 0,
    })
    const epoch = decodeWire(
      v4({ budgets: { Food: 300 }, budgetUpdatedAt: { Food: '1970-01-01T00:00:00.000Z' } }),
      'remote',
    )
    expect(must(epoch.doc.budgets.get('Food')).set).toBe(0)
  })

  it('repairs numeric strings, drops junk and reserved keys without polluting', () => {
    const r = decodeWire(
      parseJson(
        '{"expenses":[],"budgets":{"Food & Dining":"300","Transportation":100,"Food":"abc","__proto__":{"polluted":1},"constructor":5}}',
      ),
      'remote',
    )
    expect(must(r.doc.budgets.get('Food & Dining')).value).toBe(300)
    expect(must(r.doc.budgets.get('Transportation')).value).toBe(100)
    expect(r.doc.budgets.has('Food')).toBe(false)
    expect(r.report.droppedKeys).toEqual(
      expect.arrayContaining(['budgets.Food', 'budgets.__proto__', 'budgets.constructor']),
    )
    expect(r.report.repaired).toBe(1)
    expect(protoProbe('polluted')).toBeUndefined()
  })
})

describe('legacyTs (P-11)', HEAVY, () => {
  it('records v0.8 ts(updatedAt ?? createdAt) of the raw records, NaN kept', () => {
    const raw = v4({
      expenses: [
        v4rec('a', { updatedAt: '9999-12-31T00:00:00.000Z' }),
        v4rec('b', { updatedAt: 'garbage' }),
        v4rec('c'),
      ],
    })
    const r = decodeWire(raw, 'remote')
    expect(r.legacyTs.get('a')).toBe(Date.parse('9999-12-31T00:00:00.000Z'))
    expect(Number.isNaN(r.legacyTs.get('b'))).toBe(true)
    expect(r.legacyTs.get('c')).toBe(Date.parse('2026-10-18T04:00:00.000Z'))
    expect(decodeWire({ ...raw, x5: { schema: 5 } }, 'remote').legacyTs.size).toBe(0)
    expect(v08ts({ createdAt: '' })).toBe(0)
    expect(v08ts({ updatedAt: null, createdAt: 0 })).toBe(0)
    expect(v08ts('x')).toBeNaN()
  })
})

describe('encodeWire / wireString (§10.1, P-15)', HEAVY, () => {
  const c: Hlc = { last: 0 }
  const recs: ExpenseRec[] = ['b', 'a', 'c'].map((id, i) =>
    addRecord(
      id,
      { n: `item ${id}`, a: 1 + i, c: 'Food', day: '2026-10-18', o: null },
      ctx(T0 + i, c),
    ),
  )
  const doc: Doc = {
    ...docOf({ expenses: recs, categories: ['Food', 'Other'] }),
    tombs: new Map([
      ['z', T0 + 5],
      ['y', 0],
      ['x', T0 + 1],
    ]),
    renames: new Map([['Food', { to: null, s: T0 }]]),
    mappings: new Map([
      ['item a', { v: 'Food', s: T0 }],
      ['kopi', { v: 'Food', s: 0 }],
    ]),
    budgets: new Map([
      ['Food', { value: 300, set: 0, del: 0 }],
      ['Gone', { value: null, set: T0, del: T0 + 9 }],
    ]),
    prefs: new Map([['currency', { v: 'SGD', s: T0 }]]),
  }

  it('sorts records by id and tombstones oldest first with aligned stamps', () => {
    const w = encodeWire(doc, { dev: 'k3f9x2', rev: 'r'.repeat(22) })
    expect(w.expenses.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(w.deletedIds).toEqual(['y', 'x', 'z'])
    expect(w.x5.dts).toEqual([0, T0 + 1, T0 + 5])
    expect(w.version).toBe('4.0')
    expect(w.exportDate).toBe(iso(T0 + 9))
    expect(w.x5.dig).toBe(digestDoc(doc))
    expect(w.x5.min).toBe(4)
    expect([w.x5.dev, w.x5.rev]).toEqual(['k3f9x2', 'r'.repeat(22)])
    expect({ ...w.budgets }).toEqual({ Food: 300 })
    expect({ ...w.budgetUpdatedAt }).toEqual({ Food: '1970-01-01T00:00:00.000Z', Gone: iso(T0) })
    expect({ ...w.budgetDeletedAt }).toEqual({ Gone: iso(T0 + 9) })
    expect({ ...w.x5.mts }).toEqual({ 'item a': T0 })
  })

  it('wireString is exactly JSON.stringify(encodeWire(...))', () => {
    expect(wireString(doc, { dev: 'k', rev: 'r' })).toBe(
      JSON.stringify(encodeWire(doc, { dev: 'k', rev: 'r' })),
    )
    expect(wireString(EMPTY_DOC)).toBe(JSON.stringify(encodeWire(EMPTY_DOC)))
    expect(wireChars(doc)).toBe(wireString(doc).length)
  })

  it('demo rows stay off the wire on a demo build (P-9)', () => {
    const demo = { ...must(recs[0]), id: 'demo-1' }
    const d = docOf({ expenses: [...recs, demo] })
    expect(
      encodeWire(d, { omitIds: (id) => id.startsWith('demo-') }).expenses.map((e) => e.id),
    ).not.toContain('demo-1')
    expect(toV4Mirror(d, { omitIds: (id) => id.startsWith('demo-') }).expenses).not.toContain(
      'demo-1',
    )
  })

  it('round-trips random docs (decode(encode(x)) ≡ x)', () => {
    const r = makeRng(21)
    for (let i = 0; i < 300; i++) {
      const d = mergeDoc(genDoc(r), genDoc(r)).doc
      const back = roundTrip(d)
      expect(digestDoc(back)).toBe(digestDoc(d))
      for (const [id, rec] of d.expenses)
        expect(recordString(must(back.expenses.get(id)))).toBe(recordString(rec))
    }
  })

  it('the backup file is the payload shape, marked, without dev/rev/devs', () => {
    const f = encodeBackupFile(doc)
    expect([f.spendtrack, f.version]).toEqual(['backup', '5.0'])
    expect('dev' in f.x5 || 'rev' in f.x5 || 'devs' in f.x5).toBe(false)
    const back = decodeWire(parseJson(JSON.stringify(f)), 'file')
    expect(back.writer).toBe('v5')
    expect(digestDoc(back.doc)).toBe(digestDoc(doc))
  })
})

describe('decode reuse (P-21, §9.12)', HEAVY, () => {
  it('reuses record objects for exact wire copies and is digest-equal to a fresh decode', () => {
    const r = makeRng(4)
    for (let i = 0; i < 200; i++) {
      const d = mergeDoc(genDoc(r), genDoc(r)).doc
      const raw = parseJson(wireString(d))
      const fresh = decodeWire(raw, 'remote')
      const reused = decodeWire(raw, 'remote', { reuse: d })
      expect(digestDoc(reused.doc)).toBe(digestDoc(fresh.doc))
      for (const [id, rec] of reused.doc.expenses) expect(rec).toBe(must(d.expenses.get(id)))
      expect(mergeDoc(d, reused.doc).doc).toBe(d)
    }
  })

  it('does not reuse an unsealed record when the source rank differs', () => {
    const local = decodeWire(v4(), 'local-envelope').doc
    const pulled = decodeWire(v4(), 'remote', { reuse: local })
    expect(pulled.doc.expenses.get('e1')).not.toBe(local.expenses.get('e1'))
    expect(must(pulled.doc.expenses.get('e1')).a.r).toBe(0)
  })
})

describe('v4 mirror (§9.10, P-22)', HEAVY, () => {
  it('projects to the seven keys and folds back losslessly through fromV4Keys', () => {
    const c: Hlc = { last: 0 }
    const a = addRecord(
      'a',
      { n: 'kopi', a: 1.8, c: 'Food', day: '2026-10-18', o: null },
      ctx(T0, c),
    )
    const b = editRecord(
      addRecord('b', { n: 'grab', a: 12, c: 'Transport', day: '2026-10-18', o: null }, ctx(T0, c)),
      { a: 21 },
      ctx(T0 + 5, c),
    )
    const d: Doc = {
      ...docOf({ expenses: [a, b], categories: ['Food'] }),
      tombs: new Map([['old', T0]]),
      renames: new Map([
        ['Food', { to: 'Meals', s: T0 + 1 }],
        ['Meals', { to: null, s: T0 + 1 }],
      ]),
      mappings: new Map([['kopi', { v: 'Food', s: T0 }]]),
      budgets: new Map([['Meals', { value: 300, set: T0, del: 0 }]]),
    }
    const m = toV4Mirror(d)
    expect(Object.keys(m).sort()).toEqual([...MIRROR_ORDER].sort())
    expect(parseJson(m.categoryMappings)).toEqual({ kopi: 'Meals' })
    expect(parseJson(m.deletedExpenseIds)).toEqual(['old'])
    // a rolled-back build lists exactly the display list: the renamed-away 'Food' is out, the
    // names its records show under (unlisted 'Meals', 'Transport') are in
    expect(parseJson(m.categories)).toEqual(['Transport', 'Meals', 'Other'])
    const parsed: Partial<Record<V4Key, unknown>> = {}
    for (const k of MIRROR_ORDER) parsed[k] = parseJson(m[k])
    const back = decodeWire(fromV4Keys(parsed), 'local-v4', { legacyRank: 1 }).doc
    expect(recordString(must(back.expenses.get('a')))).toBe(recordString(a))
    expect(recordString(must(back.expenses.get('b')))).toBe(recordString(b))
    expect(back.tombs.has('old')).toBe(true)
    expect(mergeDoc(d, back).removed).toEqual([])
  })

  it('mirrorSum depends on every key, in MIRROR_ORDER, and on missing keys', () => {
    const m = toV4Mirror(EMPTY_DOC)
    const s = mirrorSum(m)
    expect(mirrorSum({ ...m })).toBe(s)
    for (const k of MIRROR_ORDER) expect(mirrorSum({ ...m, [k]: null })).not.toBe(s)
    expect(mirrorSum({ ...m, expenses: '[ ]' })).not.toBe(s)
  })
})

describe('size meter (F-016)', HEAVY, () => {
  it('warns from 70 % and refuses above the push ceiling', () => {
    expect(sizeClass(WIRE_WARN - 1)).toBe('ok')
    expect(sizeClass(WIRE_WARN)).toBe('warn')
    expect(sizeClass(WIRE_PUSH_MAX)).toBe('warn')
    expect(sizeClass(WIRE_PUSH_MAX + 1)).toBe('too-large')
  })
})

describe('adoptableNews (§11.4, P-11)', HEAVY, () => {
  const relayOf = (raw: Record<string, unknown>): ReturnType<typeof decodeWire> =>
    decodeWire(raw, 'remote')

  it('detects exactly what a v0.8 mergeBackups would keep', () => {
    const base = relayOf(v4())
    const same = decodeWire(v4(), 'local-envelope').doc
    expect(adoptableNews(same, base)).toBe(false)
    expect(adoptableNews({ ...same, categories: ['Food', 'Other', 'Gym'] }, base)).toBe(true)
    expect(
      adoptableNews({ ...same, mappings: new Map([['kopi', { v: 'Food', s: T0 }]]) }, base),
    ).toBe(true)
    expect(
      adoptableNews({ ...same, tombs: new Map([['e1', T0]]), expenses: new Map() }, base),
    ).toBe(true)
    const newer = decodeWire(
      v4({ expenses: [v4rec('e1', { amount: 9, updatedAt: iso(T0) })] }),
      'local-envelope',
    ).doc
    expect(adoptableNews(newer, base)).toBe(true)
    const added = decodeWire(v4({ expenses: [v4rec('e1'), v4rec('e2')] }), 'local-envelope').doc
    expect(adoptableNews(added, base)).toBe(true)
    // a relay copy whose stamp v0.8 cannot parse loses to ours (!(NaN >= x))
    const nan = relayOf(v4({ expenses: [v4rec('e1', { updatedAt: 'garbage' })] }))
    expect(adoptableNews(same, nan)).toBe(true)
    // the relay's far-future stamp keeps its own copy: nothing we push would stick
    const future = relayOf(
      v4({ expenses: [v4rec('e1', { updatedAt: '9999-12-31T00:00:00.000Z' })] }),
    )
    expect(adoptableNews(newer, future)).toBe(false)
  })

  it('budgets: exactly the frozen v0.8.4 mergeBackups outcome, for every pair of registers', () => {
    const regs: BudgetReg[] = []
    for (const value of [null, 100, 200])
      for (const set of [0, T0, T0 + 1])
        for (const del of [0, T0, T0 + 1]) {
          const hidden = del > 0 && del >= set
          if (value !== null && hidden) continue // canonical: a hidden register keeps no value
          if (value === null && set === 0 && del === 0) continue
          regs.push({ value, set, del })
        }
    const clock = { now: () => T0 + 99, setTimeout: () => 0, clearTimeout: () => undefined }
    const asBackup = (w: ReturnType<typeof encodeWire>): BackupData => ({
      expenses: [],
      categories: [...w.categories],
      categoryMappings: { ...w.categoryMappings },
      budgets: { ...w.budgets },
      budgetUpdatedAt: { ...w.budgetUpdatedAt },
      budgetDeletedAt: { ...w.budgetDeletedAt },
      deletedIds: [...w.deletedIds],
      exportDate: w.exportDate,
      version: '4.0',
    })
    let pairs = 0
    for (const theirs of regs) {
      // the relay as a v0.8.4 client wrote it: the v4 part only (x5 stripped)
      const relayData = asBackup(encodeWire(docOf({ budgets: [['Food', theirs]] })))
      const relay = decodeWire({ ...relayData }, 'remote')
      expect(relay.writer).toBe('v084')
      for (const ours of regs) {
        const m = mergeDoc(docOf({ budgets: [['Food', ours]] }), relay.doc).doc
        const kept = mergeBackups(relayData, asBackup(encodeWire(m)), clock).budgets?.Food
        expect(adoptableNews(m, relay), JSON.stringify([theirs, ours])).toBe(
          kept !== relayData.budgets?.Food,
        )
        pairs++
      }
    }
    expect(pairs).toBeGreaterThan(100)
  })

  it('records, tombstones, lists and mappings: news iff the frozen v0.8.4 merge keeps something of ours', () => {
    const clock = { now: () => T0 + 99, setTimeout: () => 0, clearTimeout: () => undefined }
    const r = makeRng(41)
    let news = 0
    for (let i = 0; i < 1500; i++) {
      const w = encodeWire(genDoc(r))
      // the relay as a v0.8.4 client wrote it: its own records and lists, x5 stripped
      const relayData: BackupData = {
        expenses: w.expenses.map((e) => {
          const out: Expense = {
            id: String(e.id),
            itemName: String(e.itemName),
            amount: Number(e.amount),
            category: String(e.category),
            date: String(e.date),
            createdAt: String(e.createdAt),
          }
          if (typeof e.updatedAt === 'string') out.updatedAt = e.updatedAt
          return out
        }),
        categories: [...w.categories],
        categoryMappings: { ...w.categoryMappings },
        budgets: { ...w.budgets },
        budgetUpdatedAt: { ...w.budgetUpdatedAt },
        budgetDeletedAt: { ...w.budgetDeletedAt },
        deletedIds: [...w.deletedIds],
        exportDate: w.exportDate,
        version: '4.0',
      }
      const relay = decodeWire(parseJson(JSON.stringify(relayData)), 'remote')
      // a third of the runs merge nothing new: the old client must find nothing to keep
      const m = mergeDoc(r.chance(0.33) ? EMPTY_DOC : genDoc(r), relay.doc).doc
      const ours = parseJson(wireString(m))
      if (typeof ours !== 'object' || ours === null) throw new Error('wire')
      const res = mergeBackups(relayData, { ...relayData, ...ours }, clock)
      const before = new Map(relayData.expenses.map((e) => [e.id, e]))
      const kept =
        res.expenses.some((e) => before.get(e.id) !== e) ||
        [...before.keys()].some((id) => !res.expenses.some((e) => e.id === id)) ||
        // (v0.8 also fills an empty list with its defaults by itself: not ours)
        m.categories.some((n) => res.categories.includes(n) && !relayData.categories.includes(n)) ||
        Object.keys(res.categoryMappings).some(
          (k) => !Object.hasOwn(relayData.categoryMappings, k),
        ) ||
        [
          ...new Set([...Object.keys(res.budgets ?? {}), ...Object.keys(relayData.budgets ?? {})]),
        ].some((k) => res.budgets?.[k] !== relayData.budgets?.[k])
      expect(adoptableNews(m, relay), `run ${i}`).toBe(kept)
      if (kept) news++
    }
    // both outcomes are exercised
    expect(news).toBeGreaterThan(100)
    expect(news).toBeLessThan(1400)
  })

  it('budgets: news only when the v4 rule outcome changes on the old client', () => {
    const relay = relayOf(v4({ budgets: { Food: 100 }, budgetUpdatedAt: { Food: iso(T0) } }))
    const doc = decodeWire(
      v4({ budgets: { Food: 100 }, budgetUpdatedAt: { Food: iso(T0) } }),
      'local-envelope',
    ).doc
    expect(adoptableNews(doc, relay)).toBe(false)
    expect(
      adoptableNews(
        { ...doc, budgets: new Map([['Food', { value: 200, set: T0 + 1, del: 0 }]]) },
        relay,
      ),
    ).toBe(true)
    expect(
      adoptableNews(
        { ...doc, budgets: new Map([['Food', { value: 200, set: T0 - 1, del: 0 }]]) },
        relay,
      ),
    ).toBe(false)
    expect(
      adoptableNews(
        { ...doc, budgets: new Map([['Food', { value: 100, set: T0, del: T0 + 1 }]]) },
        relay,
      ),
    ).toBe(true)
  })
})

describe('defensive paths stay total', HEAVY, () => {
  it('a raw object whose own-key reads throw yields an empty invalid doc with reason internal', () => {
    const hostile = new Proxy(
      { expenses: [] },
      {
        ownKeys: () => {
          throw new Error('boom')
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('boom')
        },
      },
    )
    const r = decodeWire(hostile, 'remote', { at: 7 })
    expect(r.writer).toBe('invalid')
    expect(r.doc).toBe(EMPTY_DOC)
    expect(r.report.quarantined.map((q) => [q.reason, q.at])).toEqual([['internal', 7]])
  })

  it('a wrong-shaped x5 is dropped and reported; the v4 part still decodes', () => {
    for (const x5 of ['garbage', 5, [1, 2], null]) {
      const r = decodeWire(v4({ x5 }), 'remote')
      expect(r.writer).toBe('v5')
      expect(r.doc.expenses.size).toBe(1)
      expect(r.report.droppedKeys).toContain('x5')
    }
  })

  it('a pref whose value is not JSON (a Map, a Date) is dropped, never kept', () => {
    const raw = {
      ...v4(),
      x5: { schema: 5, pref: { currency: [T0, new Map()], theme: [T0, new Date(0)] } },
    }
    const r = decodeWire(raw, 'snapshot')
    expect(r.doc.prefs.size).toBe(0)
    expect(r.report.droppedKeys).toEqual(
      expect.arrayContaining(['x5.pref.currency', 'x5.pref.theme']),
    )
  })

  it('reuse compares nested fs pairs exactly (rank 0/1 registers)', () => {
    const rec = editRecord(
      addRecord('e1', { n: 'kopi', a: 2, c: 'Food', day: '2026-10-18', o: null }, ctx(T0)),
      { a: 3 },
      ctx(T0 + 5, { last: T0 }),
    )
    const ranked: ExpenseRec = { ...rec, n: { ...rec.n, r: 1 }, o: { ...rec.o, r: 0 } }
    const d = docOf({ expenses: [ranked] })
    const raw = parseJson(wireString(d))
    expect(must(decodeWire(raw, 'remote', { reuse: d }).doc.expenses.get('e1'))).toBe(ranked)
    const tampered = parseJson(wireString(d).replace('[1792396800000,1]', '[1792396800000,0]'))
    expect(decodeWire(tampered, 'remote', { reuse: d }).doc.expenses.get('e1')).not.toBe(ranked)
    const longer = parseJson(wireString(d).replace('[1792396800000,1]', '[1792396800000,1,1]'))
    expect(decodeWire(longer, 'remote', { reuse: d }).doc.expenses.get('e1')).not.toBe(ranked)
  })

  it('a live-and-deleted local row whose revive id is itself tombstoned takes the next free id', () => {
    const base = decodeWire(v4(), 'local-envelope').doc
    const rec = must(base.expenses.get('e1'))
    const first = must(
      [...decodeWire(v4({ deletedIds: ['e1'] }), 'local-envelope').doc.expenses.keys()][0],
    )
    const r = decodeWire(v4({ deletedIds: ['e1', first] }), 'local-envelope')
    const [id] = [...r.doc.expenses.keys()]
    expect(id).toBe(`${first}.2`)
    expect(r.report.liveAndDeleted).toBe(1)
    expect(must(r.doc.expenses.get(must(id))).n.v).toBe(rec.n.v)
  })

  it('adoptableNews: a live id the relay holds as tombstoned is not news (v0.8 keeps it dead)', () => {
    const relay = decodeWire(v4({ expenses: [], deletedIds: ['e1'] }), 'remote')
    const live = decodeWire(v4(), 'local-envelope').doc
    expect(adoptableNews(live, relay)).toBe(false)
  })

  it('adoptableNews: unstamped legacy budgets follow v0.8’s local-first rule', () => {
    const relay = decodeWire(
      v4({ budgets: { Food: 100 }, budgetUpdatedAt: { Food: '1970-01-01T00:00:00.000Z' } }),
      'remote',
    )
    const ours = (value: number): Doc => ({
      ...EMPTY_DOC,
      budgets: new Map([['Food', { value, set: 0, del: 0 }]]),
    })
    expect(adoptableNews(ours(100), relay)).toBe(false)
    expect(adoptableNews(ours(200), relay)).toBe(false)
    const none = decodeWire(v4(), 'remote')
    expect(adoptableNews(ours(200), none)).toBe(true)
  })
})

describe('keep and report: every repair and drop keeps its original (§8.1, R1)', HEAVY, () => {
  const receipt = 'receipt line '.repeat(200)
  const longName = 'Presents for the family at Chinese New Year and birthdays (2026)'
  const raw = fromV4Keys({
    expenses: [
      v4rec('n1', { notes: receipt }),
      v4rec('n2', { category: longName }),
      v4rec('n3', { category: 'Food\tStall' }),
      v4rec('n4', { amount: '12.50', updatedAt: 'last tuesday', notes: { x: 1 } }),
      v4rec('n5', { itemName: '' }),
      v4rec('n6'),
      v4rec('n7', { kind: 'expense', 'a-b': 1 }),
    ],
    categories: ['Food', longName, 'Food\tStall', 'constructor', 7],
    categoryMappings: { kopi: 'Drinks', teh: '', constructor: 'Food' },
    categoryBudgets: { Food: '300', [longName]: 50, Drinks: 'abc' },
    deletedExpenseIds: ['gone', 5, ''],
  })

  /** Every raw record is either live exactly as written, or its original is in the report. */
  function everyRecordAccounted(source: unknown, r: ReturnType<typeof decodeWire>): void {
    const keptRaw = new Set([...r.report.quarantined, ...r.report.repairs].map((q) => q.raw))
    for (const el of arr(prop(source, 'expenses'))) {
      if (keptRaw.has(JSON.stringify(el))) continue
      // untouched: every v4 field is live exactly as written
      const id = String(prop(el, 'id'))
      const rec = must(r.doc.expenses.get(id), id)
      expect([rec.n.v, rec.a.v, rec.c.v, rec.d.v.date, rec.o.v, rec.createdAt], id).toEqual([
        prop(el, 'itemName'),
        prop(el, 'amount'),
        prop(el, 'category'),
        prop(el, 'date'),
        prop(el, 'notes') ?? null,
        prop(el, 'createdAt'),
      ])
    }
  }

  it('live records + quarantined + repairs account for every raw record and list entry', () => {
    const r = decodeWire(raw, 'local-v4', { legacyRank: 0, at: 9 })
    const logged = [...r.report.quarantined, ...r.report.repairs]
    const keptRaw = new Set(logged.map((q) => q.raw))
    everyRecordAccounted(raw, r)
    for (const name of arr(prop(raw, 'categories'))) {
      const kept =
        (typeof name === 'string' && r.doc.categories.includes(name)) ||
        keptRaw.has(JSON.stringify(name))
      expect(kept, String(name)).toBe(true)
    }
    for (const id of arr(prop(raw, 'deletedIds'))) {
      const kept =
        (typeof id === 'string' && r.doc.tombs.has(id)) || keptRaw.has(JSON.stringify(id))
      expect(kept, String(id)).toBe(true)
    }
    for (const q of logged) expect([q.at, q.origin]).toEqual([9, 'local-v4'])
  })

  it('…and so does every other origin, a fold, and a row the source lists live and deleted', () => {
    const source = { ...raw, deletedIds: [...arr(prop(raw, 'deletedIds')), 'n6'] }
    for (const [origin, opts] of [
      ['file', {}],
      ['remote', {}],
      ['local-v4', { legacyRank: 1, fold: true }],
    ] as const) {
      const r = decodeWire(source, origin, opts)
      expect(r.report.liveAndDeleted, origin).toBe(1)
      expect(r.doc.expenses.has('n6'), origin).toBe(false)
      everyRecordAccounted(source, r)
    }
  })

  it('notes of any length stay; a repaired record logs its whole raw copy and the fields', () => {
    const r = decodeWire(raw, 'local-v4', { legacyRank: 0 })
    expect(must(r.doc.expenses.get('n1')).o.v).toBe(receipt)
    expect(r.report.repairs.map((q) => q.reason)).toEqual(
      expect.arrayContaining([
        'repaired:category',
        'repaired:amount,updatedAt,notes',
        'repaired:extras',
        'dropped:categories[2]',
        'dropped:categories[3]',
        'dropped:categories[4]',
        'dropped:categoryMappings.teh',
        'dropped:categoryMappings.constructor',
        'dropped:budgets.Drinks',
        'repaired:budgets.Food',
        'dropped:deletedIds[1]',
        'dropped:deletedIds[2]',
      ]),
    )
    const byReason = (reason: string): string[] =>
      r.report.repairs.filter((q) => q.reason === reason).map((q) => q.raw)
    expect(byReason('repaired:category')).toEqual([
      JSON.stringify(v4rec('n3', { category: 'Food\tStall' })),
    ])
    expect(byReason('dropped:categoryMappings.teh')).toEqual(['["teh",""]'])
    const repairedEntries = r.report.repairs.filter((q) => q.reason.startsWith('repaired:'))
    expect(r.report.repaired).toBe(repairedEntries.length)
    expect(r.report.quarantined.map((q) => q.reason)).toEqual(['bad-name'])
  })

  it('a v0.8 name of any length migrates losslessly: category, item, budget and mapping (R5)', () => {
    const item = `Receipt ${'line '.repeat(60)}`.trim()
    const legacy = fromV4Keys({
      expenses: [v4rec('n2', { category: longName }), v4rec('n8', { itemName: item })],
      categories: [longName],
      categoryBudgets: { [longName]: 50 },
      categoryMappings: { [item.toLowerCase()]: longName },
    })
    expect(longName.length).toBeGreaterThan(60)
    expect(item.length).toBeGreaterThan(200)
    const r = decodeWire(legacy, 'local-v4', { legacyRank: 0 })
    expect(r.report.quarantined).toEqual([])
    expect(r.report.repairs).toEqual([])
    expect(must(r.doc.expenses.get('n2')).c.v).toBe(longName)
    expect(must(r.doc.expenses.get('n8')).n.v).toBe(item)
    expect(r.doc.categories).toEqual([longName])
    expect(must(r.doc.budgets.get(longName)).value).toBe(50)
    expect(must(r.doc.mappings.get(item.toLowerCase())).v).toBe(longName)
    // and the mirror written back holds every one of them
    const m = toV4Mirror(r.doc)
    for (const k of ['expenses', 'categories', 'categoryBudgets', 'categoryMappings'] as const) {
      expect(m[k], k).toContain(k === 'expenses' ? item : longName)
    }
    expect(m.expenses).toContain(longName)
  })

  it('dropped x5 pieces keep their originals too, with their keys', () => {
    const r = decodeWire(
      v4({
        x5: {
          schema: 5,
          ren: { Food: 'x' },
          mts: { kopi: 'soon' },
          pref: { currency: [T0, 'sgd'] },
          devs: { d1: { n: 5 } },
        },
      }),
      'remote',
    )
    expect(r.report.repairs.map((q) => [q.reason, q.raw])).toEqual([
      ['dropped:x5.ren.Food', '["Food","x"]'],
      ['dropped:x5.mts.kopi', '["kopi","soon"]'],
      ['dropped:x5.pref.currency', `["currency",[${String(T0)},"sgd"]]`],
      ['dropped:x5.devs.d1', '["d1",{"n":5}]'],
    ])
  })

  it('a clean payload logs nothing, and decoding the repaired doc again repairs nothing', () => {
    const first = decodeWire(raw, 'local-v4', { legacyRank: 1 })
    const again = decodeWire(parseJson(wireString(first.doc)), 'local-envelope')
    expect(again.report.repairs).toEqual([])
    expect(again.report.repaired).toBe(0)
    expect(decodeWire(v4(), 'remote').report.repairs).toEqual([])
  })
})

describe('decoding is the same in every time zone (hard constraint 5, I4)', HEAVY, () => {
  // zone-less instants: Date.parse would read them as device-local time
  const payload = {
    version: '4.0',
    exportDate: '2026-10-18T06:00:00',
    expenses: [
      v4rec('a1', {
        date: '2026-10-18T12:00:00',
        createdAt: '2026-10-18T12:00:00',
        updatedAt: '2026-10-18T13:00:00',
      }),
      v4rec('a2', { date: '2026-10-18T12:00:00', createdAt: undefined }),
    ],
    categories: ['Food'],
    budgets: { Food: 300 },
    wr: { app: '0.8.5', dev: 'old-phone', rev: 'r', at: '2026-10-18T07:00:00' },
  }

  it('stamps, encoded records and the digest are fixed values, whatever process.env.TZ is', () => {
    const r = decodeWire(parseJson(JSON.stringify(payload)), 'remote')
    const a1 = must(r.doc.expenses.get('a1'))
    const a2 = must(r.doc.expenses.get('a2'))
    expect([a1.C, a1.n.s, a1.n.r]).toEqual([
      Date.UTC(2026, 9, 18, 12),
      Date.UTC(2026, 9, 18, 13),
      1,
    ])
    expect([a2.C, a2.a.s]).toEqual([Date.UTC(2026, 9, 18, 12), Date.UTC(2026, 9, 18, 12)])
    expect(must(r.doc.budgets.get('Food')).set).toBe(Date.UTC(2026, 9, 18, 6))
    expect(must(r.doc.devices.get('old-phone')).seen).toBe(Date.UTC(2026, 9, 18, 7))
    expect(recordString(a1)).toBe(
      '{"id":"a1","itemName":"Lunch","amount":5.5,"category":"Food","date":"2026-10-18T12:00:00",' +
        '"createdAt":"2026-10-18T12:00:00","updatedAt":"2026-10-18T13:00:00.000Z"}',
    )
    expect(digestDoc(r.doc)).toBe('2c2198747653fa26')
    // a v5 edit on top: the same stamps, seal and bytes on every device
    const clock: Hlc = { last: 0 }
    const after = updateExpense(r.doc, ctx(Date.UTC(2026, 9, 17), clock), 'a2', { amount: 8 })
    expect(recordString(must(after.doc.expenses.get('a2')))).toBe(
      '{"id":"a2","itemName":"Lunch","amount":8,"category":"Food","date":"2026-10-18T12:00:00",' +
        '"createdAt":"2026-10-18T12:00:00","updatedAt":"2026-10-18T12:00:00.001Z",' +
        '"fs":{"n":[1792324800000,1],"a":1792324800001,"c":[1792324800000,1],' +
        '"d":[1792324800000,1],"o":[1792324800000,1],"x":[1792324800000,1]},"h":"1fk0hpn"}',
    )
  })
})

describe(
  'no free derived id (§4.3): kept in the quarantine, never placed under a taken id',
  HEAVY,
  () => {
    const candidates = (first: string): string[] => [
      first,
      ...Array.from({ length: 998 }, (_, i) => `${first}.${String(i + 2)}`),
    ]

    it('a live-and-deleted local row whose every revive id is tombstoned', () => {
      const open = decodeWire(v4({ deletedIds: ['e1'] }), 'local-envelope')
      const first = must([...open.doc.expenses.keys()][0])
      const r = decodeWire(v4({ deletedIds: ['e1', ...candidates(first)] }), 'local-envelope', {
        at: 3,
      })
      expect(r.doc.expenses.size).toBe(0)
      expect(r.report.liveAndDeleted).toBe(0)
      expect(r.report.quarantined.map((q) => [q.reason, q.at])).toEqual([['no-free-id', 3]])
      expect(prop(parseJson(must(r.report.quarantined[0]).raw), 'itemName')).toBe('Lunch')
    })

    it('a duplicated id whose every dedupe id is tombstoned', () => {
      const copies = [
        v4rec('dup', { itemName: 'Lunch A' }),
        v4rec('solo'),
        v4rec('dup', { itemName: 'Lunch B' }),
      ]
      const open = decodeWire(v4({ expenses: copies }), 'file')
      const idOf = (name: string): string =>
        must([...open.doc.expenses.values()].find((rec) => rec.n.v === name)).id
      const r = decodeWire(
        v4({ expenses: copies, deletedIds: candidates(idOf('Lunch A')) }),
        'file',
      )
      expect([...r.doc.expenses.keys()].sort()).toEqual([idOf('Lunch B'), 'solo'].sort())
      expect(r.report.quarantined.map((q) => q.reason)).toEqual(['no-free-id'])
      expect(prop(parseJson(must(r.report.quarantined[0]).raw), 'itemName')).toBe('Lunch A')
    })
  },
)
