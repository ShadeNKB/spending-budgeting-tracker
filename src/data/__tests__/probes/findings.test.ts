// @vitest-environment node
// Finding tests whose layer is core or sim with PR 1 in §16.2 (T-xxx-n), plus the pure half of
// T-097-1. Each test names the finding it closes in the data core.
import { describe, expect, it } from 'vitest'
import { budgetView, displayList, mappingLookup, totalBudget } from '../../core/categories'
import { MAX_T, MIRROR_ORDER } from '../../core/constants'
import { digestDoc, mergeDoc } from '../../core/doc'
import {
  OpError,
  addCategory,
  addExpense,
  applyImport,
  deleteAllEverywhere,
  deleteExpenses,
  planImport,
  renameCategory,
  removeBudget,
  setBudget,
  setCurrency,
  undo,
  updateExpense,
} from '../../core/ops'
import { guardTrips } from '../../core/push'
import { recordString, sealOf } from '../../core/record'
import { iso } from '../../core/stamp'
import type { Doc, V4Key } from '../../core/types'
import {
  decodeWire,
  encodeBackupFile,
  encodeWire,
  fromV4Keys,
  toV4Mirror,
  wireString,
} from '../../core/wire'
import { B3, T2, T3, T3_LOCAL } from '../fixtures/auditor'
import { V084Client, mergeBackups, type BackupData } from '../legacy/v084'
import { MemStorage } from '../sim/oldDevices'
import { CALM } from '../sim/relay'
import { PureDevice, PureRelay, SIM_TIMEOUT, World, syncAll } from '../sim/world'
import { DAY, HOUR, T0 } from '../support/gen'
import { must, parseJson, protoProbe } from '../support/must'
import { HEAVY, makeRng } from '../support/rng'

const D = '2026-10-18'
const ids = (d: Doc): string[] => [...d.expenses.keys()].sort()
const roundTrip = (d: Doc): Doc => decodeWire(parseJson(wireString(d)), 'remote').doc

describe('F-002', HEAVY, () => {
  it('T-002-2: after convergence 20 rounds push nothing; an unchanged remote returns the same doc', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('a', time)
    const b = new PureDevice('b', time)
    for (let i = 0; i < 30; i++) {
      time.now += 1000
      a.op((doc, ctx) =>
        addExpense(doc, ctx, { itemName: `row ${i}`, amount: i + 1, category: 'Food', day: D }),
      )
    }
    syncAll([a, b], relay)
    const writes = relay.writes
    const before = b.doc
    for (let i = 0; i < 20; i++) syncAll([a, b], relay, 1)
    expect(relay.writes).toBe(writes)
    expect(b.doc).toBe(before)
    const m = mergeDoc(b.doc, roundTrip(b.doc))
    expect(m.doc).toBe(b.doc)
    expect(m.doc.expenses).toBe(b.doc.expenses)
  })

  it(
    'T-002-3: next to a chattering v0.8.4, v5 pushes ≤ 1 per 10 virtual minutes; a lost push is retried (memo only after landing)',
    async () => {
      const w = new World({ seed: 3, devices: [{ kind: 'v5' }, { kind: 'v084' }], net: CALM })
      await w.setup()
      await w.runOps(20)
      await w.clock.run(30_000)
      const v5 = must(w.v5[0])
      const before = v5.pushes
      await w.clock.run(30 * 60_000) // 30 minutes of v0.8.4 echo-loop chatter, no local change
      expect(v5.pushes - before).toBeLessThanOrEqual(3)
      expect(w.relay.writesBy.get(must(w.old[0]).name) ?? 0).toBeGreaterThan(20) // the old client really chattered

      // adoptable news whose first push is dropped: the retry must push again within a minute
      w.relay.dropNextPush = true
      const r = v5.op((doc, ctx) =>
        addExpense(doc, ctx, { itemName: 'must reach the old phone', amount: 7 }),
      )
      const id = must(r.created).id
      await w.clock.run(60_000)
      const old = must(w.old[0]).client
      expect(old.s.expenses.map((e) => e.id)).toContain(id)
      w.stop()
    },
    SIM_TIMEOUT,
  )
})

