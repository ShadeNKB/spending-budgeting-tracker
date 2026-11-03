// The HEAD short-circuit (PR-3 track spec P3-3, P3-4, AC-E4, T-018-1): a resume, poll,
// resubscribe or `online` with nothing to send asks the relay one question (its etag) and stops
// there when the answer is the copy this device already holds. Anything pending, any news, a
// stale registry entry or an etag of another code means a full cycle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fnv36 } from '../../data/core/hash'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  failNext,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  rowStamp,
  seedRow,
  setVisibility,
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

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const MINUTE = 60_000
const OTHER_CODE = '22222222-2222-4222-8222-222222222222'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

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

const counts = () => ({
  heads: relay().heads,
  pulls: relay().pulls,
  pushes: relay().pushes.length,
})

async function connected(): Promise<Device> {
  const phone = await bootDevice({ expenses: [expense('e1')] })
  await connect(phone)
  return phone
}

function portOf(d: Device) {
  const port = d.expense.getSyncPort()
  if (port === null) throw new Error('no port')
  return port
}

/** The four reasons a HEAD may answer, each started the way the app starts it. */
const REASONS: [string, (d: Device) => Promise<void>][] = [
  [
    'resume',
    async () => {
      setVisibility('hidden')
      await advance(6000)
      setVisibility('visible')
      await advance(100)
    },
  ],
  [
    'poll',
    async () => {
      // live updates are on: the poll that finds a silently dead socket runs every 5 minutes
      await advance(5 * MINUTE + 100)
    },
  ],
  [
    'resubscribe',
    async () => {
      relay()
        .created.filter((c) => c.broadcastEvents)
        .at(-1)
        ?.emit('CLOSED')
      await advance(2000 + 10 + 100)
    },
  ],
  [
    'online',
    async () => {
      window.dispatchEvent(new Event('online'))
      await advance(100)
    },
  ],
]

describe('T-018-1: a HEAD answers when nothing changed', () => {
  it.each(REASONS)(
    'T-018-1 %s with an empty outbox and the same etag makes exactly one HEAD, no pull, no push',
    async (_reason, start) => {
      const phone = await connected()
      await advance(10_000)
      const before = counts()
      await start(phone)
      expect(counts()).toEqual({ ...before, heads: before.heads + 1 })
      expect(phone.sync.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'synced',
        pending: 0,
      })
    },
  )

  it.each(REASONS)('T-018-1 %s after the relay moved runs a full cycle', async (_reason, start) => {
    const phone = await connected()
    await advance(10_000)
    // Another device wrote: the etag moved (no event reaches this device).
    seedRow(SYNC_CODE, rowPayload(SYNC_CODE))
    const before = counts()
    await start(phone)
    expect(counts().heads).toBe(before.heads + 1)
    expect(counts().pulls).toBe(before.pulls + 1)
  })

  it('T-018-1 polls every 60 s while live updates are off, and every 5 min while they are on', async () => {
    await connected()
    await advance(10_000)
    let before = relay().heads
    await advance(4 * MINUTE)
    expect(relay().heads).toBe(before) // live: the 5-minute poll has not come yet
    await advance(MINUTE + 100)
    expect(relay().heads).toBe(before + 1)
    dropRealtime(true) // the socket is gone: poll every minute
    await advance(100)
    before = relay().heads
    await advance(3 * MINUTE + 100)
    expect(relay().heads - before).toBe(3)
    expect(relay().pulls).toBe(relay().pulls) // and still no pull
  })
})

describe('AC-E4: what skips the HEAD', () => {
  it('a non-empty outbox skips it: the cycle pulls and pushes', async () => {
    const phone = await connected()
    await advance(10_000)
    // offline when the change is made, so it waits in the outbox for 'online'
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)
    const before = counts()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(counts()).toEqual({
      heads: before.heads,
      pulls: before.pulls + 1,
      pushes: before.pushes + 1,
    })
  })

  it('waiting news skips it: the event payload is merged by a full cycle', async () => {
    const phone = await connected()
    await advance(10_000)
    setVisibility('hidden')
    await advance(6000)
    const payload = rowPayload(SYNC_CODE)
    if (typeof payload !== 'object' || payload === null) throw new Error('no row')
    // A foreign event arrives just before the app comes back; its coalesced cycle waits 300 ms.
    writeAsOther(SYNC_CODE, {
      ...payload,
      expenses: [expense('e1'), expense('lap1', { itemName: 'From the laptop' })],
      x5: undefined,
    })
    await advance(1)
    const before = counts()
    setVisibility('visible')
    await advance(1)
    expect(counts().heads).toBe(before.heads)
    expect(counts().pulls).toBe(before.pulls + 1)
    await advance(1000)
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('lap1')
  })

  it('a stale registry entry skips it: one full cycle pushes the entry, then HEADs again', async () => {
    const phone = await connected()
    await advance(10_000)
    const port = portOf(phone)
    const me = port.deviceId()
    const entry = port.doc().devices.get(me)
    if (entry === undefined) throw new Error('not registered')
    // This device ran an older build, which registered it here and on the relay as 0.9.9.
    port.register(me, { ...entry, app: '0.9.9', seen: entry.seen + 1 })
    const row = relay().rows.get(SYNC_CODE)
    const x5 = row !== undefined && isObject(row.payload) ? row.payload.x5 : undefined
    const devs = isObject(x5) ? x5.devs : undefined
    const mine = isObject(devs) ? devs[me] : undefined
    if (!isObject(devs) || !isObject(mine)) throw new Error('no registry on the relay')
    devs[me] = { ...mine, app: '0.9.9', at: entry.seen + 1 }
    const before = counts()
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(counts()).toEqual({
      heads: before.heads,
      pulls: before.pulls + 1,
      pushes: before.pushes + 1,
    })
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(counts()).toEqual({
      heads: before.heads + 1,
      pulls: before.pulls + 1,
      pushes: before.pushes + 1,
    })
  })
})

