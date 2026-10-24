// @vitest-environment node
// Old-client guarantees G1–G6 (§12.1), each against the frozen models on the virtual network.
import { describe, expect, it } from 'vitest'
import { mergeDoc } from '../../core/doc'
import { addExpense, updateExpense } from '../../core/ops'
import { iso } from '../../core/stamp'
import { decodeWire, encodeWire, movedMarker } from '../../core/wire'
import { V085Client } from '../legacy/v085'
import { CALM } from '../sim/relay'
import { PureDevice, SIM_TIMEOUT, World } from '../sim/world'
import { HOUR, T0 } from '../support/gen'
import { must, parseJson } from '../support/must'

const D = '2026-10-18'

describe('old-client guarantees (§12.1)', () => {
  it(
    'G1: an old client’s stale whole-array write cannot remove v5 data; v5 re-publishes it',
    async () => {
      const w = new World({ seed: 1, devices: [{ kind: 'v5' }, { kind: 'v5' }], net: CALM })
      await w.setup()
      const a = must(w.v5[0])
      for (let i = 0; i < 10; i++)
        a.op((doc, ctx) => addExpense(doc, ctx, { itemName: `row ${i}`, amount: i + 1, day: D }))
      await w.settle()
      // a v0.8.4 tab that never saw the rows overwrites the relay with its own (empty) state
      w.relay.poke('old tab', {
        version: '4.0',
        exportDate: iso(T0),
        expenses: [],
        categories: ['Other'],
        categoryMappings: {},
        deletedIds: [],
      })
      await w.settle()
      for (const d of w.v5) expect(d.doc.expenses.size).toBe(10)
      expect(decodeWire(parseJson(must(w.relay.row)), 'remote').doc.expenses.size).toBe(10)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it('G2: an old client cannot override a newer v5 field write', () => {
    const time = { now: T0 }
    const v5 = new PureDevice('v5', time)
    v5.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'grab', amount: 12, day: D }))
    const old = encodeWire(v5.doc) // the old client's copy, taken now
    const id = must([...v5.doc.expenses.keys()][0])
    time.now = T0 + 2 * HOUR
    v5.op((doc, ctx) => updateExpense(doc, ctx, id, { notes: 'to camp' })) // T2
    const stale = {
      ...old,
      x5: undefined,
      expenses: old.expenses.map((r) => ({ ...r, amount: 21, updatedAt: iso(T0 + HOUR) })), // T1 < T2
    }
    const m = mergeDoc(v5.doc, decodeWire(parseJson(JSON.stringify(stale)), 'remote').doc).doc
    const rec = must(m.expenses.get(id))
    expect([rec.a.v, rec.o.v]).toEqual([21, 'to camp'])
  })

  it(
    'G3: v5 never makes an old client lose its writes',
    async () => {
      const w = new World({ seed: 2, devices: [{ kind: 'v5' }, { kind: 'v085' }], net: CALM })
      await w.setup()
      const v5 = must(w.v5[0])
      const phone = must(w.old[0]).client
      const x = must(
        v5.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'X', amount: 1, day: D })).created,
      ).id
      await w.settle()
      phone.updateExpense(x, { amount: 7 })
      const y = phone.addExpense({ itemName: 'Y', amount: 3 }).id
      await w.clock.run(400)
      v5.op((doc, ctx) => updateExpense(doc, ctx, x, { notes: 'v5 note' }))
      await w.settle()
      const px = must(phone.s.expenses.find((r) => r.id === x))
      expect([px.amount, px.notes]).toEqual([7, 'v5 note'])
      expect(phone.s.expenses.some((r) => r.id === y)).toBe(true)
      expect(v5.doc.expenses.has(y)).toBe(true)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'G4: no ping-pong: v5 + v0.8.5 go quiet; v5 next to v0.8.4 pushes ≤ 1 per 10 minutes',
    async () => {
      const quiet = new World({ seed: 3, devices: [{ kind: 'v5' }, { kind: 'v085' }], net: CALM })
      await quiet.setup()
      await quiet.runOps(30)
      await quiet.settle()
      const writes = quiet.relay.writes
      await quiet.clock.run(30 * 60_000)
      expect(quiet.relay.writes - writes).toBe(0)
      quiet.stop()

      const noisy = new World({ seed: 3, devices: [{ kind: 'v5' }, { kind: 'v084' }], net: CALM })
      await noisy.setup()
      await noisy.runOps(30)
      await noisy.clock.run(30_000)
      const v5 = must(noisy.v5[0])
      const pushes = v5.pushes
      await noisy.clock.run(30 * 60_000)
      expect(v5.pushes - pushes).toBeLessThanOrEqual(3)
      noisy.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'G5: fail closed: the moved marker stops v0.8.4 (throws before pushing), v0.8.5 and v5',
    async () => {
      for (const peer of ['v084', 'v085'] as const) {
        const w = new World({ seed: 4, devices: [{ kind: 'v5' }, { kind: peer }], net: CALM })
        await w.setup()
        await w.settle()
        w.relay.poke('rotation', movedMarker('private', iso(T0)))
        const writes = w.relay.writes
        const phone = must(w.old[0]).client
        phone.addExpense({ itemName: 'after the move', amount: 1 })
        must(w.v5[0]).op((doc, ctx) =>
          addExpense(doc, ctx, { itemName: 'v5 after the move', amount: 1, day: D }),
        )
        await w.clock.run(10 * 60_000)
        expect(w.relay.writes, peer).toBe(writes)
        expect(must(w.v5[0]).paused).toBe('moved')
        if (phone instanceof V085Client) expect(phone.moved).toBe(true)
        w.stop()
      }
    },
    SIM_TIMEOUT,
  )

  it(
    'G6: convergence after the old client updates in place',
    async () => {
      const w = new World({
        seed: 6,
        devices: [{ kind: 'v5' }, { kind: 'v084' }, { kind: 'v085' }],
        net: CALM,
      })
      await w.setup()
      await w.runOps(80)
      await w.clock.run(15_000)
      w.upgradeAll()
      await w.settle()
      await w.resumeAll()
      expect(await w.settle()).toBe(true)
      expect(w.checkConverged()).toEqual([])
      expect(w.violations).toEqual([])
      expect(await w.rounds(5)).toBe(0)
      w.stop()
    },
    SIM_TIMEOUT,
  )
})
