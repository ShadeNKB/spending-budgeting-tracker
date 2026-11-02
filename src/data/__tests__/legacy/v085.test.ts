// @vitest-environment node
// Golden behaviour of the re-frozen v0.8.5 model (app 0.9.2, P2-5). Each case pins a rule of the
// shipped code; the model's equivalence with the shipped files on random inputs is proven once
// against `git archive v0.9.2` (U1 scratch) and pinned by v085.golden.test.ts.
import { describe, expect, it } from 'vitest'
import { localDay } from '../../core/dates'
import { iso } from '../../core/stamp'
import { movedMarker } from '../../core/wire'
import { VirtualClock } from '../sim/clock'
import { MemStorage } from '../sim/oldDevices'
import { CALM, Relay } from '../sim/relay'
import { T0 } from '../support/gen'
import { must, parseJson, prop } from '../support/must'
import { makeRng } from '../support/rng'
import {
  TOMBSTONE_CAP,
  V085Client,
  contentKey,
  keepLocalRefiles,
  mergeBackups,
  nextStampIso,
  readRemote,
  stampMs,
  type BackupData,
  type Expense,
} from './v085'

const clock = { now: () => T0, setTimeout: () => 0, clearTimeout: () => undefined }
const e = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  itemName: id,
  amount: 1,
  category: 'Food',
  date: '2026-10-18T04:00:00.000Z',
  createdAt: '2026-10-18T04:00:00.000Z',
  ...over,
})
const backup = (over: Partial<BackupData> = {}): BackupData => ({
  expenses: [],
  categories: ['Food'],
  categoryMappings: {},
  exportDate: '2026-10-18T00:00:00.000Z',
  version: '4.0',
  ...over,
})
const merge = (l: Partial<BackupData>, r: Partial<BackupData>): BackupData =>
  mergeBackups(backup(l), backup(r), clock)

function setup(seed = 1) {
  const vclock = new VirtualClock(T0)
  const relay = new Relay(vclock, makeRng(seed), CALM)
  const storage = new MemStorage()
  const c = new V085Client(
    vclock.port(),
    makeRng(seed + 1).next,
    storage,
    relay.legacyPort085('phone'),
  )
  return { clock: vclock, relay, storage, c }
}

async function runSync(c: V085Client, vclock: VirtualClock, ms: number): Promise<void> {
  const done = c.triggerSync()
  await vclock.run(ms)
  await done
}

function relayRecord(relay: Relay, id: string): unknown {
  const list = prop(parseJson(must(relay.row)), 'expenses')
  return Array.isArray(list) ? list.find((r: unknown) => prop(r, 'id') === id) : undefined
}

describe('lib/stamps (the window and the grammar v5 shares)', () => {
  it('orders only canonical-grammar stamps inside [2000, 2100); everything else is 0', () => {
    expect(stampMs('2026-10-18T04:00:00.000Z')).toBe(Date.parse('2026-10-18T04:00:00.000Z'))
    expect(stampMs('2026-10-18T12:00:00')).toBe(Date.UTC(2026, 9, 18, 12)) // zone-less = UTC
    for (const bad of ['9999-12-31T00:00:00.000Z', '1999-12-31T23:59:59.999Z', 'x', 5, null]) {
      expect(stampMs(bad), String(bad)).toBe(0)
    }
    expect(nextStampIso(T0, T0 + 5)).toBe(iso(T0 + 6))
    expect(nextStampIso(T0 + 9, T0)).toBe(iso(T0 + 9))
  })
})