describe('the etag belongs to its code (etagFor)', () => {
  it('stores the etag the relay returned, scoped to fnv36(code), never the code itself', async () => {
    const phone = await connected()
    const meta = portOf(phone).meta()
    expect(meta.lastEtag).toBe(rowStamp(SYNC_CODE))
    expect(meta.etagFor).toBe(fnv36(SYNC_CODE))
    expect(phone.storage.getItem('st5:db') ?? '').not.toContain(SYNC_CODE)
  })

  it('never answers a HEAD on one code with the etag of another', async () => {
    const phone = await connected()
    await advance(10_000)
    phone.sync.useSyncStore.getState().disconnectSync()
    seedRow(OTHER_CODE, rowPayload(SYNC_CODE))
    await settle(phone.sync.useSyncStore.getState().setupSync(OTHER_CODE), 5000)
    await advance(10_000)
    // The old code's etag comes back (a tab of an older session), and the new row has exactly it.
    const port = portOf(phone)
    const stale = port.meta().lastEtag ?? ''
    port.setMeta({ lastEtag: stale, etagFor: fnv36(SYNC_CODE) })
    const row = relay().rows.get(OTHER_CODE)
    if (row === undefined) throw new Error('no row')
    row.updated_at = stale
    const before = counts()
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(counts().heads).toBe(before.heads) // not headable: the etag is another code's
    expect(counts().pulls).toBe(before.pulls + 1)
  })
})

describe('T-018-1: a HEAD never answers with an etag from before this setup', () => {
  const relayIds = (): unknown[] => relayRows().map((r) => (isObject(r) ? r.id : undefined))

  /** Linked, then disconnected, with an entry added while sync is off (it reaches no outbox). */
  async function addedWhileOff(): Promise<{ phone: Device; id: string }> {
    const phone = await connected()
    await advance(10_000)
    phone.sync.useSyncStore.getState().disconnectSync()
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'While off', amount: 7 })
    await advance(2000)
    expect(portOf(phone).outbox().size).toBe(0) // M34: nothing in the outbox with sync off
    return { phone, id: added.id }
  }

  it.each([false, true])(
    'T-018-1 a Reconnect (join: %s) made offline: the first cycle back online pulls and pushes what was added while off',
    async (join) => {
      const { phone, id } = await addedWhileOff()
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      window.dispatchEvent(new Event('offline'))
      await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE, { join }), 1000)
      const before = counts()
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      window.dispatchEvent(new Event('online'))
      await advance(5000)
      // the etag is from before the Disconnect: a full cycle, whose push carries the entry
      expect(counts().pulls).toBeGreaterThan(before.pulls)
      expect(counts().pushes).toBe(before.pushes + 1)
      expect(relayIds()).toContain(id)
      expect(phone.sync.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'synced',
        pending: 0,
        pendingLocal: false,
      })
    },
  )

  it('T-018-1 a Reconnect whose first pull fails: the resume after it pulls and pushes, never only HEADs', async () => {
    const { phone, id } = await addedWhileOff()
    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 300)
    expect(relayIds()).not.toContain(id)
    setVisibility('hidden')
    await advance(6000)
    setVisibility('visible')
    await advance(3000)
    expect(relayIds()).toContain(id)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ cloudStatus: 'synced', pending: 0 })
  })

  it('T-018-1 once a full cycle of this setup has run, an idle resume is a HEAD again', async () => {
    const { phone, id } = await addedWhileOff()
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 5000)
    expect(relayIds()).toContain(id)
    await advance(10_000)
    const before = counts()
    setVisibility('hidden')
    await advance(6000)
    setVisibility('visible')
    await advance(100)
    expect(counts()).toEqual({ ...before, heads: before.heads + 1 })
  })

  it('T-018-1 a change committed here without an outbox entry (sync storage unreadable) skips the HEAD', async () => {
    const phone = await connected()
    await advance(10_000)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    // The saved code cannot be read back for a moment: the local engine sees sync off and fills
    // no outbox, while the sync engine (its code in memory) still runs
    const keys = ['st5:sync', 'syncId'] as const
    const saved = keys.map((k) => phone.storage.getItem(k))
    for (const k of keys) phone.storage.removeItem(k)
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'No outbox', amount: 3 })
    keys.forEach((k, i) => {
      const value = saved[i]
      if (value !== null && value !== undefined) phone.storage.setItem(k, value)
    })
    expect(portOf(phone).outbox().size).toBe(0)
    await advance(10_000) // its local-change cycle finds the device offline
    const before = counts()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await advance(1000)
    expect(counts().heads).toBe(before.heads)
    expect(relayIds()).toContain(added.id)
  })
})
