// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0 } from '../__tests__/support/gen'
import { must, parseJson } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { displayList } from './categories'
import { EMPTY_DOC, mergeDoc } from './doc'
import { reviveId } from './ids'
import {
  OpError,
  addExpense,
  applyImport,
  deleteAllEverywhere,
  planImport,
  undo,
  updateExpense,
} from './ops'
import { encodeRecord, recordString } from './record'
import type { Doc, Hlc, OpCtx } from './types'
import { decodeWire, encodeBackupFile } from './wire'

const mk = (wall: number, clock: Hlc, seed = 1): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(seed).next,
})
const fileOf = (d: Doc) => decodeWire(parseJson(JSON.stringify(encodeBackupFile(d))), 'file')

function rows(c: Hlc, n: number, start = 0): Doc {
  let d: Doc = EMPTY_DOC
  for (let i = start; i < start + n; i++) {
    d = addExpense(d, mk(T0 + i, c, i + 1), {
      itemName: `row ${i}`,
      amount: i + 1,
      category: 'Food',
    }).doc
  }
  return d
}

describe('planImport (§7.7)', HEAVY, () => {
  it('counts added, restored, updated, already here and unreadable exactly', () => {
    const c: Hlc = { last: 0 }
    const base = rows(c, 5)
    const file = fileOf(base)
    const ids = [...base.expenses.keys()].sort()
    // local: id0 deleted, id1 edited later (newer kept), id2 absent, id3/id4 identical
    let local: Doc = {
      ...base,
      expenses: new Map([...base.expenses].filter(([id]) => id !== ids[2])),
    }
    local = {
      ...local,
      expenses: new Map([...local.expenses].filter(([id]) => id !== ids[0])),
      tombs: new Map([[must(ids[0]), T0 + 50]]),
    }
    local = updateExpense(local, mk(T0 + 60, c), must(ids[1]), { amount: 99 }).doc
    const plan = planImport(local, file)
    expect(plan.counts).toEqual({
      inFile: 5,
      added: 1,
      restored: 1,
      updated: 0,
      alreadyHere: 3,
      unreadable: 0,
      deletedInFile: 0,
    })
    // the file wins only with strictly newer stamps: an older local copy is updated
    const stale = updateExpense(base, mk(T0 + 70, c), must(ids[3]), { amount: 7 }).doc
    const newer = planImport(local, fileOf(stale))
    expect(newer.counts.updated).toBe(1)
  })

  it('reports unreadable rows and refuses newer or oversized files', () => {
    const bad = decodeWire(
      { version: '4.0', expenses: [{ id: 'x', itemName: '', amount: 1, date: 'x' }] },
      'file',
    )
    expect(planImport(EMPTY_DOC, bad).counts.unreadable).toBe(1)
    expect(() =>
      planImport(EMPTY_DOC, decodeWire({ version: '6.0', expenses: [] }, 'file')),
    ).toThrow(OpError)
    const many = {
      version: '4.0',
      expenses: Array.from({ length: 50_001 }, (_, i) => ({
        id: `e${i}`,
        itemName: 'x',
        amount: 1,
        date: '2026-10-18',
      })),
    }
    try {
      planImport(EMPTY_DOC, decodeWire(many, 'file'))
      expect.unreachable()
    } catch (e) {
      expect(e instanceof OpError ? e.code : 'other').toBe('too-many')
    }
  })

  it('a deleted row whose every revive id is taken is counted as not applied, never forced', () => {
    const c: Hlc = { last: 0 }
    const base = rows(c, 1)
    const rec = must([...base.expenses.values()][0])
    const file = fileOf(base)
    const deleted = deleteAllEverywhere(base, mk(T0 + 10, c)).doc
    const first = must(reviveId(rec, 'Food', () => false))
    const used = [first, ...Array.from({ length: 998 }, (_, i) => `${first}.${String(i + 2)}`)]
    const full: Doc = {
      ...deleted,
      tombs: new Map([...deleted.tombs, ...used.map((id) => [id, T0] as const)]),
    }
    expect(planImport(full, file).counts).toEqual({
      inFile: 1,
      added: 0,
      restored: 0,
      updated: 0,
      alreadyHere: 0,
      unreadable: 1,
      deletedInFile: 0,
    })
    const r = applyImport(full, mk(T0 + 20, c), planImport(full, file), 'restore')
    expect(r.doc).toBe(full)
    expect(r.touched).toEqual([])
  })
})