describe('F-004', HEAVY, () => {
  async function clearAndRestore(peer: 'v085' | 'v084'): Promise<void> {
    const w = new World({ seed: 11, devices: [{ kind: 'v5' }, { kind: peer }], net: CALM })
    await w.setup()
    const v5 = must(w.v5[0])
    for (let i = 0; i < 8; i++) {
      v5.op((doc, ctx) =>
        addExpense(doc, ctx, { itemName: `row ${i}`, amount: i + 1, category: 'Food', day: D }),
      )
      await w.clock.run(3000)
    }
    await w.settle()
    const old = must(w.old[0]).client
    expect(old.s.expenses).toHaveLength(8)
    const file = decodeWire(parseJson(JSON.stringify(encodeBackupFile(v5.doc))), 'file')
    v5.op((doc, ctx) => deleteAllEverywhere(doc, ctx))
    await w.settle()
    expect(old.s.expenses).toHaveLength(0)
    v5.op((doc, ctx) => applyImport(doc, ctx, planImport(doc, file), 'restore'))
    await w.settle()
    await w.clock.run(15 * 60_000)
    expect(v5.doc.expenses.size).toBe(8)
    expect(old.s.expenses).toHaveLength(8)
    // the old client then upgrades: still 8 everywhere
    w.upgradeAll()
    await w.settle()
    await w.resumeAll()
    await w.settle()
    for (const d of w.v5) expect(d.doc.expenses.size).toBe(8)
    expect(w.checkConverged()).toEqual([])
    w.stop()
  }

  it(
    'T-004-1: a restore after delete-everywhere survives sync on every device (frozen v0.8.5 peer)',
    async () => {
      await clearAndRestore('v085')
    },
    SIM_TIMEOUT,
  )

  it(
    'T-004-1: … and with a frozen v0.8.4 peer',
    async () => {
      await clearAndRestore('v084')
    },
    SIM_TIMEOUT,
  )

  it('T-004-1 core: restore never deletes, ignores file tombstones; the same file twice adds nothing', () => {
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    for (let i = 0; i < 5; i++)
      a.op((doc, ctx) => addExpense(doc, ctx, { itemName: `r${i}`, amount: 1 + i, day: D }))
    const file = decodeWire(parseJson(JSON.stringify(encodeBackupFile(a.doc))), 'file')
    a.op((doc, ctx) => deleteAllEverywhere(doc, ctx))
    a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'kept', amount: 9, day: D }))
    a.op((doc, ctx) => applyImport(doc, ctx, planImport(doc, file), 'restore'))
    expect(a.doc.expenses.size).toBe(6)
    const again = a.op((doc, ctx) => applyImport(doc, ctx, planImport(doc, file), 'restore'))
    expect(again.doc.expenses.size).toBe(6)
  })
})

describe('F-005: T-005-1, the auditors’ payloads verbatim', HEAVY, () => {
  const reasons = (raw: unknown, origin: 'file' | 'remote' = 'file'): string[] =>
    decodeWire(raw, origin).report.quarantined.map((q) => q.reason)

  it('nothing throws; quarantine reasons, repairs and dropped keys are exact', () => {
    expect(reasons(T2.baseline)).toEqual([])
    expect(decodeWire(T2.budget_string, 'file').report.droppedKeys).toEqual(['budgets.Food'])
    expect(decodeWire(T2.category_list_object, 'file').report.droppedKeys).toEqual([
      'categories[1]',
    ])
    expect(reasons(T2.date_garbage)).toEqual(['bad-date'])
    const dup = decodeWire(T2.dup_ids, 'file')
    expect([dup.report.deduped, dup.doc.expenses.size, dup.doc.tombs.get('same')]).toEqual([
      2, 2, 0,
    ])
    expect(reasons(T2.empty_itemname)).toEqual(['bad-name'])
    const proto = decodeWire(T2.mappings_proto, 'file')
    expect([...proto.report.droppedKeys].sort()).toEqual([
      'categoryMappings.__proto__',
      'categoryMappings.constructor',
    ])
    expect(protoProbe('polluted')).toBeUndefined()
    expect(protoProbe('polluted2')).toBeUndefined()
    const notes = decodeWire(T2.notes_object, 'file')
    expect([notes.report.repaired, must([...notes.doc.expenses.values()][0]).o.v]).toEqual([
      1,
      null,
    ])

    expect(reasons(T3.poison, 'remote')).toEqual(['bad-date', 'bad-amount', 'bad-amount'])
    const poison = decodeWire(T3.poison, 'remote')
    expect(ids(poison.doc)).toEqual(['P2'])
    expect(poison.report.droppedKeys).toEqual(['categories[0]'])
    expect(decodeWire(T3.expensesNull, 'remote').writer).toBe('invalid')
    expect(reasons(T3.expensesNull, 'remote')).toEqual(['invalid-payload'])
    expect(decodeWire(T3.categoriesNumber, 'remote').report.droppedKeys).toEqual(['categories'])
    expect(decodeWire(T3.payloadArray, 'remote').writer).toBe('invalid')

    expect(reasons(B3['amount-1e9-typo'])).toEqual(['bad-amount'])
    const budget = decodeWire(B3['budget-as-string'], 'file')
    expect([budget.report.repaired, must(budget.doc.budgets.get('Food & Dining')).value]).toEqual([
      1, 300,
    ])
    expect(must(decodeWire(B3['category-number'], 'file').doc.expenses.get('iw2nz5r')).c.v).toBe(
      'Other',
    )
    expect(decodeWire(B3['category-object-in-list'], 'file').report.droppedKeys).toEqual([
      'categories[1]',
    ])
    const date = decodeWire(B3['date-not-a-date'], 'file')
    expect([reasons(B3['date-not-a-date']), ids(date.doc)]).toEqual([['bad-date'], ['i3trojq']])
    expect(decodeWire(B3['duplicate-ids'], 'file').report.deduped).toBe(2)
    expect(decodeWire(B3['notes-object'], 'file').report.repaired).toBe(1)
  })

  it('results are idempotent and merge without throwing', () => {
    const local = decodeWire(fromV4Keys({ expenses: T3_LOCAL.expenses }), 'local-v4').doc
    for (const raw of [...Object.values(T2), ...Object.values(T3), ...Object.values(B3)]) {
      for (const origin of ['file', 'remote'] as const) {
        const once = decodeWire(raw, origin)
        const twice = decodeWire(parseJson(wireString(once.doc)), 'remote')
        expect(digestDoc(twice.doc)).toBe(digestDoc(once.doc))
        expect(twice.report.quarantined).toEqual([])
        expect(twice.report.repaired).toBe(0)
        expect(() => mergeDoc(local, once.doc)).not.toThrow()
      }
    }
  })

  it('t3: a tombstone flood trips the guard; a 9999 stamp cannot overwrite', () => {
    // the owner's device migrates from v0.8.5 (Gate A), so its legacy rows rank 1
    const local = decodeWire({ ...T3_LOCAL }, 'local-v4', { legacyRank: 1 }).doc
    const flood = mergeDoc(local, decodeWire(T3.tombstoneInjection, 'remote').doc)
    expect(flood.removed).toHaveLength(500)
    expect(guardTrips(flood.removed, local)).toBe(true)
    const future = mergeDoc(local, decodeWire(T3.futureTimestamp, 'remote').doc)
    expect(must(future.doc.expenses.get('L0')).a.v).toBe(10)
  })
})

