// Realtime v5 (PR-3 track spec P3-12 to P3-15, §3.6; AC-E10, AC-E12, AC-E14, AC-E16, AC-E17):
// one channel per row on the hashed topic, Broadcast between v5 devices beside postgres_changes
// for old ones, an echo filter that starts no cycle for our own writes, a storm breaker, polling
// that runs only while visible, and a channel that closes 30 s after the tab is hidden.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  failNext,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  setVisibility,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  type Device,
  type FakeChannel,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
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

/** The relay client a device's requests come from (found by one Sync now). */
async function clientOf(d: Device): Promise<number> {
  const before = relay().requests.length
  await settle(d.sync.useSyncStore.getState().triggerSync())
  return relay().requests[before]?.client ?? -1
}

const pullsBy = (client: number) =>
  relay().requests.filter((r) => r.kind === 'pull' && r.client === client).length

/** The channels a device subscribed (Broadcast bound), newest last. */
const channelsOf = (client: number): FakeChannel[] =>
  relay().created.filter((c) => c.client.id === client && c.broadcastEvents)

const live = (d: Device) => d.sync.useSyncStore.getState().view?.live

async function connected(id = 'e1'): Promise<Device> {
  const d = await bootDevice({ expenses: [expense(id)] })
  await connect(d)
  return d
}

/** A foreign v4 write (no x5): never ours, never merged before. */
function foreignWrite(n: number): void {
  writeAsOther(SYNC_CODE, payloadOf([expense('e1'), expense(`f${String(n)}`)]))
}

