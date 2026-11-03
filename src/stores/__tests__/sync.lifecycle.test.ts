// F-017 / F-018: the app lifecycle drives saving and syncing (AC-23 to AC-27, T-018-x).
// Ports the auditors' lifecycle-flush probe (jsdom half; the browser half is e2e).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  MemoryStorage,
  loadDevice,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  seedV4,
  setVisibility,
  settle,
  stubRelayEnv,
  type Device,
  type Failure,
  steadyRandom,
} from '../../__tests__/fakeRelay'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFetch = (v: unknown): v is typeof fetch => typeof v === 'function'

/** Channels that subscribe (an announce on a channel opened just for it has no binding). */
const subscribed = () => relay().created.filter((c) => c.broadcastEvents)
/** Requests that read the relay: a HEAD or a pull. */
const looks = () => relay().heads + relay().pulls
import { syncMessage } from '../syncEngine'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom() // the backoff jitter is asserted elsewhere (sync.status)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  window.dispatchEvent(new Event('offline'))
}

function goOnline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  window.dispatchEvent(new Event('online'))
}

async function connected(): Promise<Device> {
  const phone = await bootDevice({ expenses: [expense('e1')], persist: true })
  await connect(phone)
  return phone
}

describe('saving never waits (F-017, AC-23)', () => {
  it('an add is in st5:db after one microtask, and in the rollback copy once hidden in the same task', async () => {
    const phone = await bootDevice({ persist: true })
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'lifecycle test', amount: 3.3 })
    await Promise.resolve()
    expect(phone.storage.getItem('st5:db') ?? '').toContain(added.id)
    expect(phone.storage.getItem('expenses') ?? '').not.toContain(added.id) // the mirror waits 1 s
    setVisibility('hidden')
    expect(phone.storage.getItem('expenses') ?? '').toContain(added.id)
  })
})

describe('hide syncs what is pending (AC-24)', () => {
  it('runs a cycle immediately when a change is pending', async () => {
    const phone = await connected()
    const pulls = relay().pulls
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Kopi', amount: 1.5 })
    setVisibility('hidden')
    await advance(100) // well before the 1.5 s push timer
    expect(relay().pulls).toBe(pulls + 1)
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: added.id }))
    await advance(10_000)
    expect(relay().pulls).toBe(pulls + 1) // the push timer did not fire a second cycle
  })

  it('sends the hide push with keepalive on pagehide, even while the page still reads visible', async () => {
    const phone = await connected()
    relay().latency = { pull: 0, push: 1000, realtime: 0 }
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    // the SDK's fetch (relayFetch): what it does to a request sent while this push is in flight
    const options: unknown = relay().clientOptions.at(-1)
    const global = isObject(options) && isObject(options.global) ? options.global : {}
    const sdkFetch: unknown = global.fetch
    if (!isFetch(sdkFetch)) throw new Error('no relay fetch')
    const sent: (RequestInit | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        sent.push(init)
        return Promise.resolve(new Response('[]'))
      }),
    )
    window.dispatchEvent(new Event('pagehide')) // Safari may not say 'hidden' first
    await advance(100)
    await sdkFetch('http://relay.test/rest/v1/sync_buckets', { method: 'POST', body: '{}' })
    expect(sent.at(-1)?.keepalive).toBe(true)
    await advance(2000)
    vi.unstubAllGlobals()
  })

  it('runs no cycle when nothing is pending', async () => {
    await connected()
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    setVisibility('hidden')
    await advance(10_000)
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
  })
})

