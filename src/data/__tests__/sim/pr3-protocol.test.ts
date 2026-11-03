// @vitest-environment node
// The 0.11.0 sync protocol on the simulator, scripted (PR-3 track spec §3.4–§3.6, §5): the head
// short-circuit (T-018-1), one add and its echoes (T-002-1), Broadcast-only and poll-only
// delivery, the storm breaker (T-002-4), a join never creates (AC-E5/E6), the device registry and
// the 0.10.0 writer flag (AC-E18), and CAS conflicts (row 14, AC-T2). Invented data.
import { describe, expect, it } from 'vitest'
import { addExpense } from '../../core/ops'
import { newRev } from '../../core/ids'
import type { Doc } from '../../core/types'
import { encodeWire } from '../../core/wire'
import { must, parseJson, prop } from '../support/must'
import { makeRng } from '../support/rng'
import { CALM, type NetOptions } from './relay'
import { V5Device } from './v5device'
import { SIM_TIMEOUT, V010, V011, World } from './world'

const FIXED: NetOptions = { ...CALM, latency: [100, 100] }

interface Counts {
  readonly heads: number
  readonly pulls: number
  readonly pushes: number
}

function counts(w: World, name: string): Counts {
  return {
    heads: w.relay.headsBy.get(name) ?? 0,
    pulls: w.relay.pullsBy.get(name) ?? 0,
    pushes: w.relay.writesBy.get(name) ?? 0,
  }
}

const since = (w: World, name: string, before: Counts): Counts => {
  const now = counts(w, name)
  return {
    heads: now.heads - before.heads,
    pulls: now.pulls - before.pulls,
    pushes: now.pushes - before.pushes,
  }
}

/** Runs virtual time until `p` settles (or 60 s pass). */
async function finish(w: World, p: Promise<void>): Promise<void> {
  const state = { done: false }
  void p.then(() => {
    state.done = true
  })
  for (let i = 0; i < 600 && !state.done; i++) await w.clock.run(100)
}

async function pair(net: NetOptions = CALM, seed = 1): Promise<World> {
  const w = new World({ seed, devices: [V011, V011], net })
  await w.setup()
  await w.settle()
  return w
}

const add = (d: V5Device, itemName: string): string =>
  must(
    d.op((doc, ctx) => addExpense(doc, ctx, { itemName, amount: 4.5, category: 'Food' })).created,
  ).id

/** Waits (100 ms steps, at most `ms`) until `d` holds `id`; returns how long it took. */
async function arrival(w: World, d: V5Device, id: string, ms: number): Promise<number> {
  const start = w.clock.now
  while (!d.doc.expenses.has(id) && w.clock.now - start < ms) await w.clock.run(100)
  return w.clock.now - start
}

/** Waits until `d` has landed one more push than `before`; returns the time it landed. */
async function landed(w: World, d: V5Device, before: number): Promise<number> {
  for (let i = 0; i < 300 && d.pushes === before; i++) await w.clock.run(100)
  return w.clock.now
}

function relayDevs(w: World): Record<string, unknown> {
  const devs = prop(prop(parseJson(must(w.relay.row)), 'x5'), 'devs')
  return typeof devs === 'object' && devs !== null ? { ...devs } : {}
}

