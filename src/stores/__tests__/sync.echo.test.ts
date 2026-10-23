// F-002: sync goes quiet. Ports the auditors' s2 echo loop (one and two devices), plus the
// old-writer rules: claim stamp, memo and banner evidence (§10.3, §11.4 on the v4 wire).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  settle,
  stubRelayEnv,
  writeAsLegacy,
  writeAsOther,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
// Bound before fake timers are installed, so it measures real CPU time.
const realNow = performance.now.bind(performance)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const counts = () => ({ pulls: relay().pulls, upserts: relay().upserts })

function since(before: { pulls: number; upserts: number }) {
  return { pulls: relay().pulls - before.pulls, upserts: relay().upserts - before.upserts }
}

const hasId = (rows: readonly unknown[], id: string) =>
  rows.some((r) => typeof r === 'object' && r !== null && 'id' in r && r.id === id)

describe('F-002: one device with realtime self-echo (T-002-1, s2)', () => {
  it.each([
    ['the echo after the push response', { pull: 200, push: 200, realtime: 250 }],
    ['the echo before the push response', { pull: 200, push: 200, realtime: 30 }],
  ])('one add costs exactly one upsert, then nothing for 60 s (%s)', async (_label, latency) => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = latency
    await connect(phone)
    const before = counts()

    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(4000) // the debounced push
    expect(since(before).upserts).toBe(1)

    const idle = counts()
    await advance(MINUTE)
    expect(since(idle)).toEqual({ pulls: 0, upserts: 0 })
  })
})

describe('F-002: two devices with self-echo (T-002-2, s2 devices=2)', () => {
  it.each([
    ['the echo after the push response', { pull: 200, push: 200, realtime: 250 }],
    ['the echo before the push response', { pull: 200, push: 200, realtime: 30 }],
  ])('one add on A costs at most 2 upserts in total, then none (%s)', async (_label, latency) => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = latency
    await connect(laptop)
    await connect(phone)
    await advance(10_000)

    const quiet = counts()
    await advance(10_000) // s2: ten seconds of zero activity
    expect(since(quiet).upserts).toBe(0)

    const before = counts()
    const added = laptop.expense.useExpenseStore.getState().addExpense({
      itemName: 'Grab home',
      amount: 12,
    })
    await advance(10_000)
    expect(since(before).upserts).toBeLessThanOrEqual(2)
    for (const device of [laptop, phone]) {
      expect(device.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain(
        added.id,
      )
    }

    const idle = counts()
    await advance(MINUTE)
    expect(since(idle).upserts).toBe(0)
  })
})

