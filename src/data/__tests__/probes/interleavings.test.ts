// @vitest-environment node
// §12.3 worked interleavings (phone P, laptop L; "old" = frozen v0.8.5 unless stated). Rows 16,
// 19 and 20 need IO, RPC or the private row and are deferred to PR-2/PR-5/PR-6.
import { describe, expect, it } from 'vitest'
import { displayList } from '../../core/categories'
import { MIRROR_ORDER } from '../../core/constants'
import { mergeDoc } from '../../core/doc'
import {
  addExpense,
  applyImport,
  deleteAllEverywhere,
  deleteExpenses,
  planImport,
  renameCategory,
  undo,
  updateExpense,
} from '../../core/ops'
import type { Doc, V4Key } from '../../core/types'
import { decodeWire, encodeBackupFile, fromV4Keys, toV4Mirror } from '../../core/wire'
import { V085Client } from '../legacy/v085'
import { MemStorage } from '../sim/oldDevices'
import { CALM } from '../sim/relay'
import { PureDevice, SIM_TIMEOUT, World } from '../sim/world'
import type { V5Device } from '../sim/v5device'
import { DAY, T0 } from '../support/gen'
import { must, parseJson } from '../support/must'
import { makeRng } from '../support/rng'

const D = '2026-10-18'

async function pair(peer: 'v085' | 'v084' | 'v5' = 'v085', seed = 1): Promise<World> {
  const w = new World({ seed, devices: [{ kind: 'v5' }, { kind: peer }], net: CALM })
  await w.setup()
  await w.settle()
  return w
}
const L = (w: World): V5Device => must(w.v5[0], 'laptop')
const P = (w: World) => must(w.old[0], 'phone').client
const add = (d: V5Device, itemName: string, category = 'Food'): string =>
  must(
    d.op((doc, ctx) => addExpense(doc, ctx, { itemName, amount: 4.5, category, day: D })).created,
  ).id
const phoneHas = (w: World, id: string): boolean => P(w).s.expenses.some((e) => e.id === id)

