// The v5 cycle (PR-3 track spec §3.4, AC-T2, AC-E1 to AC-E3): writes made while a cycle is on the
// wire are never lost, with compare-and-set on and off; a crossing push is merged again from the
// relay's newer copy; the fourth attempt after three crossings is forced, six make it busy; a
// lost answer costs nothing; an established device re-creates a vanished row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExpenseView } from '../../types'
import { LegacyPeer } from '../../__tests__/legacyPeer'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRow,
  expense,
  failNext,
  landedPushes,
  relay,
  relayDeleted,
  relayRows,
  requestsOf,
  resetRelay,
  retireDevices,
  rowPayload,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const CAS = [
  ['CAS off', false],
  ['CAS on', true],
] as const

function withCas(on: boolean): void {
  if (on) vi.stubEnv('VITE_SYNC_CAS', 'on')
}

const idOf = (r: unknown): unknown =>
  typeof r === 'object' && r !== null && 'id' in r ? r.id : undefined

function relayRow(id: string): Record<string, unknown> | undefined {
  return relayRows().find(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && idOf(r) === id,
  )
}

const localIds = (d: Device): string[] =>
  d.expense.useExpenseStore
    .getState()
    .expenses.map((e) => e.id)
    .sort()

/** A device with e1 (Taxi) and e2 (Lunch, 7) on the relay, then a slow relay. */
async function synced(pull = 500, push = 500): Promise<Device> {
  const phone = await bootDevice({
    expenses: [
      expense('e1', { itemName: 'Taxi', amount: 25 }),
      expense('e2', { itemName: 'Lunch', amount: 7 }),
    ],
  })
  await connect(phone)
  relay().latency = { pull, push, realtime: 50 }
  return phone
}

function writeAll(d: Device): ExpenseView {
  const s = d.expense.useExpenseStore.getState()
  const added = s.addExpense({ itemName: 'Grab to camp', amount: 12 })
  s.deleteExpense('e1')
  s.updateExpense('e2', { amount: 70 })
  return added
}

function expectKept(d: Device, added: ExpenseView): void {
  const s = d.expense.useExpenseStore.getState()
  expect(localIds(d)).toContain(added.id)
  expect(localIds(d)).not.toContain('e1')
  expect(s.expenses.find((e) => e.id === 'e2')?.amount).toBe(70)
  expect(relayRow(added.id)).toBeDefined()
  expect(relayRow('e1')).toBeUndefined()
  expect(relayDeleted()).toContain('e1')
  expect(relayRow('e2')?.amount).toBe(70)
}

describe.each(CAS)('T-001-1: writes made while a cycle is on the wire (%s)', (_label, cas) => {
  it.each([300, 500, 800])(
    'T-001-1 keeps an add, an edit and a delete made during a %i ms pull',
    async (ms) => {
      withCas(cas)
      const phone = await synced(ms, 300)
      const cycle = phone.sync.useSyncStore.getState().triggerSync()
      await advance(Math.floor(ms / 3))
      const added = writeAll(phone)
      await settle(cycle, ms + 300)
      await advance(10_000)
      expectKept(phone, added)
      expect(phone.sync.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'synced',
        pending: 0,
      })
    },
  )

  it('T-001-1 keeps an add, an edit and a delete made during the push', async () => {
    withCas(cas)
    const phone = await synced(300, 800)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'First', amount: 1 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(300 + 200) // the pull is back, the push is on the wire
    const added = writeAll(phone)
    await settle(cycle, 800)
    await advance(10_000)
    expectKept(phone, added)
  })
})