describe('0.11.0 protocol on the simulator', () => {
  it(
    'T-018-1: resume, poll, resubscribe and online with nothing pending make one HEAD each, no pull or push; a changed etag pulls; a pending change skips the HEAD',
    async () => {
      const w = await pair()
      const a = must(w.v5[0])
      const b = must(w.v5[1])
      for (const reason of ['resume', 'poll', 'resubscribe', 'online'] as const) {
        const before = counts(w, a.name)
        await finish(w, a.triggerSync(reason))
        expect(since(w, a.name, before), reason).toEqual({ heads: 1, pulls: 0, pushes: 0 })
      }
      // the relay moves while a hears nothing: its next poll finds a new etag and pulls
      w.relay.rowEvents = false
      w.relay.broadcast = false
      const id = add(b, 'moved the etag')
      await w.clock.run(10_000)
      const moved = counts(w, a.name)
      await finish(w, a.triggerSync('poll'))
      expect(since(w, a.name, moved)).toEqual({ heads: 1, pulls: 1, pushes: 0 })
      expect(a.doc.expenses.has(id)).toBe(true)
      // a change of its own is pushed at once: no HEAD first
      add(a, 'pending here')
      const pending = counts(w, a.name)
      await finish(w, a.triggerSync('resume'))
      expect(since(w, a.name, pending)).toEqual({ heads: 0, pulls: 1, pushes: 1 })
      w.stop()
    },
    SIM_TIMEOUT,
  )

  for (const cas of [true, false]) {
    it(
      `T-002-1: with self-echo and Broadcast one add costs one push and at most two pulls on the other device, then nothing for 60 s (CAS ${cas ? 'on' : 'off'})`,
      async () => {
        for (const seed of [1, 2, 3, 4, 5]) {
          const w = await pair({ ...CALM, cas }, seed)
          const a = must(w.v5[0])
          const b = must(w.v5[1])
          const ca = counts(w, a.name)
          const cb = counts(w, b.name)
          const broadcasts = w.relay.broadcasts
          const id = add(a, 'one add')
          await w.clock.run(30_000)
          expect(b.doc.expenses.has(id), `seed ${seed}`).toBe(true)
          expect(since(w, a.name, ca).pushes, `seed ${seed}`).toBe(1)
          expect(since(w, b.name, cb).pushes, `seed ${seed}`).toBe(0)
          expect(since(w, b.name, cb).pulls, `seed ${seed}`).toBeLessThanOrEqual(2)
          expect(w.relay.broadcasts - broadcasts, `seed ${seed}`).toBe(1)
          const quiet = w.relay.writes
          await w.clock.run(60_000)
          expect(w.relay.writes, `seed ${seed}`).toBe(quiet)
          w.stop()
        }
      },
      SIM_TIMEOUT,
    )
  }

  it(
    'Broadcast-only delivery (postgres_changes refused, as after 005): the other device has an add within 5 s of the push landing',
    async () => {
      const w = new World({ seed: 4, devices: [V011, V011], net: CALM })
      w.relay.rowEvents = false
      await w.setup()
      await w.settle()
      const a = must(w.v5[0])
      const b = must(w.v5[1])
      expect([a.live, b.live]).toEqual([true, true])
      const before = a.pushes
      const id = add(a, 'by broadcast')
      await landed(w, a, before)
      expect(await arrival(w, b, id, 10_000)).toBeLessThanOrEqual(5000)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'poll-only delivery (realtime refused): an add arrives within a minute of landing; an idle minute is one HEAD and no pull',
    async () => {
      const w = new World({ seed: 5, devices: [V011, V011], net: CALM })
      w.relay.rowEvents = false
      w.relay.broadcast = false
      await w.setup()
      await w.settle()
      const a = must(w.v5[0])
      const b = must(w.v5[1])
      expect([a.live, b.live]).toEqual([false, false])
      const before = a.pushes
      const id = add(a, 'by polling')
      await landed(w, a, before)
      expect(await arrival(w, b, id, 120_000)).toBeLessThanOrEqual(62_000)
      await w.settle()
      const idle = counts(w, b.name)
      await w.clock.run(60_000)
      const used = since(w, b.name, idle)
      expect(used.pulls + used.pushes).toBe(0)
      expect(used.heads).toBe(1)
      w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'T-002-4: the 21st remote cycle within 60 s does not run; remote events start nothing for 60 s; polling goes on; a local change ends the pause',
    async () => {
      /** One 0.11.0 device beside a writer that never stops (a phone stuck in a loop). */
      async function stormy(): Promise<{
        readonly w: World
        readonly a: V5Device
        readonly chatter: () => void
      }> {
        const w = new World({ seed: 6, devices: [V011], net: FIXED })
        await w.setup()
        await w.settle()
        const a = must(w.v5[0])
        let doc: Doc = a.doc
        const rng = makeRng(99)
        const hlc = { last: 0 }
        let n = 0
        const chatter = (): void => {
          const ctx = { wall: w.clock.now, clock: hlc, dev: 'noisy', rng: rng.next }
          doc = addExpense(doc, ctx, { itemName: `noise ${String(n++)}`, amount: 1 }).doc
          w.relay.poke('noisy', encodeWire(doc, { dev: 'noisy', rev: newRev(rng.next), min: 4 }))
        }
        const before = a.cycles.get('remote') ?? 0
        for (let i = 0; i < 60; i++) {
          chatter() // one push a second
          await w.clock.run(1000)
        }
        // 30 remote cycles would fit in 60 s (2 s apart); the breaker stops the 21st
        expect((a.cycles.get('remote') ?? 0) - before).toBe(20)
        expect([a.storms, a.storming]).toEqual([1, true])
        return { w, a, chatter }
      }
      const remote = (a: V5Device): number => a.cycles.get('remote') ?? 0
      const polls = (a: V5Device): number => a.cycles.get('poll') ?? 0

      const one = await stormy()
      const stormed = remote(one.a)
      const pollsBefore = polls(one.a)
      for (let i = 0; i < 35; i++) {
        one.chatter()
        await one.w.clock.run(1000)
      }
      expect(remote(one.a)).toBe(stormed) // remote events start nothing for 60 s
      expect(one.a.storming).toBe(true)
      await one.w.clock.run(10_000)
      // polling went on (every 60 s while paused) and merged what the events carried
      expect(one.a.storming).toBe(false)
      expect(polls(one.a)).toBeGreaterThan(pollsBefore)
      expect(one.a.doc.expenses.size).toBeGreaterThanOrEqual(95)
      one.w.stop()

      // a local change ends the pause at once
      const two = await stormy()
      const paused = remote(two.a)
      add(two.a, 'mine')
      expect(two.a.storming).toBe(false)
      two.chatter()
      await two.w.clock.run(5000)
      expect(remote(two.a)).toBeGreaterThan(paused)
      two.w.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'AC-E5/E6: a join never creates; it pauses not-found, keeps polling and becomes established once the row exists; only an established device re-creates a vanished row',
    async () => {
      const w = new World({ seed: 7, devices: [], net: CALM })
      const joiner = new V5Device(w.clock, w.relay, makeRng(1), w, {
        name: 'joiner',
        skew: 0,
        established: false,
      })
      joiner.start()
      await finish(w, joiner.triggerSync('boot'))
      expect(joiner.paused).toBe('not-found')
      await w.clock.run(10 * 60_000)
      expect([w.relay.row, w.relay.writes, joiner.pushes]).toEqual([null, 0, 0])
      expect(w.relay.pullsBy.get('joiner') ?? 0).toBeGreaterThan(1) // it keeps looking

      // the other device generates the code and creates the row
      const maker = new V5Device(w.clock, w.relay, makeRng(2), w, {
        name: 'maker',
        skew: 0,
        established: true,
      })
      const id = add(maker, 'made on the laptop')
      maker.start()
      await finish(w, maker.triggerSync('boot'))
      expect(w.relay.row).not.toBeNull()
      await w.clock.run(6 * 60_000)
      expect(joiner.doc.expenses.has(id)).toBe(true)
      expect([joiner.paused, joiner.established]).toEqual([null, true])

      // the row vanishes: the established devices re-create it with their whole doc
      w.relay.poke('admin', null)
      await w.clock.run(6 * 60_000)
      expect(w.relay.row).toContain('made on the laptop')

      // a device that never synced the row (joined a code whose row vanished) never writes
      w.relay.poke('admin', null)
      maker.stop()
      joiner.stop()
      const late = new V5Device(w.clock, w.relay, makeRng(3), w, {
        name: 'late',
        skew: 0,
        established: false,
      })
      add(late, 'only here')
      late.start()
      await w.clock.run(10 * 60_000)
      expect([w.relay.row, late.paused, late.pushes]).toEqual([null, 'not-found', 0])
      expect(late.doc.expenses.size).toBe(1)
      late.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'AC-E18: every push registers devices[me] (0.11.0, table); 0.10.0 never does and is flagged v5pre; its in-place update costs exactly one push',
    async () => {
      const w = new World({ seed: 8, devices: [V011, V010], net: CALM })
      await w.setup()
      const a = must(w.v5[0])
      const old = must(w.v5[1])
      add(old, 'on 0.10.0')
      await w.settle()
      expect(old.mode).toBe('pr2')
      const devs = relayDevs(w)
      expect(prop(devs[a.name], 'app')).toBe('0.11.0')
      expect(prop(devs[a.name], 'm')).toBe('table')
      expect(prop(devs[a.name], 'e')).toBe(0)
      expect(devs[old.name]).toBeUndefined()
      expect(a.legacySeen.v5pre).not.toBeNull()
      // `seen` alone never causes a push
      expect(await w.rounds()).toBe(0)

      const pushes = w.relay.writesBy.get(old.name) ?? 0
      w.upgradeAll()
      await w.settle()
      expect((w.relay.writesBy.get(old.name) ?? 0) - pushes).toBe(1)
      expect(prop(relayDevs(w)[old.name], 'app')).toBe('0.11.0')
      expect(await w.rounds()).toBe(0)
      expect(w.checkConverged()).toEqual([])
      w.stop()

      // two 0.11.0 devices never flag each other
      const fresh = await pair(CALM, 9)
      expect(fresh.v5.map((d) => d.legacySeen.v5pre)).toEqual([null, null])
      fresh.stop()
    },
    SIM_TIMEOUT,
  )

  it(
    'row 14 (CAS on): two devices push at the same instant: one wins, the other conflicts, re-pulls, merges and pushes; exactly 2 pushes, then quiet',
    async () => {
      const w = await pair(FIXED, 10)
      const a = must(w.v5[0])
      const b = must(w.v5[1])
      const writes = w.relay.writes
      const conflicts = a.conflicts + b.conflicts
      const x = add(a, 'from a')
      const y = add(b, 'from b')
      await w.clock.run(20_000)
      expect(w.relay.writes - writes).toBe(2)
      expect(a.conflicts + b.conflicts - conflicts).toBe(1)
      await w.settle()
      expect(w.relay.writes - writes).toBe(2)
      for (const d of [a, b])
        expect([d.doc.expenses.has(x), d.doc.expenses.has(y)]).toEqual([true, true])
      expect(w.checkConverged()).toEqual([])
      w.stop()
    },
    SIM_TIMEOUT,
  )

  for (const cas of [true, false]) {
    it(
      `T-002-3: a dropped push of news with nothing in the outbox is retried within a minute: the memo is written only once a push lands (CAS ${cas ? 'on' : 'off'})`,
      async () => {
        const w = new World({ seed: 12, devices: [V011], net: { ...FIXED, cas } })
        await w.setup()
        const a = must(w.v5[0])
        const x = add(a, 'must reach the old phone')
        await w.settle()
        expect(a.outbox.size).toBe(0)
        // an old phone (no x5, no writer stamp: v0.8.4) writes a copy that lost x
        const copy = parseJson(must(w.relay.row))
        const list = prop(copy, 'expenses')
        const kept = Array.isArray(list) ? list.filter((r: unknown) => prop(r, 'id') !== x) : []
        const old = typeof copy === 'object' && copy !== null ? { ...copy, expenses: kept } : {}
        Reflect.deleteProperty(old, 'x5')
        w.relay.dropNextPush = true // the push of that news never reaches the relay
        w.relay.poke('old phone', old)
        await w.clock.run(60_000)
        expect(w.relay.row).toContain('must reach the old phone')
        expect(a.pushWhy.at(-1)).toBe('adoptable')
        w.stop()
      },
      SIM_TIMEOUT,
    )
  }

  it(
    'AC-T2: after 3 conflicts the 4th attempt is forced and lands; nothing is lost',
    async () => {
      const w = await pair(FIXED, 11)
      const a = must(w.v5[0])
      const b = must(w.v5[1])
      w.relay.casConflicts = 3
      const before = a.pushes
      const conflicts = a.conflicts
      const id = add(a, 'after three conflicts')
      await landed(w, a, before)
      expect([a.conflicts - conflicts, a.busyCycles, w.relay.casConflicts]).toEqual([3, 0, 0])
      await w.settle()
      expect(b.doc.expenses.has(id)).toBe(true)
      expect(w.checkConverged()).toEqual([])
      w.stop()
    },
    SIM_TIMEOUT,
  )
})