describe('a file row the file itself lists as deleted (§8.2, §7.7)', HEAVY, () => {
  // a v0.8 export taken while two tabs were open: 'Grab to camp' is live AND in deletedIds
  const grab = {
    id: 'lq3x9k2abc',
    itemName: 'Grab to camp',
    amount: 21,
    category: 'Transport',
    date: '2026-10-18T04:00:00.000Z',
    createdAt: '2026-10-18T13:02:11.123Z',
  }
  const kopi = { ...grab, id: 'lq3x9k2xyz', itemName: 'kopi', amount: 1.8, category: 'Food' }
  const raw = {
    version: '4.0',
    exportDate: '2026-10-19T00:00:00.000Z',
    expenses: [grab, kopi],
    categories: ['Transport', 'Food'],
    categoryMappings: {},
    deletedIds: [grab.id],
  }

  it('is counted in the preview and kept in the report, never silently missing', () => {
    const file = decodeWire(raw, 'file', { at: 1 })
    expect(file.report.liveAndDeleted).toBe(1)
    const kept = file.report.repairs.filter((q) => q.reason === 'live-and-deleted')
    expect(kept.map((q) => [q.at, q.origin])).toEqual([[1, 'file']])
    expect(parseJson(must(kept[0]).raw)).toMatchObject(grab)
    const plan = planImport(EMPTY_DOC, file)
    expect(plan.counts).toEqual({
      inFile: 1,
      added: 1,
      restored: 0,
      updated: 0,
      alreadyHere: 0,
      unreadable: 0,
      deletedInFile: 1,
    })
    // every raw row is accounted for: readable + unreadable + deleted in the file
    const { inFile, unreadable, deletedInFile } = plan.counts
    expect(inFile + unreadable + deletedInFile).toBe(raw.expenses.length)
    // the file's own tombstone wins, as v0.8 restores it: restore adds kopi only
    const r = applyImport(EMPTY_DOC, mk(T0, { last: 0 }), plan, 'restore')
    expect([...r.doc.expenses.values()].map((x) => x.n.v)).toEqual(['kopi'])
  })
})

describe('applyImport restore (§7.7, T-004-1 core)', HEAVY, () => {
  it('restores a cleared ledger under revived ids that survive a merge with the clearer, and never deletes', () => {
    const c: Hlc = { last: 0 }
    const base = rows(c, 6)
    const file = fileOf(base)
    const cleared = deleteAllEverywhere(base, mk(T0 + 100, c)).doc
    const extra = addExpense(cleared, mk(T0 + 101, c, 77), {
      itemName: 'after clear',
      amount: 3,
    }).doc
    const r = applyImport(extra, mk(T0 + 200, c), planImport(extra, file), 'restore')
    expect(r.doc.expenses.size).toBe(7)
    expect([...r.doc.expenses.values()].map((x) => x.n.v)).toContain('after clear')
    // the clearer's state (all tombstones) does not undo the restore
    const synced = mergeDoc(cleared, r.doc).doc
    expect(synced.expenses.size).toBe(7)
    // restoring the same file twice adds nothing
    const twice = applyImport(r.doc, mk(T0 + 300, c), planImport(r.doc, file), 'restore')
    expect(twice.doc.expenses.size).toBe(7)
    expect(planImport(r.doc, file).counts).toMatchObject({ restored: 0, added: 0 })
    // two devices restoring the same file derive the same ids
    const c2: Hlc = { last: 0 }
    const other = applyImport(extra, mk(T0 + 900, c2, 5), planImport(extra, file), 'restore').doc
    expect([...other.expenses.keys()].sort()).toEqual([...r.doc.expenses.keys()].sort())
  })

  it('two tombstoned file rows with one root and the same content revive into ONE row', () => {
    const c: Hlc = { last: 0 }
    const one = rows(c, 1)
    const [orig] = [...one.expenses.values()]
    const copy = { ...must(orig), id: `${must(orig).id}~r1a2b3c` }
    const fileDoc: Doc = { ...one, expenses: new Map([...one.expenses, [copy.id, copy]]) }
    const local: Doc = {
      ...EMPTY_DOC,
      tombs: new Map([...fileDoc.expenses.keys()].map((id) => [id, T0 + 5])),
    }
    const r = applyImport(local, mk(T0 + 10, c), planImport(local, fileOf(fileDoc)), 'restore')
    expect(r.doc.expenses.size).toBe(1)
    expect(r.undo?.items).toHaveLength(1)
  })

  it('ignores the file’s tombstones and joins its categories, mappings and budgets', () => {
    const c: Hlc = { last: 0 }
    const local = rows(c, 2)
    const fileDoc: Doc = {
      ...rows({ last: 0 }, 1, 50),
      tombs: new Map([...local.expenses.keys()].map((id) => [id, T0 + 999])),
      categories: ['Food', 'Gym'],
      mappings: new Map([['gym pass', { v: 'Gym', s: T0 }]]),
      budgets: new Map([['Gym', { value: 40, set: T0, del: 0 }]]),
    }
    const r = applyImport(local, mk(T0 + 10, c), planImport(local, fileOf(fileDoc)), 'restore')
    expect(r.doc.expenses.size).toBe(3)
    expect(r.doc.tombs.size).toBe(0)
    expect(displayList(r.doc)).toContain('Gym')
    expect(r.doc.mappings.get('gym pass')?.v).toBe('Gym')
    expect(r.doc.budgets.get('Gym')?.value).toBe(40)
    expect(r.undo?.label).toBe('Imported backup')
  })

  it('import undo tombstones added/revived rows that are untouched since', () => {
    const c: Hlc = { last: 0 }
    const file = fileOf(rows({ last: 0 }, 3, 10))
    const r = applyImport(EMPTY_DOC, mk(T0 + 10, c), planImport(EMPTY_DOC, file), 'restore')
    const u = undo(r.doc, mk(T0 + 20, c), must(r.undo))
    expect(u.doc.expenses.size).toBe(0)
    expect(u.report).toEqual({ applied: 3, skipped: 0 })
  })
})