describe('mergeBackups (whole-record last-writer-wins, deterministic ties)', () => {
  it('a newer copy wins WHOLE: no per-field merge on the v4 wire', () => {
    const notes = e('x', { notes: 'to camp', updatedAt: iso(T0 + 1000) })
    const amount = e('x', { amount: 50, updatedAt: iso(T0 + 2000) })
    expect(merge({ expenses: [notes] }, { expenses: [amount] }).expenses).toEqual([amount])
    expect(merge({ expenses: [amount] }, { expenses: [notes] }).expenses).toEqual([amount])
  })

  it('equal stamps: the larger canonical JSON wins on either side; a far-future stamp is 0', () => {
    const a = e('x', { amount: 2 })
    const b = e('x', { amount: 9 })
    expect(merge({ expenses: [a] }, { expenses: [b] }).expenses).toEqual([b])
    expect(merge({ expenses: [b] }, { expenses: [a] }).expenses).toEqual([b])
    const future = e('y', { amount: 99_999, updatedAt: '9999-12-31T00:00:00.000Z' })
    const real = e('y', { amount: 3, updatedAt: iso(T0 + 1) })
    expect(merge({ expenses: [future] }, { expenses: [real] }).expenses).toEqual([real])
  })

  it('item mappings: per key by mappingUpdatedAt; equal stamps → larger value; stamps ≤ 0 dropped', () => {
    const m = merge(
      {
        categoryMappings: { kopi: 'Drinks', rice: 'Food', tea: 'Drinks' },
        mappingUpdatedAt: { kopi: iso(T0 + 5), tea: '1970-01-01T00:00:00.000Z' },
      },
      {
        categoryMappings: { kopi: 'Food', rice: 'Meals', tea: 'Food' },
        mappingUpdatedAt: { kopi: iso(T0 + 1), rice: iso(T0) },
      },
    )
    expect(m.categoryMappings).toEqual({ kopi: 'Drinks', rice: 'Meals', tea: 'Food' })
    expect(m.mappingUpdatedAt).toEqual({ kopi: iso(T0 + 5), rice: iso(T0) })
  })

  it('budgets: deletion wins at del ≥ set and is the only half kept; equal sets → larger value', () => {
    const m = merge(
      {
        budgets: { Food: 100, Gym: 50 },
        budgetUpdatedAt: { Food: iso(T0), Gym: iso(T0) },
        budgetDeletedAt: { Transport: iso(T0 + 9) },
      },
      {
        budgets: { Food: 300, Transport: 80 },
        budgetUpdatedAt: { Food: iso(T0), Transport: iso(T0 + 9) },
        budgetDeletedAt: { Gym: iso(T0 + 1) },
      },
    )
    expect(m.budgets).toEqual({ Food: 300 })
    expect(m.budgetUpdatedAt).toEqual({ Food: iso(T0) })
    expect(m.budgetDeletedAt).toEqual({ Gym: iso(T0 + 1), Transport: iso(T0 + 9) })
  })

  it(`tombstones are unioned and always win; the list keeps the last ${TOMBSTONE_CAP} by insertion`, () => {
    const ids = Array.from({ length: TOMBSTONE_CAP + 5 }, (_, i) => `d${i}`)
    const m = merge({ deletedIds: ids, expenses: [e('d7')] }, { expenses: [e('d9'), e('kept')] })
    expect(m.expenses.map((x) => x.id)).toEqual(['kept'])
    expect(m.deletedIds).toHaveLength(TOMBSTONE_CAP)
    expect(m.deletedIds?.[0]).toBe('d5')
  })
})