describe('§12.3 interleavings', () => {
  it(
    '1: L adds X while P is open → X on both, and P pushes nothing',
    async () => {
      const w = await pair()
      const pushes = P(w).pushes
      const x = add(L(w), 'X')
      await w.settle()
      expect(phoneHas(w, x)).toBe(true)
      expect(P(w).pushes).toBe(pushes)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '2: P adds Y while L’s pull is in flight → no loss',
    async () => {
      const w = await pair()
      void L(w).triggerSync('manual')
      await w.clock.run(60)
      const y = P(w).addExpense({ itemName: 'Y', amount: 2 }).id
      await w.settle()
      expect(L(w).doc.expenses.has(y)).toBe(true)
      expect(phoneHas(w, y)).toBe(true)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '3: P adds during its own pull → v0.8.5 re-reads after the await (no loss); v0.8.4 still loses (F-001)',
    async () => {
      const w = await pair('v085')
      void P(w).triggerSync()
      await w.clock.run(60)
      const z = P(w).addExpense({ itemName: 'Z', amount: 3 }).id
      await w.settle()
      expect(phoneHas(w, z)).toBe(true)
      expect(L(w).doc.expenses.has(z)).toBe(true)
      w.stop()
      const old = await pair('v084')
      void P(old).triggerSync()
      await old.clock.run(60)
      const lost = P(old).addExpense({ itemName: 'Z', amount: 3 }).id
      await old.settle()
      expect(L(old).doc.expenses.has(lost)).toBe(false)
      old.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '4: L edits notes at T2, P edits amount at T1 < T2 concurrently → both survive',
    async () => {
      const w = await pair()
      const x = add(L(w), 'X')
      await w.settle()
      P(w).updateExpense(x, { amount: 50 }) // T1
      await w.clock.run(500)
      L(w).op((doc, ctx) => updateExpense(doc, ctx, x, { notes: 'to camp' })) // T2
      await w.settle()
      const rec = must(L(w).doc.expenses.get(x))
      expect([rec.a.v, rec.o.v]).toEqual([50, 'to camp'])
      expect(P(w).s.expenses.find((e) => e.id === x)).toMatchObject({
        amount: 50,
        notes: 'to camp',
      })
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '5: as 4 but P edits at T3 > T2 before seeing L’s notes → both survive (rebase); a v0.8.4 straggler loses the notes and L journals it',
    async () => {
      const w = await pair('v085')
      const x = add(L(w), 'X')
      await w.settle()
      L(w).op((doc, ctx) => updateExpense(doc, ctx, x, { notes: 'to camp' })) // T2
      await w.clock.run(10)
      P(w).updateExpense(x, { amount: 50 }) // T3, before L's push arrives
      await w.settle()
      const rec = must(L(w).doc.expenses.get(x))
      expect([rec.a.v, rec.o.v]).toEqual([50, 'to camp'])
      w.stop()

      const s = await pair('v084', 2)
      const y = add(L(s), 'Y')
      await s.settle()
      L(s).op((doc, ctx) => updateExpense(doc, ctx, y, { notes: 'to camp' }))
      await s.clock.run(10)
      P(s).updateExpense(y, { amount: 50 })
      await s.settle()
      const after = must(L(s).doc.expenses.get(y))
      expect(after.a.v).toBe(50)
      expect(after.o.v).toBeNull()
      expect(L(s).journal.some((j) => j.kind === 'replaced' && j.ids.includes(y))).toBe(true)
      s.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '6: L deletes X while P edits X → deleted on both; L journals P’s newer copy as edit-after-delete',
    async () => {
      const w = await pair()
      const x = add(L(w), 'X')
      await w.settle()
      w.relay.dropNextPush = true // L is offline: its delete reaches the relay only on the retry
      L(w).op((doc, ctx) => deleteExpenses(doc, ctx, [x]))
      await w.clock.run(5)
      P(w).updateExpense(x, { amount: 99 }) // concurrently, after the delete, before seeing it
      await w.settle()
      expect(L(w).doc.expenses.has(x)).toBe(false)
      expect(phoneHas(w, x)).toBe(false)
      expect(L(w).journal.some((j) => j.kind === 'edit-after-delete' && j.ids.includes(x))).toBe(
        true,
      )
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '7: L undoes a pushed delete → X~r is created, X stays dead, P adopts it',
    async () => {
      const w = await pair()
      const x = add(L(w), 'X')
      await w.settle()
      const del = L(w).op((doc, ctx) => deleteExpenses(doc, ctx, [x]))
      await w.settle()
      L(w).op((doc, ctx) => undo(doc, ctx, must(del.undo)))
      await w.settle()
      const revived = must([...L(w).doc.expenses.keys()].find((k) => k.startsWith(`${x}~r`)))
      expect(phoneHas(w, revived)).toBe(true)
      expect(phoneHas(w, x)).toBe(false)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '8: L renames Food → Meals → the name reaches P, L shows Meals, and nothing loops',
    async () => {
      const w = await pair()
      const x = add(L(w), 'X')
      await w.settle()
      L(w).op((doc, ctx) => renameCategory(doc, ctx, 'Food', 'Meals'))
      await w.settle()
      const before = w.relay.writes
      await w.clock.run(10 * 60_000)
      expect(w.relay.writes - before).toBeLessThanOrEqual(1)
      expect(must(L(w).doc.expenses.get(x)).c.v).toBe('Meals')
      expect(P(w).s.categories).toContain('Meals')
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '9: P renames Food → Dining unstamped → cosmetic only, no row or amount lost',
    async () => {
      const w = await pair()
      const ids = [add(L(w), 'a'), add(L(w), 'b')]
      await w.settle()
      P(w).renameCategory('Food', 'Dining')
      await w.settle()
      for (const id of ids) {
        expect(must(L(w).doc.expenses.get(id)).a.v).toBe(4.5)
        expect(phoneHas(w, id)).toBe(true)
      }
      const cats = new Set([...L(w).doc.expenses.values()].map((r) => r.c.v))
      expect(cats.size).toBe(1)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '10: L deletes everywhere while P holds an offline add Y → the clear kills only what L saw; Y survives',
    async () => {
      const w = await pair()
      for (let i = 0; i < 20; i++) add(L(w), `row ${i}`)
      await w.settle()
      const y = P(w).addExpense({ itemName: 'Y', amount: 9 }).id
      L(w).op((doc, ctx) => deleteAllEverywhere(doc, ctx))
      await w.settle()
      expect([...L(w).doc.expenses.keys()]).toEqual([y])
      expect(P(w).s.expenses.map((e) => e.id)).toEqual([y])
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '11: P clears all → L’s guard trips: snapshot and a mass journal entry (recoverable)',
    async () => {
      const w = await pair()
      for (let i = 0; i < 20; i++) add(L(w), `row ${i}`)
      await w.settle()
      P(w).clearAllExpenses()
      await w.settle()
      expect(L(w).doc.expenses.size).toBe(0)
      expect(L(w).snapshots).toHaveLength(1)
      expect(must(L(w).snapshots[0]).expenses.size).toBe(20)
      expect(L(w).journal.some((j) => j.kind === 'mass' && j.ids.length === 20)).toBe(true)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '12: L restores a backup after a clear → revived ids stick on both',
    async () => {
      const w = await pair()
      for (let i = 0; i < 5; i++) add(L(w), `row ${i}`)
      await w.settle()
      const file = decodeWire(parseJson(JSON.stringify(encodeBackupFile(L(w).doc))), 'file')
      L(w).op((doc, ctx) => deleteAllEverywhere(doc, ctx))
      await w.settle()
      L(w).op((doc, ctx) => applyImport(doc, ctx, planImport(doc, file), 'restore'))
      await w.settle()
      await w.clock.run(12 * 60_000)
      expect(L(w).doc.expenses.size).toBe(5)
      expect(P(w).s.expenses).toHaveLength(5)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '13: P replace-imports an old file → its restore is undone on P (v0.8 F-004); L is unaffected',
    async () => {
      const w = await pair()
      const x = add(L(w), 'X')
      add(L(w), 'kept')
      await w.settle()
      const oldFile = P(w).exportBackup()
      L(w).op((doc, ctx) => deleteExpenses(doc, ctx, [x]))
      await w.settle()
      P(w).importBackup(oldFile)
      await w.settle()
      expect(L(w).doc.expenses.has(x)).toBe(false)
      expect(phoneHas(w, x)).toBe(false)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '14: two v5 devices push at the same instant → one CAS wins, the other re-pulls → exactly 2 pushes, then quiet',
    async () => {
      const w = await pair('v5')
      const [a, b] = [must(w.v5[0]), must(w.v5[1])]
      const before = a.pushes + b.pushes
      a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'from a', amount: 1, day: D }))
      b.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'from b', amount: 2, day: D }))
      await w.settle()
      expect(a.pushes + b.pushes - before).toBe(2)
      expect(a.doc.expenses.size).toBe(b.doc.expenses.size)
      expect(await w.rounds(3)).toBe(0)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '15: L’s push lands but the response is lost → the next pull sees its own rev: no-op, outbox acknowledged',
    async () => {
      const w = await pair('v5')
      const l = L(w)
      const by = w.relay.writesBy.get(l.name) ?? 0
      w.relay.loseNextPushResponse = true
      add(l, 'X')
      await w.settle()
      expect((w.relay.writesBy.get(l.name) ?? 0) - by).toBe(1)
      expect(l.outbox.size).toBe(0)
      expect(must(w.v5[1]).doc.expenses.size).toBe(l.doc.expenses.size)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it('17: an old tab rewrites stale v4 keys; folding them in removes nothing (absence ≠ delete)', () => {
    const time = { now: T0 }
    const tab = new PureDevice('v5 tab', time)
    tab.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'early', amount: 1, day: D }))
    const stale = toV4Mirror(tab.doc)
    for (let i = 0; i < 3; i++)
      tab.op((doc, ctx) => addExpense(doc, ctx, { itemName: `later ${i}`, amount: 2, day: D }))
    tab.op((doc, ctx) => deleteExpenses(doc, ctx, [must([...doc.expenses.keys()][0])]))
    const parsed: Partial<Record<V4Key, unknown>> = {}
    for (const k of MIRROR_ORDER) parsed[k] = parseJson(stale[k])
    const fold = decodeWire(fromV4Keys(parsed), 'local-v4', { legacyRank: 1, fold: true })
    const m = mergeDoc(tab.doc, fold.doc)
    expect(m.removed).toEqual([])
    expect(m.doc).toBe(tab.doc)
  })

  it('18: roll L back to v0.8.5 for 2 days, then forward → v0.8.5’s later edits win, nothing else changes', () => {
    const time = { now: T0 }
    const l = new PureDevice('L', time)
    l.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food', day: D }),
    )
    l.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'grab', amount: 12, category: 'Transport', day: D }),
    )
    const [kopi, grab] = [...l.doc.expenses.values()]
      .sort((p, q) => (p.n.v < q.n.v ? -1 : 1))
      .reverse()
    const mirror = toV4Mirror(l.doc)
    const storage = new MemStorage()
    for (const k of MIRROR_ORDER) storage.setItem(k, mirror[k])
    const clock = { now: () => T0 + 2 * DAY, setTimeout: () => 0, clearTimeout: () => undefined }
    const rolledBack = new V085Client(clock, makeRng(3).next, storage, {
      pull: () => Promise.resolve(null),
      push: () => Promise.resolve(),
      subscribe: () => () => undefined,
    })
    rolledBack.hydrate()
    rolledBack.updateExpense(must(kopi).id, { amount: 2.2 })
    rolledBack.flushPendingSave()
    const back: Partial<Record<V4Key, unknown>> = {}
    for (const k of MIRROR_ORDER) back[k] = parseJson(must(storage.getItem(k)))
    const v4 = decodeWire(fromV4Keys(back), 'local-v4', { legacyRank: 1, fold: true })
    const folded = mergeDoc(l.doc, v4.doc)
    expect(must(folded.doc.expenses.get(must(kopi).id)).a.v).toBe(2.2)
    expect(folded.doc.expenses.get(must(grab).id)).toBe(l.doc.expenses.get(must(grab).id))
    expect(folded.removed).toEqual([])
  })

  it(
    '21: the relay row is deleted → an established v5 device re-creates it; the other merges',
    async () => {
      const w = await pair('v5')
      add(L(w), 'X')
      await w.settle()
      w.relay.poke('admin', null)
      expect(w.relay.row).toBeNull()
      add(L(w), 'Y')
      await w.settle()
      expect(w.relay.row).not.toBeNull()
      expect(must(w.v5[1]).doc.expenses.size).toBe(2)
      expect(w.checkConverged()).toEqual([])
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '22: a poisoned relay is repaired, a tombstone flood is snapshotted and revivable, far-future stamps do not stick',
    async () => {
      const w = await pair('v5')
      for (let i = 0; i < 12; i++) add(L(w), `row ${i}`)
      await w.settle()
      // garbage → invalid → repair push (+ a quarantine report)
      w.relay.poke('attacker', { hello: 'world' })
      await w.settle()
      expect(decodeWire(parseJson(must(w.relay.row)), 'remote').writer).toBe('v5')
      expect(w.checkConverged()).toEqual([])
      // tombstone flood → guard + snapshot → restore from the snapshot sticks
      const live = [...L(w).doc.expenses.keys()]
      w.relay.poke('attacker', {
        version: '4.0',
        expenses: [],
        deletedIds: live,
        categories: [],
        categoryMappings: {},
      })
      await w.settle()
      expect(L(w).doc.expenses.size).toBe(0)
      const snap: Doc = must(L(w).snapshots.at(-1))
      expect(snap.expenses.size).toBe(12)
      const file = decodeWire(parseJson(JSON.stringify(encodeBackupFile(snap))), 'file')
      L(w).op((doc, ctx) => applyImport(doc, ctx, planImport(doc, file), 'restore'))
      await w.settle()
      expect(L(w).doc.expenses.size).toBe(12)
      expect(must(w.v5[1]).doc.expenses.size).toBe(12)
      // far-future stamps: 9999 orders as 0
      const victim = must([...L(w).doc.expenses.values()][0])
      w.relay.poke('attacker', {
        version: '4.0',
        x5: { schema: 5, min: 4 },
        expenses: [
          {
            id: victim.id,
            itemName: 'pwned',
            amount: 99999,
            category: 'Other',
            date: victim.d.v.date,
            createdAt: victim.createdAt,
            updatedAt: '9999-12-31T00:00:00.000Z',
          },
        ],
      })
      await w.settle()
      expect(must(L(w).doc.expenses.get(victim.id)).a.v).toBe(victim.a.v)
      expect(w.checkConverged()).toEqual([])
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    '23: a v0.8.4 straggler re-files on every sync → its copies lose ties, categories stay, v5 stays quiet',
    async () => {
      const w = await pair('v084')
      const ids = [
        add(L(w), 'Kitchen towel', 'Other'),
        add(L(w), 'SQL course', 'Education'),
        add(L(w), 'SP Group electricity', 'Bills & Utilities'),
      ]
      await w.settle()
      const pushes = L(w).pushes
      await w.clock.run(30 * 60_000)
      expect(L(w).pushes - pushes).toBeLessThanOrEqual(3)
      expect(ids.map((id) => must(L(w).doc.expenses.get(id)).c.v)).toEqual([
        'Other',
        'Education',
        'Bills & Utilities',
      ])
      expect(displayList(L(w).doc)).toEqual(
        expect.arrayContaining(['Other', 'Education', 'Bills & Utilities']),
      )
      w.stop()
    },
    SIM_TIMEOUT,
  )
})