describe.each(CAS)('T-002-1: two devices, self-echo and Broadcast (%s)', (_label, cas) => {
  it('T-002-1 one add costs at most 2 pushes in total, then none for 60 s', async () => {
    if (cas) vi.stubEnv('VITE_SYNC_CAS', 'on')
    relay().latency = { pull: 40, push: 60, realtime: 30 }
    const a = await connected('a1')
    const b = await connected('b1')
    await advance(MINUTE)
    const before = relay().pushes.length
    const added = a.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(MINUTE)
    expect(relay().pushes.length - before).toBeLessThanOrEqual(2)
    expect(relay().broadcasts).toBeGreaterThan(0)
    expect(b.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain(added.id)
    const settledAt = relay().pushes.length
    await advance(MINUTE)
    expect(relay().pushes.length).toBe(settledAt)
  })
})

describe('AC-E17: the echo filter', () => {
  it('starts no cycle for our own landed write, our own rev, or a rev already merged', async () => {
    relay().latency = { pull: 20, push: 100, realtime: 10 }
    relay().writeFraction = 0.1 // our echo arrives before the answer to our push
    const a = await connected()
    const id = await clientOf(a)
    await advance(MINUTE)
    a.expense.useExpenseStore.getState().addExpense({ itemName: 'Mine', amount: 2 })
    await advance(5000)
    const pulls = pullsBy(id)
    // The same write delivered again (a replay after a reconnect): already merged here.
    const ch = channelsOf(id).at(-1)
    const payload = rowPayload(SYNC_CODE)
    ch?.deliver({
      eventType: 'UPDATE',
      schema: 'public',
      table: 'sync_buckets',
      new: { sync_id: SYNC_CODE, payload, updated_at: '2026-11-02T04:00:00.000001+00:00' },
      old: {},
    })
    await advance(5000)
    expect(pullsBy(id)).toBe(pulls)
  })

  it('starts no cycle for a Broadcast from this device or carrying our rev; any other starts one', async () => {
    const a = await connected()
    const id = await clientOf(a)
    await advance(MINUTE)
    const port = a.expense.getSyncPort()
    if (port === null) throw new Error('no port')
    const ch = channelsOf(id).at(-1)
    const pulls = pullsBy(id)
    ch?.hear({ type: 'broadcast', event: 'rev', payload: { rev: 'zzzzzz', dev: port.deviceId() } })
    ch?.hear({
      type: 'broadcast',
      event: 'rev',
      payload: { rev: port.meta().lastRev ?? '', dev: 'other1' },
    })
    await advance(5000)
    expect(pullsBy(id)).toBe(pulls)
    // A real foreign push: one cycle for a burst of three, after the 300 ms coalescing (a
    // Broadcast carries no payload: the cycle pulls).
    for (const rev of ['r1', 'r2', 'r3']) {
      ch?.hear({ type: 'broadcast', event: 'rev', payload: { rev, dev: 'other1' } })
    }
    await advance(299)
    expect(pullsBy(id)).toBe(pulls)
    await advance(5000)
    expect(pullsBy(id)).toBe(pulls + 1)
  })

  it('coalesces foreign row events into one cycle, at least 2 s after the last one', async () => {
    const a = await connected()
    const id = await clientOf(a)
    await advance(MINUTE)
    const pulls = pullsBy(id)
    foreignWrite(1)
    await advance(100)
    foreignWrite(2)
    await advance(1000)
    expect(pullsBy(id)).toBe(pulls + 1)
    foreignWrite(3)
    await advance(500)
    expect(pullsBy(id)).toBe(pulls + 1) // 2 s apart
    await advance(2000)
    expect(pullsBy(id)).toBe(pulls + 2)
    expect(a.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('f3')
  })

  it('uses the hashed topic, never the raw code, for every channel', async () => {
    await connected()
    for (const ch of relay().created) {
      expect(ch.name).toMatch(/^st:[0-9a-f]{32}$/)
      expect(ch.name).not.toContain(SYNC_CODE)
    }
    expect(relay().created.some((c) => c.rowFilter === `sync_id=eq.${SYNC_CODE}`)).toBe(true)
  })
})

describe('T-002-4: the storm breaker', () => {
  it('T-002-4 the 21st remote cycle in 60 s does not run; polling goes on; a local change ends it', async () => {
    const a = await connected()
    const id = await clientOf(a)
    await advance(MINUTE)
    const pulls = pullsBy(id)
    for (let n = 1; n <= 25; n++) {
      foreignWrite(n)
      await advance(2100)
    }
    // 25 events in 52.5 s: 20 cycles ran, then remote events stopped starting any.
    expect(pullsBy(id) - pulls).toBe(20)
    expect(live(a)).toBe('polling')
    // still paused for remote events …
    foreignWrite(26)
    await advance(2100)
    expect(pullsBy(id) - pulls).toBe(20)
    // … while polling continues (every minute while live updates are not fully on)
    await advance(MINUTE)
    expect(pullsBy(id) - pulls).toBeGreaterThanOrEqual(21)
    // a local change ends the pause: the next remote event starts a cycle again
    a.expense.useExpenseStore.getState().addExpense({ itemName: 'Local', amount: 1 })
    await advance(5000)
    const after = pullsBy(id)
    foreignWrite(27)
    await advance(2500)
    expect(pullsBy(id)).toBe(after + 1)
    expect(live(a)).toBe('on')
  })
})

describe('T-018-3 and visibility (AC-E14 to AC-E16)', () => {
  it('T-018-3 a non-empty outbox at boot runs a cycle once online', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const phone = await bootDevice({ expenses: [expense('e1')], savedCode: SYNC_CODE })
    await advance(5000)
    expect(relay().pulls).toBe(0)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(relayRows()).toHaveLength(1)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ cloudStatus: 'synced', pending: 0 })
  })

  it('AC-E16 closes the channel 30 s after the tab is hidden, and opens it again when visible', async () => {
    const phone = await connected()
    await advance(10_000)
    expect(live(phone)).toBe('on')
    setVisibility('hidden')
    expect(live(phone)).toBe('off')
    await advance(29_000)
    expect(relay().channels.size).toBe(1)
    await advance(2000)
    expect(relay().channels.size).toBe(0)
    // hidden: no polling, no subscription
    const looked = relay().heads + relay().pulls
    await advance(10 * MINUTE)
    expect(relay().heads + relay().pulls).toBe(looked)
    setVisibility('visible')
    await advance(1000)
    expect(relay().channels.size).toBe(1)
    expect(relay().heads + relay().pulls).toBeGreaterThan(looked) // the resume, and the join
    expect(live(phone)).toBe('on')
  })

  it('AC-E16 a tab set up while hidden subscribes only once visible', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    setVisibility('hidden')
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 5000)
    expect(relayRows()).toHaveLength(1) // it syncs
    expect(relay().channels.size).toBe(0) // but does not listen
    setVisibility('visible')
    await advance(1000)
    expect(relay().channels.size).toBe(1)
  })
})

