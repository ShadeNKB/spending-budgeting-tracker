// @vitest-environment node
// The nine judge probes of §16.3, ported to the v5 API: same situations, same numbers.
import { describe, expect, it } from 'vitest'
import {
  addExpense,
  deleteAllEverywhere,
  removeCategory,
  renameCategory,
  updateExpense,
} from '../../core/ops'
import type { Doc } from '../../core/types'
import { decodeWire, fromV4Keys } from '../../core/wire'
import { mergeDoc } from '../../core/doc'
import { V085Client } from '../legacy/v085'
import { MemStorage } from '../sim/oldDevices'
import { PureDevice, PureRelay, syncAll } from '../sim/world'
import { DAY, HOUR, T0 } from '../support/gen'
import { must } from '../support/must'
import { makeRng } from '../support/rng'

const D = '2026-10-18'
const only = (d: Doc) => [...d.expenses.values()]
const firstId = (d: Doc): string => must(only(d)[0]).id

describe('judge probes (§16.3)', () => {
  it('safety/robust: a rename does not overwrite an earlier offline amount edit (45 survives)', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('A', time)
    const b = new PureDevice('B', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'chicken rice', amount: 4.5, category: 'Food', day: D }),
    )
    syncAll([a, b], relay)
    time.now = T0 + HOUR
    b.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { amount: 45 })) // B offline at camp, Wed
    time.now = T0 + 3 * DAY
    a.op((doc, ctx) => renameCategory(doc, ctx, 'Food', 'Meals')) // A renames, Sat
    syncAll([a, b], relay)
    for (const d of [a, b]) expect(only(d.doc).map((e) => [e.a.v, e.c.v])).toEqual([[45, 'Meals']])
  })

  it('safety/robust: a remove does not overwrite an earlier offline edit (300 survives)', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('A', time)
    const b = new PureDevice('B', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'gym pass', amount: 30, category: 'Gym', day: D }),
    )
    syncAll([a, b], relay)
    time.now = T0 + HOUR
    b.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { amount: 300 }))
    time.now = T0 + DAY
    a.op((doc, ctx) => removeCategory(doc, ctx, 'Gym'))
    syncAll([a, b], relay)
    for (const d of [a, b]) expect(only(d.doc).map((e) => [e.a.v, e.c.v])).toEqual([[300, 'Other']])
  })

  it('safety/robust, minimal, secure: clock skew −1 day, a later edit on the slow device wins', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const fast = new PureDevice('fast', time)
    const slow = new PureDevice('slow', time, -DAY)
    fast.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food', day: D }),
    )
    syncAll([fast, slow], relay)
    time.now = T0 + 1000
    fast.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { amount: 2 }))
    syncAll([fast, slow], relay)
    time.now = T0 + 2 * HOUR
    slow.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { amount: 3 }))
    syncAll([fast, slow], relay)
    for (const d of [fast, slow]) expect(only(d.doc).map((e) => e.a.v)).toEqual([3])
  })

  it('safety/minimal: a hostile 2199 updatedAt from the relay does not pin a record', () => {
    const time = { now: T0 }
    const me = new PureDevice('me', time)
    me.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food', day: D }),
    )
    const id = firstId(me.doc)
    const rec = must(me.doc.expenses.get(id))
    const hostile = decodeWire(
      {
        version: '4.0',
        x5: { schema: 5, min: 4 },
        expenses: [
          {
            id,
            itemName: 'kopi',
            amount: 99999,
            category: 'Food',
            date: rec.d.v.date,
            createdAt: rec.createdAt,
            updatedAt: '2199-12-31T00:00:00.000Z',
          },
        ],
      },
      'remote',
    ).doc
    me.doc = mergeDoc(me.doc, hostile).doc
    time.now = T0 + 1000
    me.op((doc, ctx) => updateExpense(doc, ctx, id, { amount: 5 })) // the user corrects it
    me.doc = mergeDoc(me.doc, hostile).doc // next pull of the (still hostile) relay
    expect(only(me.doc).map((e) => e.a.v)).toEqual([5])
  })

  it('safety/secure: rollout, the old phone’s later edit (50) survives the upgrade', () => {
    const time = { now: T0 }
    // both devices start from the same v4 data; the laptop upgrades first
    const v4 = {
      expenses: [
        {
          id: 'x',
          itemName: 'kopi',
          amount: 1,
          category: 'Food',
          date: '2026-10-01T04:00:00.000Z',
          createdAt: '2026-10-01T04:00:00.000Z',
        },
      ],
    }
    const laptop = new PureDevice(
      'laptop',
      time,
      0,
      decodeWire(fromV4Keys(v4), 'local-v4', { legacyRank: 1 }).doc,
    )
    time.now = T0 + 60_000
    laptop.op((doc, ctx) => updateExpense(doc, ctx, 'x', { amount: 5 })) // v5 edit
    // the phone (v0.8.5, offline) edits x to 50 one hour later, then upgrades in place
    const storage = new MemStorage()
    storage.setItem('expenses', JSON.stringify(v4.expenses))
    const clock = { now: () => T0 + HOUR, setTimeout: () => 0, clearTimeout: () => undefined }
    const phone = new V085Client(clock, makeRng(1).next, storage, {
      pull: () => Promise.resolve(null),
      push: () => Promise.resolve(),
      subscribe: () => () => undefined,
    })
    phone.hydrate()
    phone.updateExpense('x', { amount: 50 })
    phone.flushPendingSave()
    const migrated = decodeWire(
      fromV4Keys({ expenses: JSON.parse(must(storage.getItem('expenses'))) }),
      'local-v4',
      { legacyRank: 1 },
    ).doc
    const merged = mergeDoc(migrated, laptop.doc).doc
    expect(must(merged.expenses.get('x')).a.v).toBe(50)
    expect(must(mergeDoc(laptop.doc, migrated).doc.expenses.get('x')).a.v).toBe(50)
  })

  it('safety/secure: delete-everywhere on a +1 day clearer does not swallow a later add', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const fast = new PureDevice('fast', time, DAY)
    const slow = new PureDevice('slow', time)
    fast.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'old', amount: 1, day: '2026-10-10' }))
    syncAll([fast, slow], relay)
    fast.op((doc, ctx) => deleteAllEverywhere(doc, ctx))
    fast.sync(relay)
    time.now = T0 + HOUR // one real hour AFTER the clear
    slow.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'grab after clear', amount: 9, day: '2026-10-19' }),
    )
    syncAll([fast, slow], relay)
    for (const d of [fast, slow])
      expect(only(d.doc).map((e) => e.n.v)).toEqual(['grab after clear'])
  })

  it('safety/secure: delete-everywhere does not swallow an offline add the clearer never saw', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('a', time)
    const b = new PureDevice('b', time)
    a.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'old', amount: 1, day: '2026-10-10' }))
    syncAll([a, b], relay)
    time.now = T0 + 1000
    b.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'offline add on b', amount: 9, day: '2026-10-19' }),
    )
    time.now = T0 + 2000
    a.op((doc, ctx) => deleteAllEverywhere(doc, ctx)) // a never saw b's add
    a.sync(relay)
    syncAll([a, b], relay)
    for (const d of [a, b]) expect(only(d.doc).map((e) => e.n.v)).toEqual(['offline add on b'])
  })

  it('safety/secure: an add made after seeing delete-everywhere survives (+1 day clearer)', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const fast = new PureDevice('fast', time, DAY)
    const slow = new PureDevice('slow', time)
    fast.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'old', amount: 1, day: D }))
    syncAll([fast, slow], relay)
    fast.op((doc, ctx) => deleteAllEverywhere(doc, ctx))
    syncAll([fast, slow], relay)
    time.now = T0 + 60_000
    slow.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'after seeing clear', amount: 9, day: D }),
    )
    syncAll([fast, slow], relay)
    for (const d of [fast, slow])
      expect(only(d.doc).map((e) => e.n.v)).toEqual(['after seeing clear'])
  })

  it('shared: concurrent edits of different fields keep both ([21, "to camp"])', () => {
    const time = { now: T0 }
    const relay = new PureRelay()
    const a = new PureDevice('a', time)
    const b = new PureDevice('b', time)
    a.op((doc, ctx) =>
      addExpense(doc, ctx, { itemName: 'grab', amount: 12, category: 'Transport', day: D }),
    )
    syncAll([a, b], relay)
    time.now = T0 + 1000
    b.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { amount: 21 }))
    time.now = T0 + 2000
    a.op((doc, ctx) => updateExpense(doc, ctx, firstId(doc), { notes: 'to camp' }))
    syncAll([a, b], relay)
    for (const d of [a, b])
      expect(only(d.doc).map((e) => [e.a.v, e.o.v])).toEqual([[21, 'to camp']])
  })
})
