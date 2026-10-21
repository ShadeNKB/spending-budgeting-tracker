// F-017 / F-018: the app lifecycle drives saving and syncing (AC-23 to AC-27).
// Ports the auditors' lifecycle-flush probe (jsdom half; the browser half is e2e).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  setVisibility,
  settle,
  stubRelayEnv,
  type Device,
  type Failure,
} from '../../__tests__/fakeRelay'

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

describe('hide flushes the save at once (F-017, AC-23)', () => {
  it('an add followed by visibilitychange -> hidden in the same task is in localStorage', async () => {
    const phone = await bootDevice({ persist: true })
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'lifecycle test', amount: 3.3 })
    expect(localStorage.getItem('expenses') ?? '').not.toContain(added.id) // still debounced
    setVisibility('hidden')
    expect(localStorage.getItem('expenses') ?? '').toContain(added.id)
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
    await advance(100) // well before the 3 s push timer
    expect(relay().pulls).toBe(pulls + 1)
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: added.id }))
    await advance(10_000)
    expect(relay().pulls).toBe(pulls + 1) // the push timer did not fire a second cycle
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
  it('syncs on becoming visible more than 30 s after the last sync, and not within 30 s', async () => {
    await connected()
    const pulls = relay().pulls
    setVisibility('hidden')
    await advance(20_000)
    setVisibility('visible')
    await advance(100)
    expect(relay().pulls).toBe(pulls)

    setVisibility('hidden')
    await advance(31_000)
    setVisibility('visible')
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1)
  })

  it('resets the backoff on resume', async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 6 }, (): Failure => ({ status: 503 })))
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    await advance(2000 + 4000 + 8000 + 16_000) // four retries fail; the next would wait 32 s
    const pulls = relay().pulls
    setVisibility('hidden')
    setVisibility('visible')
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1) // the sixth failure; the retry now waits 2 s
    await advance(2000)
    expect(relay().pulls).toBe(pulls + 2)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it("syncs at once on 'online', and the next failure waits 2 s", async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 4 }, (): Failure => ({ status: 503 })))
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    await advance(2000 + 4000) // two retries fail; the next would wait 8 s
    const pulls = relay().pulls
    goOnline()
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1) // the fourth failure; the retry now waits 2 s
    await advance(2000)
    expect(relay().pulls).toBe(pulls + 2)
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
      lastError: { kind: 'offline', message: phone.sync.syncMessage('offline') },
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
    expect(relay().created).toHaveLength(0)
    // The network came back while the app was frozen: the page never saw 'online'.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    setVisibility('visible')
    await advance(1000)
    expect(relay().created).toHaveLength(1)
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
    'runs one cycle when SUBSCRIBED follows %s',
    async (status) => {
      await connected()
      const channel = relay().created.at(-1)
      const pulls = relay().pulls
      channel?.emit(status)
      await advance(2000 + 10 + 100) // reconnect delay, then SUBSCRIBED
      expect(relay().created.length).toBeGreaterThan(1)
      expect(relay().pulls).toBe(pulls + 1)
    },
  )

  it("subscribes a device that booted offline when 'online' fires", async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const phone = await bootDevice({ expenses: [expense('e1')], savedCode: SYNC_CODE })
    await advance(5000)
    expect(relay().created).toHaveLength(0)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('offline')

    goOnline()
    await advance(1000)
    expect(relay().created).toHaveLength(1)
    expect(relay().channels.size).toBe(1)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1' }))
  })
})