describe('F-006: T-006-1', HEAVY, () => {
  it('9999 and 2199 order as 0; a 2099 stamp loses to the user’s next edit (base + 1), reported as replaced', () => {
    const time = { now: T0 }
    const me = new PureDevice('me', time)
    me.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, day: D }))
    const rec = must([...me.doc.expenses.values()][0])
    const hostile = (updatedAt: string): Doc =>
      decodeWire(
        {
          version: '4.0',
          x5: { schema: 5, min: 4 },
          expenses: [
            {
              id: rec.id,
              itemName: 'kopi',
              amount: 99999,
              category: 'Other',
              date: rec.d.v.date,
              createdAt: rec.createdAt,
              updatedAt,
            },
          ],
        },
        'remote',
      ).doc
    for (const t of ['9999-12-31T00:00:00.000Z', '2199-12-31T00:00:00.000Z']) {
      expect(must(mergeDoc(me.doc, hostile(t)).doc.expenses.get(rec.id)).a.v).toBe(1.8)
    }
    const pinned = mergeDoc(me.doc, hostile('2099-12-31T00:00:00.000Z'))
    expect(must(pinned.doc.expenses.get(rec.id)).a.v).toBe(99999)
    // a whole-record write: the amount, and the day (an unsealed copy carries none)
    expect(pinned.replaced.map((r) => r.fields)).toEqual([['a', 'd']])
    me.doc = pinned.doc
    time.now = T0 + 1000
    me.op((doc, ctx) => updateExpense(doc, ctx, rec.id, { amount: 5 }))
    const after = mergeDoc(me.doc, hostile('2099-12-31T00:00:00.000Z'))
    expect(must(after.doc.expenses.get(rec.id)).a.v).toBe(5)
  })

  it('the top of the window (MAX_T − 1, accepted risk §21.7): ties go by value, every reversion is reported, delete + add escapes', () => {
    const time = { now: T0 }
    const me = new PureDevice('me', time)
    me.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food', day: D }),
    )
    const rec = must([...me.doc.expenses.values()][0])
    const top = MAX_T - 1
    // a forged, correctly sealed v5 record with its amount stamped at the very top of the window
    const forged: Record<string, unknown> = {
      id: rec.id,
      itemName: 'kopi',
      amount: 99999,
      category: 'Food',
      date: rec.d.v.date,
      createdAt: rec.createdAt,
      updatedAt: iso(top),
      day: D,
      fs: { a: top },
    }
    const hostile = decodeWire(
      {
        version: '4.0',
        x5: { schema: 5, min: 4, pref: { currency: [top, 'ZZZ'] } },
        expenses: [{ ...forged, h: sealOf(forged) }],
        categories: ['Food'],
        budgets: { Food: 9_999_999 },
        budgetUpdatedAt: { Food: iso(top) },
      },
      'remote',
    ).doc
    const first = mergeDoc(me.doc, hostile)
    expect(must(first.doc.expenses.get(rec.id)).a).toEqual({ v: 99999, s: top, r: 2 })
    expect(first.replaced.map((r) => r.fields)).toEqual([['a']])
    me.doc = first.doc
    // the correction cannot be stamped base + 1 (clamped): it ties at the top, and the canonical
    // value order decides ('99999' > '5'); each reversion still reaches the journal as `replaced`
    time.now += 60_000
    me.op((doc, ctx) => updateExpense(doc, ctx, rec.id, { amount: 5 }))
    expect(must(me.doc.expenses.get(rec.id)).a).toEqual({ v: 5, s: top, r: 2 })
    const again = mergeDoc(me.doc, hostile)
    expect(must(again.doc.expenses.get(rec.id)).a.v).toBe(99999)
    expect(again.replaced.map((r) => [r.before.a.v, r.after.a.v])).toEqual([[5, 99999]])
    // the escape for an entry: delete it (a tombstone always wins) and add it again
    me.doc = again.doc
    me.op((doc, ctx) => deleteExpenses(doc, ctx, [rec.id]))
    const fresh = must(
      me.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'kopi', amount: 5, day: D })).created,
    )
    const healed = mergeDoc(me.doc, hostile)
    expect([...healed.doc.expenses.values()].map((r) => [r.id, r.a.v])).toEqual([[fresh.id, 5]])
    expect(healed.editAfterDelete.map((r) => r.id)).toEqual([rec.id])
    // budgets and the synced currency have no such escape before private sync / lockdown (§21.7)
    me.doc = healed.doc
    me.op((doc, ctx) => setCurrency(doc, ctx, 'SGD'))
    me.op((doc, ctx) => setBudget(doc, ctx, 'Food', 300))
    const pinned = mergeDoc(me.doc, hostile).doc
    expect(must(pinned.prefs.get('currency')).v).toBe('ZZZ')
    expect(budgetView(pinned).Food).toBe(9_999_999)
  })
})