describe('resume, online and offline (AC-25)', () => {
  // PR-3 (P3-15): a resume is a HEAD, so it may run 5 s after the last cycle (was 30 s).
  it('resumes with one HEAD on becoming visible more than 5 s after the last cycle, not within 5 s', async () => {
    const phone = await connected()
    await settle(phone.sync.useSyncStore.getState().triggerSync()) // the last cycle: now
    const before = { heads: relay().heads, pulls: relay().pulls }
    setVisibility('hidden')
    await advance(3000)
    setVisibility('visible')
    await advance(100)
    expect(relay().heads).toBe(before.heads)

    setVisibility('hidden')
    await advance(6000)
    setVisibility('visible')
    await advance(100)
    expect({ heads: relay().heads, pulls: relay().pulls }).toEqual({
      heads: before.heads + 1,
      pulls: before.pulls,
    })
  })

  it('resets the backoff on resume', async () => {
    const phone = await connected()
    // The relay is down for five pulls and two HEADs.
    failNext('pull', ...Array.from({ length: 5 }, (): Failure => ({ status: 503 })))
    failNext('head', { status: 503 }, { status: 503 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    await advance(2000 + 4000 + 8000 + 16_000) // four retries fail; the next would wait 32 s
    const tries = looks()
    setVisibility('hidden')
    setVisibility('visible')
    await advance(100)
    expect(looks()).toBe(tries + 1) // at once (a HEAD, failing); the retry now waits 2 s
    await advance(2000)
    expect(looks()).toBe(tries + 2) // failing again: the next waits 4 s
    await advance(4000)
    expect(looks()).toBe(tries + 3)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it("syncs at once on 'online', and the next failure waits 2 s", async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 3 }, (): Failure => ({ status: 503 })))
    failNext('head', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    await advance(2000 + 4000) // two retries fail; the next would wait 8 s
    const tries = looks()
    goOnline()
    await advance(100)
    expect(looks()).toBe(tries + 1) // at once, failing; the retry now waits 2 s
    await advance(2000)
    expect(looks()).toBe(tries + 2)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it("on 'offline': clears the retry, shows offline, and makes no network calls", async () => {
    const phone = await connected()
    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    goOffline()
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('offline')
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const result = await settle(phone.sync.useSyncStore.getState().triggerSync())
    expect(result).toMatchObject({ ok: false, error: 'offline' })
    await advance(5 * 60_000)
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(true)

    goOnline()
    await advance(1000)
    expect(relay().upserts).toBe(before.upserts + 1)
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false)
  })

  it("on 'offline' after a failure: offline replaces the failure, so nothing says retrying", async () => {
    const phone = await connected()
    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('server')
    goOffline()
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'offline',
      lastError: { kind: 'offline', message: syncMessage('offline') },
    })
  })

  it('a request that fails because the device went offline on the way resolves offline', async () => {
    const phone = await connected()
    relay().latency.pull = 500
    failNext('pull', { status: 0 })
    const pending = phone.sync.useSyncStore.getState().triggerSync()
    await advance(100)
    // The connection drops while the pull is on the wire; the 'offline' event comes later.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await settle(pending, 500)).toMatchObject({ ok: false, error: 'offline' })
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'offline',
      lastError: { kind: 'offline' },
    })
    const pulls = relay().pulls
    await advance(5 * 60_000)
    expect(relay().pulls).toBe(pulls) // no retry while offline; 'online' resumes
  })

  it('a resume subscribes realtime when no channel is open (the online event was missed)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const phone = await bootDevice({ expenses: [expense('e1')], savedCode: SYNC_CODE })
    await advance(5000)
    setVisibility('hidden') // backgrounded while offline
    await advance(60_000)
    expect(subscribed()).toHaveLength(0)
    // The network came back while the app was frozen: the page never saw 'online'.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    setVisibility('visible')
    await advance(1000)
    expect(subscribed()).toHaveLength(1)
    expect(relay().channels.size).toBe(1)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })
})

describe('backoff (AC-26)', () => {
  it('retries after 2, 4, 8, 16, 32, 60 and 60 s, never longer', async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 9 }, (): Failure => ({ status: 503 })))
    await settle(phone.sync.useSyncStore.getState().triggerSync(), 0)
    const gaps: number[] = []
    let last = Date.now()
    let pulls = relay().pulls
    for (let ms = 0; ms < 400_000 && gaps.length < 7; ms += 100) {
      await advance(100)
      if (relay().pulls > pulls) {
        pulls = relay().pulls
        gaps.push(Math.round((Date.now() - last) / 1000))
        last = Date.now()
      }
    }
    expect(gaps).toEqual([2, 4, 8, 16, 32, 60, 60])
  })
})

