// @vitest-environment node
// Golden behaviour of the v0.8.5 model (the PR-0 contract, P-26).
import { describe, expect, it } from 'vitest'
import { iso } from '../../core/stamp'
import { movedMarker } from '../../core/wire'
import { VirtualClock } from '../sim/clock'
import { MemStorage } from '../sim/oldDevices'
import { CALM, Relay } from '../sim/relay'
import { T0 } from '../support/gen'
import { must, parseJson } from '../support/must'
import { makeRng } from '../support/rng'
import type { BackupData, Expense } from './v084'
import { TOMBSTONE_CAP_085, V085Client, mergeBackups085, sameContent, validatePull } from './v085'

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

function setup(seed = 1) {
  const clock = new VirtualClock(T0)
  const relay = new Relay(clock, makeRng(seed), CALM)
  const storage = new MemStorage()
  const port = relay.legacyPort('phone')
  const c = new V085Client(clock.port(), makeRng(seed + 1).next, storage, {
    ...port,
    subscribe: (_id, _cb) =>
      relay.subscribe('phone', (ev) => {
        const wr: unknown =
          typeof ev.payload === 'object' && ev.payload !== null
            ? Reflect.get(ev.payload, 'wr')
            : null
        const rev: unknown = typeof wr === 'object' && wr !== null ? Reflect.get(wr, 'rev') : null
        c.onRemoteEvent(typeof rev === 'string' ? rev : null)
      }),
  })
  return { clock, relay, storage, c }
}

describe('mergeBackups085 (item 2)', () => {
  it('equal stamps: the larger canonical JSON wins whichever side it is on', () => {
    const a = e('x', { amount: 2 })
    const b = e('x', { amount: 9 })
    const clock = { now: () => T0, setTimeout: () => 0, clearTimeout: () => undefined }
    expect(
      mergeBackups085(backup({ expenses: [a] }), backup({ expenses: [b] }), clock).expenses,
    ).toEqual([b])
    expect(
      mergeBackups085(backup({ expenses: [b] }), backup({ expenses: [a] }), clock).expenses,
    ).toEqual([b])
    const m = mergeBackups085(
      backup({ categoryMappings: { kopi: 'Food' } }),
      backup({ categoryMappings: { kopi: 'Drinks' } }),
      clock,
    )
    expect(m.categoryMappings).toEqual({ kopi: 'Food' })
    const big = mergeBackups085(
      backup({ categoryMappings: { kopi: 'Drinks' } }),
      backup({ categoryMappings: { kopi: 'Food' } }),
      clock,
    )
    expect(big.categoryMappings).toEqual({ kopi: 'Food' })
    const budgets = mergeBackups085(
      backup({ budgets: { Food: 100 }, exportDate: '' }),
      backup({ budgets: { Food: 300 }, exportDate: '' }),
      clock,
    )
    expect(budgets.budgets).toEqual({ Food: 300 })
  })

  it('keeps 20,000 tombstones in insertion order', () => {
    const clock = { now: () => T0, setTimeout: () => 0, clearTimeout: () => undefined }
    const ids = Array.from({ length: 20_005 }, (_, i) => `d${i}`)
    const m = mergeBackups085(backup({ deletedIds: ids }), backup(), clock)
    expect(m.deletedIds).toHaveLength(TOMBSTONE_CAP_085)
    expect(m.deletedIds?.[0]).toBe('d5')
  })

  it('sameContent ignores exportDate, version, wr, x5, key order and list order', () => {
    const a = backup({ expenses: [e('a'), e('b')], categories: ['A', 'B'], deletedIds: ['x', 'y'] })
    const b = {
      ...backup({
        expenses: [e('b'), e('a')],
        categories: ['B', 'A'],
        deletedIds: ['y', 'x'],
        exportDate: 'z',
        version: '5',
      }),
    }
    expect(sameContent(a, b)).toBe(true)
    expect(sameContent(a, backup({ expenses: [e('a')] }))).toBe(false)
  })
})

describe('validatePull (items 10, 11)', () => {
  it('drops bad rows without deleting, and recognises the fences', () => {
    const v = validatePull({
      expenses: [e('ok'), { id: 'bad', itemName: 'x', amount: 'abc', date: 'x' }],
      categories: ['Food'],
      wr: { rev: 'r' },
    })
    expect(v.kind === 'ok' ? v.data.expenses.map((x) => x.id) : []).toEqual(['ok'])
    expect(v.kind === 'ok' ? v.oldWriter : null).toBe(false)
    expect(
      validatePull({ expenses: [] }).kind === 'ok' && validatePull({ expenses: [] }),
    ).toMatchObject({ oldWriter: true })
    expect(validatePull(movedMarker('private', iso(T0))).kind).toBe('moved')
    expect(validatePull({ expenses: [], x5: { min: 99 } }).kind).toBe('moved')
    expect(validatePull({ expenses: null }).kind).toBe('error')
    expect(validatePull('x').kind).toBe('error')
  })
})