describe('F-010: T-010-1 core half', HEAVY, () => {
  it('prototype words as names, notes, keys and extras never throw anywhere and never pollute', () => {
    const words = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']
    const raw = parseJson(
      JSON.stringify({
        version: '4.0',
        x5: {
          schema: 5,
          min: 4,
          ren: Object.fromEntries(words.map((w) => [w, [T0, 'Food']])),
          mts: Object.fromEntries(words.map((w) => [w, T0])),
          pref: Object.fromEntries(words.map((w) => [w, [T0, 'x']])),
          devs: Object.fromEntries(
            words.map((w) => [w, { n: w, app: '1', m: 'table', e: 0, rs: 0, at: T0 }]),
          ),
        },
        expenses: words.map((w, i) => ({
          id: `e${i}`,
          itemName: w,
          notes: w,
          amount: 1,
          category: w,
          date: '2026-10-18',
          createdAt: '2026-10-18T04:00:00.000Z',
          [w]: 1,
          ok: w,
        })),
        categories: words,
        categoryMappings: Object.fromEntries(words.map((w) => [w, w])),
        budgets: Object.fromEntries(words.map((w) => [w, 5])),
        budgetUpdatedAt: Object.fromEntries(words.map((w) => [w, iso(T0)])),
        deletedIds: words,
      }).replace(/"__proto__"/g, '"__proto__"'),
    )
    const dec = decodeWire(raw, 'remote')
    const doc = dec.doc
    expect(doc.expenses.size).toBe(words.length)
    expect(doc.categories).toEqual([])
    expect(
      doc.mappings.size +
        doc.budgets.size +
        doc.renames.size +
        doc.prefs.size +
        doc.devices.size +
        doc.tombs.size,
    ).toBe(0)
    for (const rec of doc.expenses.values()) {
      expect(rec.c.v).toBe('Other')
      expect(Object.keys(rec.x.v)).toEqual(['ok'])
    }
    expect(displayList(doc)).toEqual(['Other'])
    expect(Object.keys(budgetView(doc))).toEqual([])
    for (const w of words) expect(mappingLookup(doc, w)).toBeNull()
    const time = { now: T0 }
    const dev = new PureDevice('d', time, 0, doc)
    for (const w of words) {
      dev.op((d, ctx) => addExpense(d, ctx, { itemName: w, amount: 2, notes: w }))
      expect(() => dev.op((d, ctx) => addCategory(d, ctx, w))).toThrow(OpError)
    }
    expect(() => roundTrip(dev.doc)).not.toThrow()
    expect(digestDoc(roundTrip(dev.doc))).toBe(digestDoc(dev.doc))
    expect(protoProbe('polluted')).toBeUndefined()
    expect(protoProbe('ok')).toBeUndefined()
  })
})