describe.each(CAS)('T-001-3: one more cycle, never a stale answer (%s)', (_label, cas) => {
  it('T-001-3 a write during a push causes exactly one more cycle', async () => {
    withCas(cas)
    const phone = await synced(100, 600)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'One', amount: 1 })
    const first = phone.sync.useSyncStore.getState().triggerSync()
    await advance(100 + 300)
    const before = relay().pulls
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Two', amount: 2 })
    await settle(first, 300)
    await advance(10_000)
    expect(relay().pulls - before).toBe(1) // the next cycle, and no other
    expect(relayRows().map(idOf)).toHaveLength(4)
  })

  it('T-001-3 triggerSync during a running cycle resolves only after the next completed cycle', async () => {
    withCas(cas)
    const phone = await synced(400, 400)
    const first = phone.sync.useSyncStore.getState().triggerSync()
    await advance(100)
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Late', amount: 3 })
    let settled = false
    const second = phone.sync.useSyncStore
      .getState()
      .triggerSync()
      .then((r) => {
        settled = true
        return r
      })
    await advance(800) // the first cycle ends here
    await first
    expect(settled).toBe(false)
    expect(await settle(second, 2000)).toMatchObject({ ok: true })
    expect(relayRow(added.id)).toBeDefined() // the answer is from a cycle that carried it
  })
})

describe('compare-and-set (AC-T2)', () => {
  beforeEach(() => {
    withCas(true)
  })

  it('a crossing write turns the push into a conflict: re-pull, re-merge, and nothing is lost', async () => {
    const phone = await synced(100, 400)
    // The laptop writes while our push is on the wire: our CAS base is gone.
    let crossed = false
    relay().beforeWrite = ({ client }) => {
      if (crossed || client < 0) return
      crossed = true
      const payload = rowPayload(SYNC_CODE)
      if (typeof payload !== 'object' || payload === null || !('expenses' in payload)) return
      const listed: unknown = payload.expenses
      const rows: unknown[] = Array.isArray(listed) ? listed : []
      writeAsOther(SYNC_CODE, {
        ...payload,
        expenses: [...rows, expense('lap1', { itemName: 'From the laptop' })],
      })
    }
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Mine', amount: 2 })
    await settle(phone.sync.useSyncStore.getState().triggerSync(), 3000)
    await advance(5000)
    const updates = requestsOf('update')
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates.every((u) => u.filters.some((f) => f.startsWith('updated_at=eq.')))).toBe(true)
    expect(relayRows().map(idOf)).toEqual(expect.arrayContaining([added.id, 'lap1', 'e1', 'e2']))
    expect(localIds(phone)).toEqual(expect.arrayContaining([added.id, 'lap1']))
  })

  it('forces the fourth attempt after three conflicts; a forced write never creates, so a row gone under it is inserted in the same cycle', async () => {
    const phone = await synced(0, 0)
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Contested', amount: 4 })
    // Another device always writes first; the forced write finds the row gone.
    relay().beforeWrite = ({ force, via }) => {
      if (force) {
        dropRow(SYNC_CODE)
        return
      }
      const payload = rowPayload(SYNC_CODE)
      if (via !== 'insert' && payload !== undefined) writeAsOther(SYNC_CODE, payload)
    }
    const start = relay().requests.length
    const result = await settle(phone.sync.useSyncStore.getState().triggerSync(), 2000)
    expect(result).toMatchObject({ ok: true, pushed: true })
    const writes = relay()
      .requests.slice(start)
      .filter((r) => r.kind === 'update' || r.kind === 'insert')
    // three compare-and-set writes, one forced (no updated_at filter, never an insert), then the
    // row that vanished under it is created again by an insert, not forced into nothing
    expect(writes.map((w) => w.kind)).toEqual(['update', 'update', 'update', 'update', 'insert'])
    expect(
      writes.slice(0, 3).every((w) => w.filters.some((f) => f.startsWith('updated_at='))),
    ).toBe(true)
    expect(writes[3]?.filters).toEqual([`sync_id=eq.${SYNC_CODE}`])
    expect(relayRows().map(idOf)).toEqual(expect.arrayContaining([added.id, 'e1']))
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ cloudStatus: 'synced', pending: 0 })
    relay().beforeWrite = null
  })

  it('gives up as busy after six attempts, and a forced write never creates the row', async () => {
    const phone = await synced(0, 0)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Contested', amount: 4 })
    // Another device always writes first: over a compare-and-set, before an insert (23505);
    // and the row is gone whenever this device forces.
    let n = 0
    let last = rowPayload(SYNC_CODE)
    relay().beforeWrite = ({ force }) => {
      n++
      if (force) {
        dropRow(SYNC_CODE)
        return
      }
      last = rowPayload(SYNC_CODE) ?? last
      if (last !== undefined) writeAsOther(SYNC_CODE, last)
    }
    const start = relay().requests.length
    const result = await settle(phone.sync.useSyncStore.getState().triggerSync(), 2000)
    expect(result).toMatchObject({ ok: false, error: 'busy' })
    expect(n).toBe(6)
    const writes = relay()
      .requests.slice(start)
      .filter((r) => r.kind === 'update' || r.kind === 'insert')
    expect(writes.map((w) => w.kind)).toEqual([
      'update',
      'update',
      'update',
      'update',
      'insert',
      'update',
    ])
    expect(writes[3]?.filters).toEqual([`sync_id=eq.${SYNC_CODE}`])
    expect(writes[5]?.filters).toEqual([`sync_id=eq.${SYNC_CODE}`])
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'error',
      lastError: { kind: 'busy' },
    })
    // a forced write never created the row
    expect(relay().rows.has(SYNC_CODE)).toBe(false)
    relay().beforeWrite = null
  })

  it('creates a missing row by insert, and a row someone else created first is merged (23505)', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = { pull: 0, push: 200, realtime: 0 }
    relay().beforeWrite = ({ via }) => {
      if (via !== 'insert') return
      relay().beforeWrite = null
      writeAsOther(SYNC_CODE, {
        version: '4.0',
        exportDate: '2026-11-01T04:00:00.000Z',
        expenses: [expense('lap1', { itemName: 'Laptop got there first' })],
        categories: ['Other'],
        deletedIds: [],
      })
    }
    const result = await connect(phone)
    expect(result).toMatchObject({ ok: true })
    expect(requestsOf('insert')).toHaveLength(1)
    expect(relayRows().map(idOf).sort()).toEqual(['e1', 'lap1'])
  })
})