describe('AC-E15 and T-002-3', () => {
  it('AC-E15 on hide the envelope is written first, and the cycle starts in the same task', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')], persist: true })
    await connect(phone)
    await advance(10_000)
    const pulls = relay().pulls
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Kopi', amount: 2 })
    setVisibility('hidden')
    // synchronously: the save is on disk, and no request has gone out yet
    expect(phone.storage.getItem('st5:db') ?? '').toContain(added.id)
    expect(relay().pulls).toBe(pulls)
    // microtasks only (no timer has run): the hide cycle's pull is on the wire
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(relay().pulls).toBe(pulls + 1)
    await advance(1000)
    expect(
      relayRows().some(
        (r) => typeof r === 'object' && r !== null && 'id' in r && r.id === added.id,
      ),
    ).toBe(true)
  })

  it('T-002-3 beside a frozen 0.8.4 that chatters for 60 s it pushes at most once per 10 minutes; the memo follows a landed push', async () => {
    const ours = [expense('e1', { category: 'Zzz', updatedAt: '2026-10-10T00:00:00.000Z' })]
    const theirs = [expense('e1', { category: 'Food', updatedAt: '2026-10-10T00:00:00.000Z' })]
    writeAsOther(SYNC_CODE, payloadOf(ours))
    const phone = await bootDevice({ expenses: ours })
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('e1', { notes: 'kept here' })
    await advance(4000)
    const port = phone.expense.getSyncPort()
    if (port === null) throw new Error('no port')
    relay().latency.push = 400 // a push stays on the wire long enough to look at the memo
    const memoBefore = port.meta().memo.memo.length
    const start = relay().pushes.length
    // an object: the hook writes it in a callback the type checker cannot follow
    const inFlight: { memo: number | null } = { memo: null }
    relay().beforeWrite = () => {
      inFlight.memo = port.meta().memo.memo.length
    }
    const chatter = setInterval(() => {
      writeAsOther(SYNC_CODE, payloadOf(theirs))
    }, 600)
    await advance(MINUTE)
    clearInterval(chatter)
    relay().beforeWrite = null
    expect(relay().pushes.length - start).toBeLessThanOrEqual(1)
    // when our push landed, the memo had not been written yet; it is written after
    if (inFlight.memo !== null) expect(inFlight.memo).toBe(memoBefore)
    await advance(10 * MINUTE)
    expect(relay().pushes.length - start).toBeLessThanOrEqual(2)
  })
})

describe('live status while the channel joins', () => {
  it('says connecting from the setup on, while the first cycle runs (never unavailable before a try)', async () => {
    relay().latency = { pull: 2000, push: 60, realtime: 30 }
    const a = await bootDevice({ expenses: [expense('e1')] })
    const setup = a.sync.useSyncStore.getState().setupSync(SYNC_CODE)
    await advance(10)
    expect(a.sync.useSyncStore.getState().cloudStatus).not.toBe('synced')
    expect(live(a)).toBe('connecting')
    await settle(setup, 5000)
    await advance(100)
    expect(live(a)).toBe('on')
  })

  it('says polling at a setup while offline: no channel is tried until the device is back', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const a = await bootDevice({ expenses: [expense('e1')] })
    await settle(a.sync.useSyncStore.getState().setupSync(SYNC_CODE), 1000)
    expect(live(a)).not.toBe('connecting')
  })

  it('says connecting (no promise either way) until the channel answers, then on', async () => {
    relay().subscribeDelay = 8000 // longer than connect() waits
    const a = await connected()
    expect(live(a)).toBe('connecting')
    await advance(3100)
    expect(live(a)).toBe('on')
  })

  it('says polling once a join fails, and off while hidden', async () => {
    relay().realtimeDown = true
    relay().subscribeDelay = 8000
    const a = await connected()
    expect(live(a)).toBe('connecting')
    await advance(3100)
    expect(live(a)).toBe('polling')
    setVisibility('hidden')
    await advance(10)
    expect(live(a)).toBe('off')
  })
})

describe('when realtime cannot carry everything', () => {
  it('falls back to Broadcast alone when row events are refused, and polls every minute', async () => {
    relay().rowEvents = 'rejected'
    const a = await connected()
    await advance(10_000)
    const ch = relay().created.at(-1)
    expect(ch?.broadcastEvents).toBe(true)
    expect(ch?.rowEvents).toBe(false)
    expect(relay().channels.size).toBe(1)
    expect(live(a)).toBe('on')
    const heads = relay().heads
    await advance(3 * MINUTE + 500)
    expect(relay().heads - heads).toBe(3)
  })

  it('still receives another device’s write through polling when realtime is blocked', async () => {
    const a = await connected()
    dropRealtime(true)
    await advance(1000)
    expect(live(a)).toBe('polling')
    const payload = rowPayload(SYNC_CODE)
    if (typeof payload !== 'object' || payload === null) throw new Error('no row')
    writeAsOther(SYNC_CODE, payloadOf([expense('e1'), expense('lap1')]))
    await advance(MINUTE + 1000)
    expect(a.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('lap1')
  })

  it('stops arming row events after a table refusal (migration 005) when detection is on', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    const a = await connected()
    await advance(1000)
    relay().lockdown = true
    await settle(a.sync.useSyncStore.getState().triggerSync(), 1000)
    await advance(1000)
    const last = relay()
      .created.filter((c) => c.broadcastEvents)
      .at(-1)
    expect(last?.rowEvents).toBe(false)
    expect(relay().channels.size).toBe(1)
  })

  it('keeps row events through a passing refusal on the default table pin', async () => {
    const a = await connected()
    await advance(1000)
    const channels = relay().created.length
    failNext('pull', { status: 401, code: '42501', message: 'permission denied for table' })
    await settle(a.sync.useSyncStore.getState().triggerSync(), 1000)
    await advance(5000) // the retry syncs
    expect(relay().created.length).toBe(channels)
    expect(
      relay()
        .created.filter((c) => c.broadcastEvents)
        .at(-1)?.rowEvents,
    ).toBe(true)
    expect(a.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })
})