describe('F-011: T-011-1/2/3 with a frozen v0.8.5 peer', HEAVY, () => {
  it(
    'an undone delete and an undone edit survive the next sync on both devices; a field changed elsewhere is skipped',
    async () => {
      const w = new World({ seed: 5, devices: [{ kind: 'v5' }, { kind: 'v085' }], net: CALM })
      await w.setup()
      const v5 = must(w.v5[0])
      const old = must(w.old[0]).client
      const add = v5.op((doc, ctx) =>
        addExpense(doc, ctx, { itemName: 'chicken rice', amount: 4.5, category: 'Food', day: D }),
      )
      const id = must(add.created).id
      await w.settle()

      // T-011-2: edit → pushed → undo → survives
      const edit = v5.op((doc, ctx) => updateExpense(doc, ctx, id, { amount: 45 }))
      await w.settle()
      expect(old.s.expenses.find((e) => e.id === id)?.amount).toBe(45)
      v5.op((doc, ctx) => undo(doc, ctx, must(edit.undo)))
      await w.settle()
      expect(must(v5.doc.expenses.get(id)).a.v).toBe(4.5)
      expect(old.s.expenses.find((e) => e.id === id)?.amount).toBe(4.5)

      // T-011-3: the old phone changes the amount in between; the undo skips it and counts it
      const edit2 = v5.op((doc, ctx) => updateExpense(doc, ctx, id, { amount: 46 }))
      await w.settle()
      await w.clock.run(1000)
      old.updateExpense(id, { amount: 47 })
      await w.settle()
      const skipped = v5.op((doc, ctx) => undo(doc, ctx, must(edit2.undo)))
      expect(skipped.report).toEqual({ applied: 0, skipped: 1 })
      await w.settle()
      expect(must(v5.doc.expenses.get(id)).a.v).toBe(47)

      // T-011-1: delete → pushed → undo → a revived id sticks on both devices
      const del = v5.op((doc, ctx) => deleteExpenses(doc, ctx, [id]))
      await w.settle()
      expect(old.s.expenses.some((e) => e.id === id)).toBe(false)
      const u = v5.op((doc, ctx) => undo(doc, ctx, must(del.undo)))
      const revived = must([...u.doc.expenses.keys()].find((k) => k.startsWith(`${id}~r`)))
      await w.settle()
      await w.clock.run(15 * 60_000)
      expect(v5.doc.expenses.has(revived)).toBe(true)
      expect(v5.doc.expenses.has(id)).toBe(false)
      expect(old.s.expenses.map((e) => e.id)).toContain(revived)
      w.stop()
    },
    SIM_TIMEOUT,
  )
})

describe('F-012: T-012-1..4 (T-012-5 is the gossip property in props/)', HEAVY, () => {
  it('T-012-3: no doubled budget after rename or merge-into; an offline budget change under the old name shows on the new one', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('a', time)
    const b = new PureDevice('b', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 2, category: 'Food', day: D }),
    )
    a.op((doc, ctx) => setBudget(doc, ctx, 'Food', 300))
    syncAll([a, b], relay)
    time.now += HOUR
    b.op((doc, ctx) => setBudget(doc, ctx, 'Food', 350)) // offline, old name
    time.now += HOUR
    a.op((doc, ctx) => renameCategory(doc, ctx, 'Food', 'Meals'))
    syncAll([a, b], relay)
    for (const d of [a, b]) {
      expect({ ...budgetView(d.doc) }).toEqual({ Meals: 350 })
      expect(totalBudget(d.doc)).toBe(350)
    }
    time.now += HOUR
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'gym', amount: 30, category: 'Gym', day: D }),
    )
    a.op((doc, ctx) => setBudget(doc, ctx, 'Gym', 100))
    a.op((doc, ctx) => renameCategory(doc, ctx, 'Gym', 'Meals')) // merge-into-existing
    syncAll([a, b], relay)
    // Meals has no own budget key: the most recently set budget among the merged names applies
    // (§6.7), and it is counted once, never 350 + 100
    for (const d of [a, b]) {
      expect({ ...budgetView(d.doc) }).toEqual({ Meals: 100 })
      expect(totalBudget(d.doc)).toBe(100)
    }
  })

  it('T-012-4: a stale mapping never files into a dead category; re-add semantics hold', () => {
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 2, category: 'Food', day: D }),
    )
    a.op((doc, ctx) => renameCategory(doc, ctx, 'Food', 'Meals'))
    expect(mappingLookup(a.doc, 'kopi')).toBe('Meals')
    expect(
      must(a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'kopi', amount: 2 })).created).c.v,
    ).toBe('Meals')
    a.op((doc, ctx) => removeBudget(doc, ctx, 'Meals'))
    a.op((doc, ctx) => addCategory(doc, ctx, 'Food'))
    expect(displayList(a.doc).slice(0, 2)).toEqual(['Food', 'Meals'])
    // rows already materialised into Meals stay there; the mapping still targets the live Food
    expect([...a.doc.expenses.values()].every((r) => r.c.v === 'Meals')).toBe(true)
    expect(mappingLookup(a.doc, 'kopi')).toBe('Food')
  })
})