describe.each(CAS)('lost answers and vanished rows (%s)', (_label, cas) => {
  it('a push that landed although its answer was lost is not pushed again', async () => {
    withCas(cas)
    const phone = await synced(0, 0)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Ghosted', amount: 5 })
    failNext('push', { ghost: 100 })
    const result = await settle(phone.sync.useSyncStore.getState().triggerSync(), 15_100)
    expect(result).toMatchObject({ ok: false, error: 'network' })
    expect(relay().ghostsLanded).toBe(1)
    const landed = landedPushes()
    await advance(10_000) // the retry pulls our own rev: no-op merge, outbox acknowledged
    expect(landedPushes()).toBe(landed)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ cloudStatus: 'synced', pending: 0 })
  })

  it('an established device re-creates a vanished row with its full doc', async () => {
    withCas(cas)
    const phone = await synced(0, 0)
    dropRow(SYNC_CODE)
    expect(await settle(phone.sync.useSyncStore.getState().triggerSync())).toMatchObject({
      ok: true,
      pushed: true,
    })
    expect(relayRows().map(idOf).sort()).toEqual(['e1', 'e2'])
    expect(requestsOf(cas ? 'insert' : 'upsert').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// T-001-2: many writes injected at every await, CAS on and off; and the negative control
// ---------------------------------------------------------------------------

/** mulberry32: the same seed always injects the same writes at the same moments. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEEDS = 40
const WRITES = 60

interface Expected {
  /** id → final amount, or null when deleted. */
  readonly final: Map<string, number | null>
}

/**
 * Two devices, a slow and jittery relay, and 60 writes (adds, edits, deletes) landing at random
 * moments: during pulls, pushes and (CAS on) crossings. Each device edits only what it added, so
 * the final value of every entry is known. Returns what was lost.
 */
async function storm(seed: number): Promise<string[]> {
  const r = rng(seed)
  const a = await bootDevice({ expenses: [] })
  const b = await bootDevice({ expenses: [] })
  await connect(a)
  await connect(b)
  relay().pullLatencyFor = () => 300 + Math.floor(r() * 500)
  relay().pushLatencyFor = () => 200 + Math.floor(r() * 400)
  relay().latency.realtime = 40
  const expected: Expected = { final: new Map() }
  const mine = new Map<Device, string[]>([
    [a, []],
    [b, []],
  ])
  for (let i = 0; i < WRITES; i++) {
    const d = r() < 0.5 ? a : b
    const own = mine.get(d) ?? []
    const s = d.expense.useExpenseStore.getState()
    const pick = r()
    const target = own[Math.floor(r() * own.length)]
    if (pick < 0.55 || target === undefined) {
      const amount = 1 + Math.floor(r() * 90)
      const added = s.addExpense({ itemName: `w${String(i)}`, amount })
      own.push(added.id)
      expected.final.set(added.id, amount)
    } else if (pick < 0.85 && expected.final.get(target) !== null) {
      const amount = 100 + i
      s.updateExpense(target, { amount })
      expected.final.set(target, amount)
    } else if (expected.final.get(target) !== null) {
      s.deleteExpense(target)
      expected.final.set(target, null)
    }
    mine.set(d, own)
    // half the time a cycle starts right away (it is then on the wire for the next writes)
    if (r() < 0.5) void d.sync.useSyncStore.getState().triggerSync()
    await advance(Math.floor(r() * 700))
  }
  relay().pullLatencyFor = null
  relay().pushLatencyFor = null
  await advance(60_000)
  await settle(a.sync.useSyncStore.getState().triggerSync(), 5000)
  await settle(b.sync.useSyncStore.getState().triggerSync(), 5000)
  await settle(a.sync.useSyncStore.getState().triggerSync(), 5000)
  const lost: string[] = []
  for (const [id, amount] of expected.final) {
    for (const [name, d] of [
      ['A', a],
      ['B', b],
    ] as const) {
      const row = d.expense.useExpenseStore.getState().expenses.find((e) => e.id === id)
      if (amount === null ? row !== undefined : row?.amount !== amount) lost.push(`${name}:${id}`)
    }
    const onRelay = relayRow(id)
    if (amount === null ? onRelay !== undefined : onRelay?.amount !== amount) lost.push(`R:${id}`)
  }
  retireDevices()
  return lost
}

describe.each(CAS)(
  'T-001-2: writes injected during pulls, pushes and crossings (%s)',
  (_l, cas) => {
    it(`T-001-2 ${String(SEEDS)} seeds × ${String(WRITES)} writes lose nothing`, async () => {
      const losses: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        resetRelay()
        withCas(cas)
        const lost = await storm(seed * 7919 + (cas ? 1 : 0))
        if (lost.length > 0) losses.push(`seed ${String(seed)}: ${lost.join(', ')}`)
      }
      expect(losses).toEqual([])
    })
  },
)

describe('T-001-2 negative control', () => {
  // The v0.8 pattern (the doc read before the await, written back after it) on the same relay,
  // with a write during every pull: it must lose data in every seed, or the harness is blind.
  it('T-001-2 the read-before-pull client loses a write in every seed', async () => {
    let losing = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      resetRelay()
      const r = rng(seed)
      const peer = new LegacyPeer([expense('e0')])
      peer.connect(SYNC_CODE)
      await advance(3000)
      const pullMs = 300 + Math.floor(r() * 500)
      relay().latency = { pull: pullMs, push: 100, realtime: 0 }
      const cycle = peer.triggerSync()
      await advance(Math.floor(r() * 200)) // the write lands while the pull is on the wire
      const added = peer.add(`during pull ${String(seed)}`, 3)
      await settle(cycle, pullMs + 200)
      await advance(5000)
      if (!peer.state.expenses.some((e) => e.id === added.id)) losing++
      peer.disconnect()
    }
    expect(losing).toBe(SEEDS)
  })
})