describe('no-op cycles change nothing (AC-6)', () => {
  it('a merge equal to the remote pushes nothing and notifies no store subscriber', async () => {
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
    await connect(phone)
    const store = phone.expense.useExpenseStore
    const rows = store.getState().expenses
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)
    const before = counts()

    const result = await settle(phone.sync.useSyncStore.getState().triggerSync())

    unsubscribe()
    expect(result).toMatchObject({ ok: true, pushed: false, changedLocal: false })
    expect(since(before)).toEqual({ pulls: 1, upserts: 0 })
    expect(notifications).toBe(0)
    expect(store.getState().expenses).toBe(rows)
  })

  it('holds at 5,000 rows, and the cycle takes under a second', async () => {
    const many: Expense[] = Array.from({ length: 5000 }, (_, i) =>
      expense(`e${String(i)}`, {
        itemName: `Expense number ${String(i)}`,
        amount: (i % 97) + 0.5,
        notes: i % 3 === 0 ? 'with a note' : undefined,
        updatedAt: new Date(NOW - i * 1000).toISOString(),
      }),
    )
    const phone = await bootDevice({ expenses: many })
    await connect(phone)
    const store = phone.expense.useExpenseStore
    const rows = store.getState().expenses
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)
    const before = counts()

    const started = realNow()
    const result = await settle(phone.sync.useSyncStore.getState().triggerSync(), 10)
    const elapsed = realNow() - started

    unsubscribe()
    expect(result).toMatchObject({ ok: true, pushed: false })
    expect(since(before).upserts).toBe(0)
    expect(notifications).toBe(0)
    expect(store.getState().expenses).toBe(rows)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('echo filter and coalescing (AC-8)', () => {
  async function connected() {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    await connect(phone)
    return phone
  }

  const foreign = (n: number) =>
    payloadOf([expense('e1'), expense(`f${String(n)}`)], {
      wr: {
        app: '0.8.5',
        dev: 'laptop',
        rev: `foreign-${String(n)}`,
        at: new Date().toISOString(),
      },
    })

  it('ignores an event that carries one of its own last revs', async () => {
    const phone = await connected()
    const own = rowPayload(SYNC_CODE)
    const before = counts()
    writeAsOther(SYNC_CODE, own) // a replay of our own last write
    await advance(5000)
    expect(since(before).pulls).toBe(0)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it('pulls once, 300 ms after a foreign event', async () => {
    await connected()
    const before = counts()
    writeAsOther(SYNC_CODE, foreign(1))
    await advance(299)
    expect(since(before).pulls).toBe(0)
    await advance(1)
    expect(since(before).pulls).toBe(1)
    await advance(10_000)
    expect(since(before).pulls).toBe(1)
  })

  it('turns ten foreign events in one second into at most two cycles, 2 s apart', async () => {
    await connected()
    const before = counts()
    const pullTimes: number[] = []
    const startPulls = relay().pulls
    for (let i = 0; i < 10; i++) {
      writeAsOther(SYNC_CODE, foreign(i))
      await advance(100)
      while (relay().pulls - startPulls > pullTimes.length) pullTimes.push(Date.now())
    }
    for (let t = 0; t < 100; t++) {
      await advance(100)
      while (relay().pulls - startPulls > pullTimes.length) pullTimes.push(Date.now())
    }
    expect(since(before).pulls).toBeLessThanOrEqual(2)
    expect(pullTimes.length).toBeGreaterThanOrEqual(1)
    for (let i = 1; i < pullTimes.length; i++) {
      expect((pullTimes[i] ?? 0) - (pullTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(2000)
    }
  })

  it('treats an event without a payload as its own only when updated_at matches a sent one', async () => {
    const phone = await connected()
    relay().omitPayload = true
    const before = counts()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10_000)
    expect(since(before)).toEqual({ pulls: 1, upserts: 1 }) // the add's own cycle, no echo cycle

    // The laptop adds f1 on top of everything the relay holds.
    const foreignBefore = counts()
    writeAsOther(SYNC_CODE, {
      ...payloadOf([...relayRows(), expense('f1')]),
      wr: { app: '0.8.5', dev: 'laptop', rev: 'foreign-1', at: new Date().toISOString() },
    })
    await advance(10_000)
    expect(since(foreignBefore)).toEqual({ pulls: 1, upserts: 0 })
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('f1')
  })
})

describe('old writers (v0.8.4 and earlier) on the relay', () => {
  const ours = [expense('e1', { category: 'Zzz', updatedAt: '2026-10-10T00:00:00.000Z' })]
  // The old device's copy of e1: same stamp, different content (it re-files categories).
  const theirs = [expense('e1', { category: 'Food', updatedAt: '2026-10-10T00:00:00.000Z' })]

  it('claims an equal legacy row with exactly one push carrying wr, and shows no banner (AC-9)', async () => {
    seedRow(SYNC_CODE, payloadOf(ours)) // written by v0.8.4: no wr
    const phone = await bootDevice({ expenses: ours })
    await connect(phone)
    expect(relay().upserts).toBe(1)
    const row = rowPayload(SYNC_CODE)
    expect(row).toMatchObject({ wr: { app: '0.8.5' } })
    expect(phone.sync.useSyncStore.getState().legacyWriterAt).toBeNull()
    await advance(MINUTE)
    expect(relay().upserts).toBe(1)
  })

  it('stops pushing over an old device that keeps re-pushing its tie winner (AC-10)', async () => {
    seedRow(SYNC_CODE, payloadOf(ours))
    const phone = await bootDevice({ expenses: ours })
    await connect(phone)
    const claim = relay().upserts
    expect(claim).toBe(1)

    // The v0.8.4 device: keeps its own copy and re-pushes every 600 ms, for 30 minutes.
    const chatter = setInterval(() => writeAsLegacy(SYNC_CODE, payloadOf(theirs)), 600)
    const ourPushes = () => relay().pushes.length - claim

    await advance(MINUTE)
    const sync = phone.sync.useSyncStore.getState()
    expect(sync.legacyWriterAt).not.toBeNull()
    expect(sync.waitingForOld).toBe(true)
    expect(ourPushes()).toBeLessThanOrEqual(1)

    await advance(29 * MINUTE)
    clearInterval(chatter)
    expect(ourPushes() + claim).toBeLessThanOrEqual(4)
    // Our data is intact meanwhile.
    expect(phone.expense.useExpenseStore.getState().expenses[0]?.category).toBe('Zzz')
  })

  it('still pushes a new local add at once while an old device chatters', async () => {
    seedRow(SYNC_CODE, payloadOf(ours))
    const phone = await bootDevice({ expenses: ours })
    await connect(phone)
    const chatter = setInterval(() => writeAsLegacy(SYNC_CODE, payloadOf(theirs)), 600)
    await advance(MINUTE)
    expect(phone.sync.useSyncStore.getState().waitingForOld).toBe(true)

    const added = phone.expense.useExpenseStore.getState().addExpense({
      itemName: 'Kopi',
      amount: 1.5,
    })
    // At once, not at the next cycle: a change the relay has not seen is pending, no longer held
    // back (the pill and the status row then say "Syncing…", not "Update old device").
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      waitingForOld: false,
      pendingLocal: true,
    })
    const before = relay().pushes.length
    await advance(4000)
    clearInterval(chatter)
    const pushed = relay().pushes.slice(before)
    expect(pushed.some((p) => hasId(payloadRows(p.payload), added.id))).toBe(true)
  })
})

function payloadRows(payload: unknown): unknown[] {
  if (typeof payload !== 'object' || payload === null || !('expenses' in payload)) return []
  const rows: unknown = payload.expenses
  return Array.isArray(rows) ? rows : []
}