describe('F-013: T-013-1/2', HEAVY, () => {
  it('T-013-1: a 1,500-row clear stays dead on v5 even when a capped v0.8.4 peer resurrects 500', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('a', time)
    const b = new PureDevice('b', time)
    let doc = a.doc
    for (let i = 0; i < 1500; i++)
      doc = addExpense(doc, a.ctx(), { itemName: `r${i}`, amount: 1, day: D }).doc
    a.doc = doc
    syncAll([a, b], relay)
    const offlineOld: BackupData = parseBackupLike(must(relay.row)) // v0.8.4 phone, offline, holds all 1,500
    a.op((d, ctx) => deleteAllEverywhere(d, ctx))
    syncAll([a, b], relay)
    expect(b.doc.expenses.size).toBe(0)
    // another v0.8.4 merges the clear and pushes its capped list (1,000 newest by insertion)
    const clock = { now: () => T0 + DAY, setTimeout: () => 0, clearTimeout: () => undefined }
    const capped = mergeBackups(emptyBackup(), parseBackupLike(must(relay.row)), clock)
    expect(capped.deletedIds).toHaveLength(1000)
    // the offline phone merges the capped relay: 500 come back, and it pushes them
    const resurrected = mergeBackups(offlineOld, capped, clock)
    expect(resurrected.expenses).toHaveLength(500)
    relay.row = JSON.stringify(resurrected)
    const live = (d: PureDevice): number => d.doc.expenses.size
    for (const d of [a, b]) {
      const m = d.sync(relay)
      expect(m.removed).toEqual([])
      expect(live(d)).toBe(0)
    }
    // v5 re-publishes the full tombstone set; the next v0.8.4 merge kills the 500 again
    const fixed = mergeBackups(resurrected, parseBackupLike(must(relay.row)), clock)
    expect(fixed.expenses).toHaveLength(0)
  })

  it('T-013-2: deletedIds go out oldest first and are never pruned', () => {
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    let doc = a.doc
    for (let i = 0; i < 1200; i++)
      doc = addExpense(
        doc,
        { ...a.ctx(), wall: T0 + i },
        { itemName: `r${i}`, amount: 1, day: D },
      ).doc
    a.doc = doc
    for (let i = 0; i < 1200; i += 100) {
      time.now = T0 + HOUR + i
      a.op((d, ctx) => deleteExpenses(d, ctx, [...d.expenses.keys()].slice(0, 100)))
    }
    const w = encodeWire(a.doc)
    expect(w.deletedIds).toHaveLength(1200)
    const dts = [...w.x5.dts]
    expect(dts).toEqual([...dts].sort((x, y) => x - y))
    expect(roundTrip(a.doc).tombs.size).toBe(1200)
  })
})

describe('F-015: T-015-2', HEAVY, () => {
  it('a v0.8.4 payload that re-files a category at the same stamp loses on every replica (W5, W6)', () => {
    const towel = {
      id: 't1',
      itemName: 'Kitchen towel',
      amount: 3,
      category: 'Other',
      date: '2026-10-18T04:00:00.000Z',
      createdAt: '2026-10-18T04:00:00.000Z',
    }
    const mine = decodeWire(fromV4Keys({ expenses: [towel] }), 'local-v4', { legacyRank: 1 }).doc
    const straggler = decodeWire(
      { version: '4.0', expenses: [{ ...towel, category: 'Shopping' }] },
      'remote',
    ).doc
    expect(must(mergeDoc(mine, straggler).doc.expenses.get('t1')).c.v).toBe('Other')
    expect(must(mergeDoc(straggler, mine).doc.expenses.get('t1')).c.v).toBe('Other')
    // a sealed v5 record re-filed by any old client also loses (rank 0)
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'SQL course', amount: 30, category: 'Education', day: D }),
    )
    const wire = encodeWire(a.doc)
    const refiled = {
      ...wire,
      x5: undefined,
      expenses: wire.expenses.map((e) => ({ ...e, category: 'Subscriptions' })),
    }
    const m = mergeDoc(a.doc, decodeWire(parseJson(JSON.stringify(refiled)), 'remote').doc)
    expect([...m.doc.expenses.values()].map((r) => r.c.v)).toEqual(['Education'])
  })
})