describe('realtime re-subscribe catches up (AC-27)', () => {
  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    'runs one cycle when SUBSCRIBED follows %s (a HEAD: nothing changed meanwhile)',
    async (status) => {
      await connected()
      const channel = subscribed().at(-1)
      const before = { heads: relay().heads, pulls: relay().pulls }
      channel?.emit(status)
      await advance(2000 + 10 + 100) // reconnect delay, then SUBSCRIBED
      expect(subscribed().length).toBeGreaterThan(1)
      expect({ heads: relay().heads, pulls: relay().pulls }).toEqual({
        heads: before.heads + 1,
        pulls: before.pulls,
      })
    },
  )

  it("subscribes a device that booted offline when 'online' fires", async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const phone = await bootDevice({ expenses: [expense('e1')], savedCode: SYNC_CODE })
    await advance(5000)
    expect(subscribed()).toHaveLength(0)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('offline')

    goOnline()
    await advance(1000)
    expect(subscribed()).toHaveLength(1)
    expect(relay().channels.size).toBe(1)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1' }))
  })
})

describe('start-up with a saved code', () => {
  it('is linked from the first frame, before local data or the engine chunk has loaded', async () => {
    const storage = new MemoryStorage()
    seedV4(storage, { expenses: [expense('e1')] })
    storage.setItem('syncId', SYNC_CODE)
    const phone = await loadDevice(storage)
    phone.sync.installSync()
    // Synchronously: the panel never offers Generate to a linked device while sync loads, and
    // nothing is known to be on the relay yet, so a change made now reads "Syncing…".
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      syncId: SYNC_CODE,
      cloudStatus: 'idle',
      pendingLocal: true,
    })
    // The first cycle waits for local data: it never merges into an empty doc.
    await advance(5000)
    expect(relay().pulls).toBe(0)
    await phone.expense.useExpenseStore.getState().hydrate()
    await advance(5000)
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1' }))
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      syncId: SYNC_CODE,
      cloudStatus: 'synced',
      pendingLocal: false,
    })
  })
})

// Storage full: the code works for this session, but this device forgets it when SpendTrack
// closes. That must not be silent: after a restart the device would simply not sync.
describe('a sync code that storage refuses', () => {
  const forgets = (phone: Awaited<ReturnType<typeof loadDevice>>) =>
    phone.ui.useUIStore
      .getState()
      .toasts.filter((t) => t.message.startsWith("This device couldn't save the sync code"))
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('still syncs, and says once that this device forgets it when SpendTrack closes', async () => {
    const storage = new MemoryStorage()
    const phone = await bootDevice({ expenses: [expense('e1')], storage })
    storage.refuse.add('syncId')
    storage.refuse.add('st5:sync')
    expect(await connect(phone)).toMatchObject({ ok: true })
    expect(storage.getItem('syncId')).toBeNull()
    expect(storage.getItem('st5:sync')).toBeNull()
    expect(forgets(phone)).toEqual([expect.objectContaining({ kind: 'warning' })])
    phone.ui.useUIStore.setState({ toasts: [] })
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE))
    expect(forgets(phone)).toEqual([])
  })

  it('says nothing at start-up, when the saved code is already there', async () => {
    const storage = new MemoryStorage()
    seedV4(storage, { expenses: [expense('e1')] })
    storage.setItem('syncId', SYNC_CODE)
    const phone = await loadDevice(storage)
    await phone.expense.useExpenseStore.getState().hydrate()
    storage.refuse.add('*') // full from now on
    const setItem = vi.spyOn(storage, 'setItem')
    phone.sync.installSync()
    await advance(5000)
    // Re-saved (syncId first, so st5:sync is never written alone, P2-7), and refused.
    expect(setItem.mock.calls.some(([key]) => key === 'syncId')).toBe(true)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(forgets(phone)).toEqual([])
  })
})