describe('applyImport joins every register of the file', HEAVY, () => {
  it('a file rename and a file currency are joined and queued for sync', () => {
    const c: Hlc = { last: 0 }
    const local = rows(c, 2)
    const fileDoc: Doc = {
      ...local,
      renames: new Map([
        ['Food', { to: 'Meals', s: T0 + 30 }],
        ['Meals', { to: null, s: T0 + 30 }],
      ]),
      prefs: new Map([['currency', { v: 'EUR', s: T0 + 30 }]]),
    }
    const r = applyImport(local, mk(T0 + 40, c), planImport(local, fileOf(fileDoc)), 'restore')
    expect([...r.doc.expenses.values()].map((x) => x.c.v)).toEqual(['Meals', 'Meals'])
    expect(r.doc.prefs.get('currency')?.v).toBe('EUR')
    const keys = r.touched.map(([k]) => k)
    expect(keys).toEqual(expect.arrayContaining(['ren:Food', 'ren:Meals', 'pref:currency']))
  })
})

describe('applyImport replace (§7.7)', HEAVY, () => {
  it('rewrites unknown fields (extras) to the file’s too, at a fresh stamp', () => {
    const c: Hlc = { last: 0 }
    const local = rows(c, 1)
    const [rec] = [...local.expenses.values()]
    const raw = { ...encodeRecord(must(rec)), kind: 'transfer' }
    const file = decodeWire(
      parseJson(JSON.stringify({ spendtrack: 'backup', version: '5.0', expenses: [raw] })),
      'file',
    )
    const r = applyImport(local, mk(T0 + 100, c), planImport(local, file), 'replace')
    const after = must(r.doc.expenses.get(must(rec).id))
    expect(after.x.v.kind).toBe('transfer')
    expect(after.x.s).toBeGreaterThan(T0 + 99)
    expect(after.x.r).toBe(2)
  })

  it('tombstones live ids not in the file; file rows become current with fresh stamps', () => {
    const c: Hlc = { last: 0 }
    const local = rows(c, 3)
    const keep = must([...local.expenses.keys()].sort()[0])
    const fileDoc: Doc = {
      ...local,
      expenses: new Map([[keep, must(local.expenses.get(keep))]]),
    }
    const edited = updateExpense(local, mk(T0 + 50, c), keep, { amount: 500 }).doc
    const r = applyImport(edited, mk(T0 + 100, c), planImport(edited, fileOf(fileDoc)), 'replace')
    expect([...r.doc.expenses.keys()]).toEqual([keep])
    expect(must(r.doc.expenses.get(keep)).a.v).toBe(must(local.expenses.get(keep)).a.v)
    expect(must(r.doc.expenses.get(keep)).a.s).toBeGreaterThan(T0 + 50)
    expect(r.doc.tombs.size).toBe(2)
    expect(r.undo?.label).toBe('Replaced data with backup')
    // replace survives the next sync with a device that still has the old rows
    expect([...mergeDoc(edited, r.doc).doc.expenses.keys()]).toEqual([keep])
    const back = undo(r.doc, mk(T0 + 200, c), must(r.undo))
    expect(back.doc.expenses.size).toBe(3)
    expect(recordString(must(back.doc.expenses.get(keep)))).not.toBe('')
  })
})