describe('F-047: T-047-1', HEAVY, () => {
  it('duplicate ids in a file, local keys and a payload: identical derived ids on two devices; deleting one copy leaves the other', () => {
    const rows = [
      {
        id: 'dup',
        itemName: 'Lunch A',
        amount: 4.5,
        category: 'Food',
        date: '2026-10-15T04:00:00.000Z',
        createdAt: '2026-10-15T04:00:00.000Z',
      },
      {
        id: 'dup',
        itemName: 'Lunch B',
        amount: 9,
        category: 'Food',
        date: '2026-10-15T04:00:00.000Z',
        createdAt: '2026-10-15T04:00:00.000Z',
      },
    ]
    const viaFile = decodeWire({ version: '4.0', expenses: rows }, 'file').doc
    const viaLocal = decodeWire(fromV4Keys({ expenses: rows }), 'local-v4').doc
    const viaPull = decodeWire({ version: '4.0', expenses: [...rows].reverse() }, 'remote').doc
    expect(ids(viaLocal)).toEqual(ids(viaFile))
    expect(ids(viaPull)).toEqual(ids(viaFile))
    for (const d of [viaFile, viaLocal, viaPull]) expect(d.tombs.has('dup')).toBe(true)
    const time = { now: T0 }
    const dev = new PureDevice('d', time, 0, viaLocal)
    const [first, second] = ids(dev.doc)
    dev.op((d, ctx) => deleteExpenses(d, ctx, [must(first)]))
    expect(ids(dev.doc)).toEqual([must(second)])
    expect(recordString(must(dev.doc.expenses.get(must(second))))).toContain('Lunch')
  })

  it('restoring a file that holds a shared id never counts an entry already here twice', () => {
    const grab = {
      id: 'lq3x9k2abc',
      itemName: 'Grab to camp',
      amount: 21,
      category: 'Transport',
      date: '2026-10-18T04:00:00.000Z',
      createdAt: '2026-10-18T13:02:11.123Z',
    }
    const mrt = { ...grab, itemName: 'MRT', amount: 12 }
    const total = (d: Doc): number => [...d.expenses.values()].reduce((s, r) => s + r.a.v, 0)
    const local = decodeWire(fromV4Keys({ expenses: [grab] }), 'local-v4').doc
    const file = decodeWire({ version: '4.0', expenses: [grab, mrt] }, 'file')
    expect(planImport(local, file).counts).toEqual({
      inFile: 2,
      added: 1,
      restored: 0,
      updated: 0,
      alreadyHere: 1,
      unreadable: 0,
      deletedInFile: 0,
    })
    const time = { now: T0 }
    const dev = new PureDevice('d', time, 0, local)
    dev.op((d, ctx) => applyImport(d, ctx, planImport(d, file), 'restore'))
    expect(total(dev.doc)).toBe(33)
    expect([...dev.doc.expenses.values()].map((r) => r.n.v).sort()).toEqual(['Grab to camp', 'MRT'])
    // restoring the same file again adds nothing
    dev.op((d, ctx) => applyImport(d, ctx, planImport(d, file), 'restore'))
    expect(total(dev.doc)).toBe(33)
    // replace tombstones the shared id itself, so both split-off copies come in: still 33
    const replaced = new PureDevice('r', time, 0, local)
    replaced.op((d, ctx) => applyImport(d, ctx, planImport(d, file), 'replace'))
    expect(total(replaced.doc)).toBe(33)
    expect(replaced.doc.tombs.has(grab.id)).toBe(true)
    // a local copy edited since the backup is a different entry: kept, and the file copy is added
    const edited = new PureDevice('e', time, 0, local)
    edited.op((d, ctx) => updateExpense(d, ctx, grab.id, { amount: 22 }))
    expect(planImport(edited.doc, file).counts.added).toBe(2)
  })
})

describe('F-049 / F-096 core halves', HEAVY, () => {
  it('T-049-1: every op rejects NaN, ±Infinity, ≤ 0 and > 1e7 amounts and non-finite budgets', () => {
    const time = { now: T0 }
    const d = new PureDevice('d', time)
    d.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'x', amount: 1, category: 'Food', day: D }))
    const id = ids(d.doc)[0] ?? ''
    for (const bad of [NaN, Infinity, -Infinity, 0, -1, 1e7 + 1]) {
      expect(() =>
        d.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'x', amount: bad })),
      ).toThrow(OpError)
      expect(() => d.op((doc, ctx) => updateExpense(doc, ctx, id, { amount: bad }))).toThrow(
        OpError,
      )
      expect(() => d.op((doc, ctx) => setBudget(doc, ctx, 'Food', bad))).toThrow(OpError)
    }
  })
})