describe('V085Client', () => {
  it('stamps forward, never migrates categories, and writes its markers', () => {
    const { c, storage } = setup()
    storage.setItem(
      'expenses',
      JSON.stringify([
        e('a', {
          itemName: 'Kitchen towel',
          category: 'Other',
          updatedAt: '2030-01-01T00:00:00.000Z',
        }),
      ]),
    )
    c.hydrate()
    expect(c.s.expenses[0]?.category).toBe('Other')
    c.updateExpense('a', { amount: 5 })
    expect(c.s.expenses[0]?.updatedAt).toBe(iso(Date.parse('2030-01-01T00:00:00.000Z') + 1))
    c.flushPendingSave()
    expect(storage.getItem('spendtrack:app')).toBe('0.8.5')
    expect(must(storage.getItem('spendtrack:dev'))).toMatch(/^[0-9a-z]{6}$/)
  })

  it('undo of an edit is a forward write; undo of a delete re-adds under a new id', () => {
    const { c, clock } = setup()
    c.hydrate()
    const x = c.addExpense({ itemName: 'kopi', amount: 2 })
    clock.now += 1000
    c.updateExpense(x.id, { amount: 3 })
    const stamped = must(c.s.expenses[0]?.updatedAt)
    clock.now += 1000
    c.consumeUndo(must(c.s.undoStack.at(-1)).id)
    expect(c.s.expenses[0]?.amount).toBe(2)
    expect(Date.parse(must(c.s.expenses[0]?.updatedAt))).toBeGreaterThan(Date.parse(stamped))
    c.deleteExpense(x.id)
    c.consumeUndo(must(c.s.undoStack.at(-1)).id)
    expect(c.s.expenses.map((r) => r.id)).not.toContain(x.id)
    expect(c.s.expenses).toHaveLength(1)
    expect(c.s.deletedIds).toContain(x.id)
  })

  it('pushes only news, stamps wr, filters its own echo, and stops at the fence', async () => {
    const { c, relay, clock } = setup()
    c.hydrate()
    c.addExpense({ itemName: 'kopi', amount: 2 })
    const started = c.setupSync('row')
    await clock.run(10_000)
    await started
    expect(c.pushes).toBe(1)
    const row = parseJson(must(relay.row))
    const wr: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'wr') : null
    expect(wr).toMatchObject({ app: '0.8.5', dev: c.dev, rev: c.lastRev })
    // nothing new: a manual sync pulls but does not push
    await runSync(c, clock, 5000)
    expect(c.pushes).toBe(1)
    // the moved marker stops every push
    relay.poke('elsewhere', movedMarker('private', iso(T0)))
    c.addExpense({ itemName: 'after the move', amount: 1 })
    await clock.run(20_000)
    expect(c.moved).toBe(true)
    expect(relay.writesBy.get('phone')).toBe(1)
    c.close()
  })

  it('a 10-minute memo stops it from re-pushing over an unchanged v0.8.4 relay', async () => {
    const { c, relay, clock } = setup()
    c.hydrate()
    c.addExpense({ itemName: 'mine', amount: 2 })
    relay.poke('old', backup({ expenses: [e('theirs')] }))
    c.syncId = 'row'
    await runSync(c, clock, 3000)
    expect(c.pushes).toBe(1)
    relay.poke('old', backup({ expenses: [e('theirs')] })) // the old writer drops what we added
    await runSync(c, clock, 3000)
    expect(c.pushes).toBe(1)
    await clock.run(11 * 60_000)
    await runSync(c, clock, 3000)
    expect(c.pushes).toBe(2)
    c.close()
  })

  it('rebases a pending field edit onto a remote copy that brings another field (§12.3 row 5)', async () => {
    const { c, relay, clock } = setup()
    c.hydrate()
    c.importBackup(backup({ expenses: [e('x')] }))
    clock.now += 5000
    c.updateExpense('x', { amount: 50 }) // pending: amount, stamped T3
    relay.poke(
      'laptop',
      backup({ expenses: [e('x', { notes: 'to camp', updatedAt: iso(clock.now - 1000) })] }),
    ) // T2 < T3
    c.syncId = 'row'
    await runSync(c, clock, 5000)
    expect(c.s.expenses.find((r) => r.id === 'x')).toMatchObject({ amount: 50, notes: 'to camp' })
    expect(relayRecord(relay, 'x')).toMatchObject({ amount: 50, notes: 'to camp' })
    c.close()
  })

  it('does not rebase onto a copy that is only its own base (no needless re-stamp, §12.3 row 4)', async () => {
    const { c, relay, clock } = setup()
    c.hydrate()
    c.importBackup(backup({ expenses: [e('x')] }))
    clock.now += 5000
    c.updateExpense('x', { amount: 50 })
    const stamped = must(c.s.expenses[0]?.updatedAt)
    relay.poke('laptop', backup({ expenses: [e('x')] }))
    c.syncId = 'row'
    clock.now += 60_000
    await runSync(c, clock, 5000)
    expect(relayRecord(relay, 'x')).toMatchObject({ amount: 50, updatedAt: stamped })
    c.close()
  })
})

function relayRecord(relay: Relay, id: string): unknown {
  const row = parseJson(must(relay.row))
  const list: unknown =
    typeof row === 'object' && row !== null ? Reflect.get(row, 'expenses') : null
  return Array.isArray(list)
    ? list.find((r: unknown) => typeof r === 'object' && r !== null && Reflect.get(r, 'id') === id)
    : undefined
}

async function runSync(c: V085Client, clock: VirtualClock, ms: number): Promise<void> {
  const done = c.triggerSync()
  await clock.run(ms)
  await done
}