describe('readRemote and contentKey (what the cycle compares)', () => {
  it('fences, invalid copies, writer classes and unreadable rows kept aside', () => {
    expect(readRemote(null).kind).toBe('empty')
    expect(readRemote(movedMarker('private', iso(T0))).kind).toBe('moved')
    expect(readRemote({ expenses: [], x5: { min: 5 } }).kind).toBe('update-required')
    expect(readRemote({ expenses: null }).kind).toBe('invalid')
    expect(readRemote('x').kind).toBe('invalid')
    const bad = { id: 'bad', itemName: 'x', amount: 'abc', date: 'x', category: 'Food' }
    const r = readRemote({ expenses: [e('ok'), bad], categories: ['Food'], wr: { rev: 'r' } })
    expect(
      r.kind === 'ok' ? [r.writer, r.data.expenses.map((x) => x.id), r.passthrough] : r,
    ).toEqual(['v085', ['ok'], [bad]])
    expect(readRemote({ expenses: [], x5: { min: 4 } })).toMatchObject({ writer: 'v5' })
    expect(readRemote({ expenses: [] })).toMatchObject({ writer: 'legacy' })
  })

  it('contentKey ignores exportDate, version, wr, x5, key and list order; not a damaged collection', () => {
    const a = backup({ expenses: [e('a'), e('b')], categories: ['A', 'B'], deletedIds: ['x', 'y'] })
    const b = {
      ...backup({
        expenses: [e('b'), e('a')],
        categories: ['B', 'A', 'A'],
        deletedIds: ['y', 'x'],
      }),
      exportDate: 'z',
      version: '5',
      wr: { rev: 'r' },
      x5: { schema: 5 },
    }
    expect(contentKey(b)).toBe(contentKey(a))
    expect(contentKey({ ...a, categories: 'Food' })).not.toBe(contentKey(a))
    const stamped = { ...a, mappingUpdatedAt: { kopi: iso(T0) } }
    expect(contentKey(stamped)).not.toBe(contentKey(a))
    expect(contentKey(stamped, { mappingStamps: false })).toBe(contentKey(a))
  })

  it('keepLocalRefiles: an unstamped re-file tie keeps the local category (legacy writers only)', () => {
    const mine = e('x', { itemName: 'Kitchen towel', category: 'Other' })
    const refiled = { ...mine, category: 'Shopping' }
    const plain = merge({ expenses: [mine] }, { expenses: [refiled] })
    expect(plain.expenses).toEqual([refiled]) // the larger canon wins the tie
    expect(keepLocalRefiles(plain, [mine], [refiled]).expenses).toEqual([mine])
  })
})

describe('V085Client: the store', () => {
  it('never re-files on hydrate, stamps forward, learns stamped picks and writes its markers', () => {
    const { c, storage } = setup()
    storage.setItem(
      'expenses',
      JSON.stringify([
        e('a', { itemName: 'Kitchen towel', category: 'Other', updatedAt: iso(T0 + 86_400_000) }),
      ]),
    )
    storage.setItem('categories', JSON.stringify(['Food', 'Education', 'Bills & Utilities']))
    c.hydrate()
    expect(c.s.expenses[0]?.category).toBe('Other')
    expect(c.s.categories).toEqual(['Food', 'Education', 'Bills & Utilities'])
    c.updateExpense('a', { amount: 5 })
    expect(c.s.expenses[0]?.updatedAt).toBe(iso(T0 + 86_400_001))
    c.addExpense({ itemName: 'Kopi O', amount: 1.8, category: 'Drinks' })
    expect(c.s.categoryMappings).toEqual({ 'kopi o': 'Drinks' })
    expect(c.s.mappingUpdatedAt).toEqual({ 'kopi o': iso(T0) })
    c.flushPendingSave()
    expect(storage.getItem('spendtrack:app')).toBe('0.8.5')
    expect(parseJson(must(storage.getItem('categoryMappingUpdatedAt')))).toEqual({
      'kopi o': iso(T0),
    })
    expect(c.dev).toMatch(/^[0-9a-z]{6}$/)
    expect(storage.getItem('spendtrack:dev')).toBe(c.dev)
  })

  it('a quick add stores the raw instant; a same-day date edit is no edit (contract §7.10)', () => {
    const { c, clock: vc } = setup()
    c.hydrate()
    vc.now = T0 + 9 * 3_600_000 + 1234
    const x = c.addExpense({ itemName: 'kopi', amount: 2 })
    expect(x.date).toBe(iso(vc.now))
    const before = c.s.expenses
    c.updateExpense(x.id, { date: `${must(localDay(x.date))}T12:00:00` })
    expect(c.s.expenses).toBe(before)
  })

  it('undo is a forward write; undo of a delete re-adds under a new id; undo of an add tombstones', () => {
    const { c, clock: vc } = setup()
    c.hydrate()
    const x = c.addExpense({ itemName: 'kopi', amount: 2 })
    vc.now += 1000
    c.updateExpense(x.id, { amount: 3 })
    const stamped = must(c.s.expenses[0]?.updatedAt)
    vc.now += 1000
    c.consumeUndo(must(c.s.undoStack.at(-1)).id)
    expect(c.s.expenses[0]?.amount).toBe(2)
    expect(Date.parse(must(c.s.expenses[0]?.updatedAt))).toBeGreaterThan(Date.parse(stamped))
    c.deleteExpense(x.id)
    c.consumeUndo(must(c.s.undoStack.at(-1)).id)
    expect(c.s.expenses.map((r) => r.id)).not.toContain(x.id)
    expect(c.s.expenses).toHaveLength(1)
    expect(c.s.deletedIds).toContain(x.id)
    const y = c.addExpense({ itemName: 'grab', amount: 12 })
    c.consumeUndo(`add-${y.id}`)
    expect(c.s.deletedIds).toContain(y.id)
  })
})