describe('F-097: T-097-1 pure half (crash-ordered mirror)', HEAVY, () => {
  /** A deleted row and a removed budget between two states; returns what a v0.8.4 client resurrects. */
  function tornResurrects(order: readonly V4Key[]): string[] {
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'x', amount: 1, category: 'Food', day: D }))
    a.op((doc, ctx) => setBudget(doc, ctx, 'Food', 300))
    const before = a.doc
    const x = ids(before)[0] ?? ''
    time.now += HOUR
    a.op((doc, ctx) => deleteExpenses(doc, ctx, [x]))
    a.op((doc, ctx) => removeBudget(doc, ctx, 'Food'))
    const oldM = toV4Mirror(before)
    const newM = toV4Mirror(a.doc)
    const staleRelay = parseBackupLike(wireString(before)) // another device has not seen the deletes
    const out: string[] = []
    for (let i = 1; i <= order.length; i++) {
      const storage = new MemStorage()
      order.forEach((k, j) => {
        storage.setItem(k, j < i ? newM[k] : oldM[k])
      })
      const deletionVisible =
        !must(storage.getItem('expenses')).includes(x) ||
        must(storage.getItem('deletedExpenseIds')).includes(x)
      const budgetGoneVisible =
        !must(storage.getItem('categoryBudgets')).includes('Food') ||
        must(storage.getItem('categoryBudgetDeletedAt')).includes('Food')
      const clock = { now: () => T0 + DAY, setTimeout: () => 0, clearTimeout: () => undefined }
      const c = new V084Client(clock, makeRng(i).next, storage, {
        pull: () => Promise.resolve(null),
        push: () => Promise.resolve(),
        subscribe: () => () => undefined,
      })
      c.hydrate()
      const merged = mergeBackups(c.exportBackup(), staleRelay, clock)
      if (deletionVisible && merged.expenses.some((e) => e.id === x))
        out.push(`row after ${must(order[i - 1])}`)
      if (budgetGoneVisible && merged.budgets?.Food !== undefined)
        out.push(`budget after ${must(order[i - 1])}`)
    }
    return out
  }

  it('a mirror torn after any of the 7 keys in MIRROR_ORDER never resurrects a deleted row or budget', () => {
    expect(tornResurrects(MIRROR_ORDER)).toEqual([])
  })

  it('v5 folding a mirror torn after any of the 7 keys is a no-op: no new live id, nothing removed', () => {
    const time = { now: T0 }
    const a = new PureDevice('a', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'Grab to camp', amount: 21, category: 'Transport', day: D }),
    )
    a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food' }))
    a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'misc', amount: 3, day: D }))
    a.op((doc, ctx) => setBudget(doc, ctx, 'Food', 300))
    const before = toV4Mirror(a.doc)
    const grab = must([...a.doc.expenses.values()].find((r) => r.n.v === 'Grab to camp')).id
    time.now += HOUR
    a.op((doc, ctx) => deleteExpenses(doc, ctx, [grab]))
    a.op((doc, ctx) => removeBudget(doc, ctx, 'Food'))
    const after = toV4Mirror(a.doc)
    const fold = (cut: number, asFold: boolean) => {
      const parsed: Partial<Record<V4Key, unknown>> = {}
      MIRROR_ORDER.forEach((k, i) => {
        parsed[k] = parseJson(i < cut ? after[k] : before[k])
      })
      const v4 = decodeWire(fromV4Keys(parsed), 'local-v4', { legacyRank: 1, fold: asFold })
      return mergeDoc(a.doc, v4.doc)
    }
    for (let cut = 0; cut <= MIRROR_ORDER.length; cut++) {
      const m = fold(cut, true)
      expect(m.doc, `torn after ${String(cut)} keys`).toBe(a.doc)
      expect(m.removed).toEqual([])
    }
    // negative control: decoded as a first migration, the cut between the two keys revives the row
    const revived = fold(MIRROR_ORDER.indexOf('deletedExpenseIds') + 1, false).doc
    expect(ids(revived).filter((id) => !a.doc.expenses.has(id))).toHaveLength(1)
  })

  it('negative control: expenses before tombstones (and values before deletion stamps) do resurrect', () => {
    const swap = (o: readonly V4Key[], a: V4Key, b: V4Key): V4Key[] =>
      o.map((k) => (k === a ? b : k === b ? a : k))
    const reversed = swap(
      swap(MIRROR_ORDER, 'deletedExpenseIds', 'expenses'),
      'categoryBudgetDeletedAt',
      'categoryBudgets',
    )
    const found = tornResurrects(reversed)
    expect(found.some((f) => f.startsWith('row'))).toBe(true)
    expect(found.some((f) => f.startsWith('budget'))).toBe(true)
  })
})

/** What a v0.8.4 client holds after reading a payload (the shipped pull trusts the shape). */
function parseBackupLike(row: string): BackupData {
  const v: unknown = JSON.parse(row)
  const r = typeof v === 'object' && v !== null ? v : {}
  const get = (k: string): unknown => Reflect.get(r, k)
  const expenses = get('expenses')
  return {
    expenses: Array.isArray(expenses) ? expenses.filter(isExpense) : [],
    categories: stringList(get('categories')),
    categoryMappings: stringMap(get('categoryMappings')),
    budgets: numberMap(get('budgets')),
    budgetUpdatedAt: stringMap(get('budgetUpdatedAt')),
    budgetDeletedAt: stringMap(get('budgetDeletedAt')),
    deletedIds: stringList(get('deletedIds')),
    exportDate: typeof get('exportDate') === 'string' ? String(get('exportDate')) : iso(T0),
    version: '4.0',
  }
}
function emptyBackup(): BackupData {
  return { expenses: [], categories: [], categoryMappings: {}, exportDate: iso(T0), version: '4.0' }
}
function isExpense(x: unknown): x is BackupData['expenses'][number] {
  return typeof x === 'object' && x !== null && typeof Reflect.get(x, 'id') === 'string'
}
function stringList(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
}
function stringMap(x: unknown): Record<string, string> {
  if (typeof x !== 'object' || x === null) return {}
  return Object.fromEntries(
    Object.entries(x).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
}
function numberMap(x: unknown): Record<string, number> {
  if (typeof x !== 'object' || x === null) return {}
  return Object.fromEntries(
    Object.entries(x).filter((e): e is [string, number] => typeof e[1] === 'number'),
  )
}