describe('V085Client: the sync cycle', () => {
  it('pushes only news, stamps wr, filters its own echo, and stops at the fence', async () => {
    const { c, relay, clock: vc } = setup()
    c.hydrate()
    c.addExpense({ itemName: 'kopi', amount: 2 })
    const started = c.setupSync('row')
    await vc.run(10_000)
    await started
    expect(c.pushes).toBe(1)
    expect(prop(parseJson(must(relay.row)), 'wr')).toMatchObject({
      app: '0.8.5',
      dev: c.dev,
      rev: c.lastRev,
    })
    // its own echo and a manual sync with nothing new: pulls, never pushes
    await runSync(c, vc, 5000)
    expect([c.pushes, relay.writesBy.get('phone')]).toEqual([1, 1])
    expect(c.cloudStatus).toBe('synced')
    // the moved marker pauses it; nothing it does afterwards is pushed
    relay.poke('elsewhere', movedMarker('private', iso(T0)))
    c.addExpense({ itemName: 'after the move', amount: 1 })
    await vc.run(20_000)
    expect([c.moved, c.cloudStatus]).toEqual([true, 'paused'])
    expect(relay.writesBy.get('phone')).toBe(1)
    c.close()
  })

  it('rows it cannot read ride along on its pushes unless deleted', async () => {
    const { c, relay, clock: vc } = setup()
    c.hydrate()
    const odd = { id: 'odd', itemName: 'v9 row', amount: 'x', date: '?', category: 'Food' }
    relay.poke('v9', { ...backup({ expenses: [e('ok')] }), expenses: [e('ok'), odd] })
    c.addExpense({ itemName: 'new', amount: 3 })
    c.syncId = 'row'
    await runSync(c, vc, 5000)
    expect(relayRecord(relay, 'odd')).toEqual(odd)
    c.close()
  })

  it('a 10-minute memo stops it re-pushing over an old writer that drops its change', async () => {
    const { c, relay, clock: vc } = setup()
    c.hydrate()
    c.addExpense({ itemName: 'mine', amount: 2 })
    relay.poke('old', backup({ expenses: [e('theirs')] }))
    c.syncId = 'row'
    await runSync(c, vc, 3000)
    expect(c.pushes).toBe(1)
    relay.poke('old', backup({ expenses: [e('theirs')] })) // the old writer drops what we added
    await runSync(c, vc, 3000)
    expect([c.pushes, c.waitingForOld]).toEqual([1, true])
    await vc.run(11 * 60_000)
    await runSync(c, vc, 3000)
    expect(c.pushes).toBe(2)
    c.close()
  })

  it('no rebase: an unpushed edit loses WHOLE to a newer copy from another device', async () => {
    const { c, relay, clock: vc } = setup()
    c.hydrate()
    c.importBackup(backup({ expenses: [e('x')] }))
    vc.now += 5000
    c.updateExpense('x', { amount: 50 }) // pending, stamped T0 + 5 s
    relay.poke(
      'laptop',
      backup({ expenses: [e('x', { notes: 'to camp', updatedAt: iso(vc.now + 1000) })] }),
    )
    c.syncId = 'row'
    await runSync(c, vc, 5000)
    expect(c.s.expenses.find((r) => r.id === 'x')).toMatchObject({ amount: 1, notes: 'to camp' })
    expect(relayRecord(relay, 'x')).toMatchObject({ amount: 1, notes: 'to camp' })
    c.close()
  })
})
