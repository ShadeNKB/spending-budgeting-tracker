// F-016 honest results, F-005/F-006 poisoned relay copies (quarantine, a bounded repair, fences)
// and the v5 wire stamp (AC-17 to AC-22, AC-28, T-005-2). Every failure resolves a SyncResult;
// nothing throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { isRecord } from '../../lib/backup'
import {
  MemoryStorage,
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  payloadOf,
  relay,
  relayRows,
  relayDeleted,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  settle,
  stubRelayEnv,
  writeAsOther,
  type Device,
  type Failure,
  steadyRandom,
} from '../../__tests__/fakeRelay'
import { syncMessage } from '../syncEngine'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom() // the backoff jitter is asserted elsewhere (sync.status)
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

async function connected(expenses: Expense[] = [expense('e1')]): Promise<Device> {
  const phone = await bootDevice({ expenses })
  await connect(phone)
  return phone
}

const trigger = (device: Device, ms = 100) =>
  settle(device.sync.useSyncStore.getState().triggerSync(), ms)

const toastsOf = (device: Device) => device.ui.useUIStore.getState().toasts

describe('every injected failure resolves an honest result (T-016-1)', () => {
  const transport: [string, 'pull' | 'push', Failure, string][] = [
    ['a network failure (status 0) on the pull', 'pull', { status: 0 }, 'network'],
    ['a network failure (status 0) on the push', 'push', { status: 0 }, 'network'],
    ['a 503 on the pull', 'pull', { status: 503, message: 'Service Unavailable' }, 'server'],
    ['a 401 on the push', 'push', { status: 401, message: 'Unauthorized' }, 'permission'],
    [
      'code 42501 on the pull',
      'pull',
      { status: 400, code: '42501', message: 'permission denied' },
      'permission',
    ],
  ]

  it.each(transport)('%s', async (_label, op, failure, kind) => {
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    failNext(op, failure)
    const result = await trigger(phone)
    expect(result).toMatchObject({ ok: false, error: kind })
    const sync = phone.sync.useSyncStore.getState()
    expect(sync.cloudStatus).toBe('error')
    expect(sync.lastError?.kind).toBe(kind)
    expect(sync.pendingLocal).toBe(true)
  })

  it('a request that never settles fails as network after 15 s, and the next cycle runs normally', async () => {
    const phone = await connected()
    failNext('pull', { hang: true })
    const pending = phone.sync.useSyncStore.getState().triggerSync()
    await advance(14_999)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('syncing')
    const result = await settle(pending, 1)
    expect(result).toMatchObject({ ok: false, error: 'network' })
    expect(await trigger(phone)).toMatchObject({ ok: true })
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it('an SDK download that never finishes fails as network after 15 s, and the retry syncs', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().importStalls = 1 // the first visit, before the service worker holds the SDK chunk
    const pending = phone.sync.useSyncStore.getState().setupSync(SYNC_CODE)
    await advance(14_999)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('syncing')
    expect(await settle(pending, 1)).toMatchObject({ ok: false, error: 'network' })
    await advance(2100) // the first backoff retry (2 s) loads the SDK again
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      pendingLocal: false,
    })
    expect(relayRows()).toHaveLength(1)
  })

  it('setupSync resolves the same honest result', async () => {
    const phone = await bootDevice()
    failNext('pull', { status: 503 })
    const result = await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE))
    expect(result).toMatchObject({ ok: false, error: 'server' })
  })
})

// P2-8: a relay copy this device cannot read is kept (needs attention) and pushed over with this
// device's doc, at most once per 10 minutes, so two devices that disagree cannot loop.
describe('a damaged relay copy is quarantined and repaired, at most once per 10 minutes (T-005-2)', () => {
  const garbage: [string, unknown][] = [
    ['a non-object', 'garbage'],
    ['a top-level array', [expense('e1')]],
    ['expenses: null', { expenses: null, categories: [] }],
  ]

  it.each(garbage)('%s: kept for the owner, repaired from this device', async (_label, raw) => {
    const phone = await connected([expense('e1'), expense('e2')])
    const store = phone.expense.useExpenseStore
    const before = store.getState().expenses
    const attention = store.getState().attention.quarantined
    seedRow(SYNC_CODE, raw)
    const upserts = relay().upserts

    expect(await trigger(phone)).toMatchObject({ ok: true, pushed: true })
    expect(relay().upserts).toBe(upserts + 1)
    expect(relayRows().map((r) => (isRecord(r) ? r.id : r))).toEqual(['e1', 'e2'])
    expect(store.getState().expenses).toBe(before) // nothing merged from it
    expect(store.getState().attention.quarantined).toBeGreaterThan(attention)
    expect(toastsOf(phone).map((t) => t.message)).toEqual([
      'The sync copy was damaged. Restored it from this device.',
    ])
  })

  // P2-8, P2-16: the quarantine entry holds a 64 KB excerpt, so the push over the copy waits for
  // a whole copy of it on this device.
  it('keeps the whole damaged copy (past the 64 KB excerpt) before pushing over it', async () => {
    const phone = await connected()
    const big = { expenses: 'x'.repeat(90_000), categories: 7 }
    seedRow(SYNC_CODE, big)
    expect(await trigger(phone)).toMatchObject({ ok: true, pushed: true })
    const keys = Array.from({ length: phone.storage.length }, (_, i) => phone.storage.key(i))
    const copies = keys.filter((k) => k?.startsWith('st5:q:relay:') === true)
    expect(copies).toHaveLength(1)
    expect(phone.storage.getItem(copies[0] ?? '')).toBe(JSON.stringify(big))
  })

  it('pushes nothing over a damaged copy it cannot keep whole', async () => {
    const disk = new MemoryStorage()
    const phone = await bootDevice({ storage: disk, expenses: [expense('e1')] })
    await connect(phone)
    disk.refuse.add('st5:q:relay:*')
    seedRow(SYNC_CODE, 'garbage')
    const upserts = relay().upserts
    expect(await trigger(phone)).toMatchObject({ ok: false, error: 'invalid' })
    expect(relay().upserts).toBe(upserts)
    expect(rowPayload(SYNC_CODE)).toBe('garbage')
  })

  it('damaged again within 10 minutes: an honest failure and no push, then one repair', async () => {
    const phone = await connected()
    seedRow(SYNC_CODE, 'garbage')
    expect(await trigger(phone)).toMatchObject({ ok: true, pushed: true })
    const upserts = relay().upserts

    // Another device keeps writing what this one cannot read.
    seedRow(SYNC_CODE, [1, 2, 3])
    expect(await trigger(phone)).toMatchObject({ ok: false, error: 'invalid' })
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('error')
    await advance(9 * MINUTE) // its retries pull, and push nothing
    expect(relay().upserts).toBe(upserts)
    expect(rowPayload(SYNC_CODE)).toEqual([1, 2, 3])

    await advance(2 * MINUTE) // the repair is due again
    expect(relay().upserts).toBe(upserts + 1)
    expect(relayRows()).toHaveLength(1)
    // Said once per session, however often it is repaired.
    expect(
      toastsOf(phone).filter((t) => t.message.startsWith('The sync copy was damaged')),
    ).toHaveLength(1)
  })

  it('a poisoned copy (bad dates, objects, far-future stamps) never crashes and never wipes', async () => {
    const phone = await connected([expense('e1'), expense('e2', { amount: 7 })])
    const far = '2999-01-01T00:00:00.000Z'
    writeAsOther(
      SYNC_CODE,
      payloadOf(
        [
          { ...expense('p1'), date: 'yesterday' },
          { ...expense('p2'), amount: { value: 5 } },
          expense('e2', { amount: 9999, updatedAt: far }), // a far-future stamp orders as unknown
          { ...expense('p3'), category: ['Food'] },
          expense('p4', { itemName: 'Fresh', amount: 3 }),
        ],
        { categories: 'Food', categoryMappings: [], budgets: { Food: 'lots' } },
      ),
    )
    await advance(5000)
    const store = phone.expense.useExpenseStore.getState()
    const ids = store.expenses.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['e1', 'e2', 'p4']))
    expect(ids).not.toContain('p1')
    expect(ids).not.toContain('p2')
    // A stamp outside 2000–2099 never beats a real edit: e2 keeps the amount it had here.
    expect(store.expenses.find((e) => e.id === 'e2')?.amount).toBe(7)
    expect(store.attention.quarantined).toBeGreaterThanOrEqual(2)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ cloudStatus: 'synced' })
    // The relay gets this device's readable doc back, and stays quiet.
    const upserts = relay().upserts
    await advance(10 * MINUTE)
    expect(relay().upserts).toBe(upserts)
  })

  it('a tombstone flood is applied, snapshotted and undoable in one tap (T-006-2)', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => expense(`m${String(i)}`))
    const phone = await connected(rows)
    // A hostile (or confused) writer deletes everything the relay holds.
    writeAsOther(
      SYNC_CODE,
      payloadOf([], { deletedIds: rows.map((r) => r.id), wr: { rev: 'flood', dev: 'x' } }),
    )
    await advance(5000)
    expect(phone.expense.useExpenseStore.getState().expenses).toHaveLength(0)
    const toast = toastsOf(phone).find((t) => t.message.startsWith('Your other device removed'))
    expect(toast).toMatchObject({
      kind: 'warning',
      message: 'Your other device removed 60 entries',
      action: { label: 'Undo' },
    })

    // The Undo runs in the Recovery centre's lazy chunk, which the toast started loading: a real
    // module load, which virtual time does not run, so the test waits for it as a tap would.
    await phone.expense.useExpenseStore.getState().recovery()
    toast?.action?.onClick()
    await advance(0)
    expect(phone.expense.useExpenseStore.getState().expenses).toHaveLength(60)
    expect(toastsOf(phone).some((t) => t.message === 'Restored 60 entries')).toBe(true)
    // The revival is a forward write: it reaches the relay and sticks there.
    await advance(10_000)
    expect(relayRows()).toHaveLength(60)
    expect(relayDeleted()).toHaveLength(60) // the old ids stay dead; the rows live on new ids
    await advance(5 * MINUTE)
    expect(phone.expense.useExpenseStore.getState().expenses).toHaveLength(60)
  })

  it('Delete everywhere on one device: the other says so, and its Undo brings them back on both (acceptance 15)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => expense(`m${String(i)}`))
    const laptop = await bootDevice({ expenses: rows })
    const phone = await bootDevice({ expenses: rows })
    relay().latency = { pull: 150, push: 150, realtime: 60 }
    await connect(laptop)
    await connect(phone)
    await advance(10_000)

    laptop.expense.useExpenseStore.getState().deleteAllEverywhere()
    await advance(10_000)
    expect(phone.expense.useExpenseStore.getState().expenses).toHaveLength(0)
    // 12 of 12 live entries: under 50, but every one of them (>= 10 and >= 10 % of live).
    const toast = toastsOf(phone).find((t) => t.message.startsWith('Your other device removed'))
    expect(toast).toMatchObject({ message: 'Your other device removed 12 entries' })
    expect(toast?.duration).toBe(30_000)
    // The device that deleted was asked first, and has its own Undo: no toast about itself.
    expect(toastsOf(laptop).some((t) => t.message.startsWith('Your other device'))).toBe(false)

    toast?.action?.onClick()
    await advance(10_000)
    for (const device of [laptop, phone]) {
      const back = device.expense.useExpenseStore.getState().expenses
      expect(back.map((e) => e.itemName).sort()).toEqual(rows.map((e) => e.itemName).sort())
    }
    expect(relayRows()).toHaveLength(12)
    const idle = relay().upserts
    await advance(5 * MINUTE)
    expect(relay().upserts).toBe(idle)
  })
})

describe('too large: paused, one toast, merging continues (AC-18)', () => {
  const big = (n: number): Expense[] =>
    Array.from({ length: n }, (_, i) =>
      expense(`b${String(i)}`, { itemName: `Expense ${String(i)}`, notes: 'x'.repeat(200) }),
    )

  it('pauses with one toast per session and no retry, keeps merging, keeps local data', async () => {
    // A background cycle (the saved code at start-up) hits the pause: the store toasts.
    const phone = await bootDevice({ expenses: big(4000), savedCode: SYNC_CODE })
    await advance(5000)
    const local = phone.expense.useExpenseStore.getState().expenses
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('paused')
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('too-large')
    expect(toastsOf(phone).filter((t) => t.message.includes('too large'))).toHaveLength(1)
    const result = await trigger(phone)
    expect(result).toMatchObject({ ok: false, error: 'too-large' })
    expect(toastsOf(phone).filter((t) => t.message.includes('too large'))).toHaveLength(1)

    const pulls = relay().pulls
    await advance(5 * MINUTE)
    // No retry storm: only the live-updates poll (one per 5 min) looks, to keep merging (P3-13).
    expect(relay().pulls - pulls).toBeLessThanOrEqual(1)
    expect(relay().upserts).toBe(0)

    // Another device writes a small change: it is still merged here.
    writeAsOther(SYNC_CODE, payloadOf([expense('laptop1', { itemName: 'From the laptop' })]))
    await advance(5000)
    const ids = phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)
    expect(ids).toContain('laptop1')
    expect(ids.filter((id) => id.startsWith('b'))).toHaveLength(local.length)
    expect(toastsOf(phone).filter((t) => t.message.includes('too large'))).toHaveLength(1)
  })

  it('leaves the once-per-session toast to the panel when the owner asked for the cycle', async () => {
    // Connect runs the first cycle for the owner: SyncPanel toasts its result, so the store
    // does not stack an identical toast on it, and later background cycles stay quiet too.
    const phone = await connected(big(4000))
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('too-large')
    expect(toastsOf(phone)).toEqual([])
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10_000)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('too-large')
    expect(toastsOf(phone)).toEqual([])
  })
})

describe('going offline never ends a pause, nor promises a sync it will not run', () => {
  const setOnline = (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
    window.dispatchEvent(new Event(online ? 'online' : 'offline'))
  }
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })
  const big = Array.from({ length: 4000 }, (_, i) =>
    expense(`b${String(i)}`, { itemName: `Expense ${String(i)}`, notes: 'x'.repeat(200) }),
  )
  const willSync = (device: Device) => toastsOf(device).filter((t) => /will sync/.test(t.message))

  it.each([
    ['too large', 'too-large', () => connected(big)],
    [
      'moved',
      'moved',
      async () => {
        const phone = await connected()
        seedRow(SYNC_CODE, { version: '4.0', expenses: 'moved', categories: [] })
        await trigger(phone)
        return phone
      },
    ],
  ] as const)(
    '%s: offline keeps the pause, its words and its result',
    async (_label, kind, open) => {
      const phone = await open()
      const paused = phone.sync.useSyncStore.getState()
      expect(paused).toMatchObject({ cloudStatus: 'paused', lastError: { kind } })

      setOnline(false)
      expect(phone.sync.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'paused',
        lastError: paused.lastError,
      })
      // Sync now while offline: the pause, never "will sync when you're back".
      const result = await trigger(phone)
      expect(result).toEqual({ ok: false, error: kind, message: paused.lastError?.message })
      expect(phone.sync.useSyncStore.getState().lastError).toEqual(paused.lastError)
      expect(willSync(phone)).toEqual([])

      setOnline(true)
      await advance(5000)
      expect(phone.sync.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'paused',
        lastError: { kind },
      })
      expect(willSync(phone)).toEqual([])
    },
  )

  // Offline keeps refused access and a long streak, and nothing retries while offline: no
  // failure's words may promise a retry (the server's said "Retrying automatically").
  it.each([
    'offline',
    'network',
    'server',
    'permission',
    'invalid',
    'too-large',
    'moved',
    'update-required',
    'reload',
    'busy',
    'not-found',
    'denied',
  ] as const)('the words for %s promise no retry', (kind) => {
    expect(syncMessage(kind)).not.toMatch(/retr/i)
  })

  it('offline keeps refused access, its words and its result, and promises nothing', async () => {
    const phone = await connected()
    // A refusal is the relay's: a HEAD (online, resume, poll) meets it as well as a pull.
    failNext('head', ...Array.from({ length: 10 }, (): Failure => ({ status: 401 })))
    failNext('pull', ...Array.from({ length: 10 }, (): Failure => ({ status: 401 })))
    expect(await trigger(phone)).toMatchObject({ ok: false, error: 'permission' })
    const refused = phone.sync.useSyncStore.getState().lastError

    setOnline(false)
    // Kept, without the retry time: no retry runs while offline.
    expect(refused?.retryAt).toBeGreaterThan(Date.now())
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'error',
      lastError: { kind: refused?.kind, message: refused?.message, since: refused?.since },
    })
    expect(phone.sync.useSyncStore.getState().lastError?.retryAt).toBeUndefined()
    expect(phone.sync.syncsWhenOnline(phone.sync.useSyncStore.getState())).toBe(false)
    expect(await trigger(phone)).toEqual({
      ok: false,
      error: 'permission',
      message: refused?.message,
    })
    expect(willSync(phone)).toEqual([])

    setOnline(true)
    await advance(5000)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('permission')
  })

  it('a retried failure is replaced by offline (no retry runs while offline)', async () => {
    const phone = await connected()
    failNext('pull', { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 })
    expect(await trigger(phone, 20_000)).toMatchObject({ ok: false, error: 'server' })
    setOnline(false)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'offline',
      lastError: { kind: 'offline' },
    })
  })
})

describe('a long failure streak (AC-19)', () => {
  it('keeps the start of the streak and shows one toast after 10 minutes', async () => {
    const phone = await connected()
    const failures: Failure[] = Array.from({ length: 40 }, () => ({ status: 503 }))
    failNext('pull', ...failures)
    const result = await trigger(phone)
    expect(result).toMatchObject({ ok: false, error: 'server' })
    const since = phone.sync.useSyncStore.getState().lastError?.since
    expect(since).toBe(Date.now() - 100)

    await advance(9 * MINUTE)
    expect(phone.sync.useSyncStore.getState().lastError?.since).toBe(since)
    expect(toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing'))).toEqual([])

    await advance(2 * MINUTE)
    const streak = toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing'))
    expect(streak).toHaveLength(1)
    expect(streak[0]?.message).toBe(
      `Sync has been failing since ${phone.sync.clockTime(since ?? 0)}. Your changes are saved on this device.`,
    )
    await advance(10 * MINUTE)
    expect(
      toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing')),
    ).toHaveLength(1)
  })

  it('keeps the start of the streak across an offline blip, and toasts it once', async () => {
    const phone = await connected()
    const started = Date.now()
    // The relay is down: a HEAD ('online' below) fails like a pull.
    failNext('head', ...Array.from({ length: 80 }, (): Failure => ({ status: 503 })))
    failNext('pull', ...Array.from({ length: 80 }, (): Failure => ({ status: 503 })))
    await trigger(phone)
    await advance(10.5 * MINUTE)
    expect(phone.sync.useSyncStore.getState().lastError).toMatchObject({
      kind: 'server',
      since: started,
    })
    const streakToasts = () =>
      toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing'))
    expect(streakToasts()).toHaveLength(1)

    // The phone drops signal for a second: no attempt is made, so nothing is learnt, and the red
    // "failing since" stays true offline: it is kept, not replaced by a promise to sync.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline'))
    await advance(1000)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'error',
      lastError: { kind: 'server', since: started },
    })
    expect(phone.sync.syncsWhenOnline(phone.sync.useSyncStore.getState())).toBe(false)
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))
    await advance(2 * MINUTE)

    // Still failing since the first failure (not "retrying" from the blip), and not toasted again.
    expect(phone.sync.useSyncStore.getState().lastError).toMatchObject({
      kind: 'server',
      since: started,
    })
    expect(phone.sync.isFailing({ kind: 'server', since: started })).toBe(true)
    expect(streakToasts()).toHaveLength(1)
  })

  it('ends the streak at the next cycle that reaches the relay', async () => {
    const phone = await connected()
    failNext('pull', { status: 503 })
    await trigger(phone)
    const first = phone.sync.useSyncStore.getState().lastError?.since
    await advance(5000) // the 2 s retry succeeds
    expect(phone.sync.useSyncStore.getState().lastError).toBeNull()
    await advance(MINUTE)
    failNext('pull', { status: 503 })
    await trigger(phone)
    expect(phone.sync.useSyncStore.getState().lastError?.since).toBeGreaterThan(first ?? 0)
  })

  it("leaves the streak toast to the panel when the owner's own Sync now fails", async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 40 }, (): Failure => ({ status: 503 })))
    await trigger(phone)
    const streakToasts = () =>
      toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing'))
    // Background retries run at 2, 6, 14, 30, 62, 122 … 542 and 602 s: tap Sync now just
    // after 10 minutes, before the 602 s retry. The panel reports that result itself.
    await advance(10 * MINUTE - 100 + 50)
    expect(await trigger(phone)).toMatchObject({ ok: false, error: 'server' })
    expect(streakToasts()).toEqual([])
    await advance(2 * MINUTE) // the next background failure shows it
    expect(streakToasts()).toHaveLength(1)
  })

  it.each([
    ['the Sync panel is open', 'panel'],
    ['the pill is on screen (1280 px and up)', 'pill'],
  ] as const)('shows no streak toast where %s: that says it already', async (_label, where) => {
    const phone = await connected()
    if (where === 'panel') {
      phone.ui.useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    } else {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === phone.sync.SYNC_PILL_MEDIA,
        media: query,
      }))
    }
    failNext('pull', ...Array.from({ length: 40 }, (): Failure => ({ status: 503 })))
    await trigger(phone)
    await advance(12 * MINUTE)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('server')
    expect(toastsOf(phone).filter((t) => t.message.startsWith('Sync has been failing'))).toEqual([])
  })
})

// The pill is desktop-only: on a phone a toast is the only thing on a main screen that says
// sync has stopped. Where the pill or the open Sync panel says it, a toast would say it twice.
describe('a phone hears what needs the owner (no pill below 1280 px)', () => {
  const where = [
    ['the Sync panel is open', 'panel'],
    ['the pill is on screen (1280 px and up)', 'pill'],
  ] as const
  const show = (phone: Device, surface: 'panel' | 'pill') => {
    if (surface === 'panel') {
      phone.ui.useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    } else {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === phone.sync.SYNC_PILL_MEDIA,
        media: query,
      }))
    }
  }
  const refusedToasts = (phone: Device) =>
    toastsOf(phone).filter((t) => t.message === syncMessage('permission'))
  /** A background cycle: a local change pushes 3 s later, with no owner waiting on it. */
  const addInBackground = async (phone: Device) => {
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(4000)
  }

  it('refused access is toasted at once, in red, once per session', async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 40 }, (): Failure => ({ status: 401 })))
    await addInBackground(phone)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('permission')
    expect(refusedToasts(phone)).toEqual([expect.objectContaining({ kind: 'error' })])
    phone.ui.useUIStore.setState({ toasts: [] }) // it timed out
    await advance(5 * MINUTE) // the retries are refused too
    expect(refusedToasts(phone)).toEqual([])
  })

  it.each(where)('refused access is not toasted where %s', async (_label, surface) => {
    const phone = await connected()
    show(phone, surface)
    failNext('pull', ...Array.from({ length: 40 }, (): Failure => ({ status: 401 })))
    await addInBackground(phone)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('permission')
    expect(refusedToasts(phone)).toEqual([])
  })

  it("leaves refused access to the panel's own result when the owner asked", async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 40 }, (): Failure => ({ status: 401 })))
    expect(await trigger(phone)).toMatchObject({ ok: false, error: 'permission' })
    expect(refusedToasts(phone)).toEqual([])
  })

  it('a move to a newer version is toasted once, with a Reload that runs the new build, which it looks for at once', async () => {
    const phone = await connected()
    const { getUpdateController } = await import('../../app/swUpdate')
    const controller = getUpdateController()
    const checkNow = vi.spyOn(controller, 'checkNow')
    const reloadToLatest = vi.spyOn(controller, 'reloadToLatest').mockImplementation(() => {})
    const moved = { version: '4.0', expenses: 'moved', categories: [] }
    writeAsOther(SYNC_CODE, moved) // a background cycle reads the fence
    await advance(5000)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'paused',
      lastError: { kind: 'moved' },
    })
    expect(checkNow).toHaveBeenCalledTimes(1)
    const toasts = toastsOf(phone)
    expect(toasts).toEqual([
      expect.objectContaining({
        kind: 'warning',
        message: syncMessage('moved'),
        action: expect.objectContaining({ label: 'Reload' }) as unknown,
      }),
    ])
    toasts[0]?.action?.onClick()
    expect(reloadToLatest).toHaveBeenCalledTimes(1)

    // More cycles in the same pause: no second look, no second toast.
    phone.ui.useUIStore.setState({ toasts: [] })
    writeAsOther(SYNC_CODE, { ...moved, categories: ['Other'] })
    await advance(5000)
    expect(checkNow).toHaveBeenCalledTimes(1)
    expect(toastsOf(phone)).toEqual([])
  })

  it('leaves a pause to the open Sync panel (its banner says it), and still toasts it only once', async () => {
    const phone = await connected()
    show(phone, 'panel')
    writeAsOther(SYNC_CODE, { version: '4.0', expenses: 'moved', categories: [] })
    await advance(5000)
    expect(phone.sync.useSyncStore.getState().lastError?.kind).toBe('moved')
    expect(toastsOf(phone)).toEqual([])
    phone.ui.useUIStore.setState({ settingsOpen: false })
    writeAsOther(SYNC_CODE, { version: '4.0', expenses: 'moved', categories: ['Other'] })
    await advance(5000)
    expect(toastsOf(phone)).toEqual([])
  })
})

describe('fences fail closed and resume (AC-20)', () => {
  it.each([
    [
      'the moved marker',
      { version: '4.0', expenses: 'moved', categories: [], x5: { min: 99 } },
      'moved',
    ],
    [
      'x5.min above 5 (a newer SpendTrack)',
      { ...payloadOf([expense('e1')]), x5: { schema: 5, min: 6 } },
      'update-required',
    ],
    ['an end-to-end encrypted row', { st: 'v1', ct: 'opaque' }, 'update-required'],
  ])(
    '%s: no push, local data untouched, then sync resumes once the fence is gone',
    async (_label, fence, kind) => {
      const phone = await connected()
      phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
      const local = phone.expense.useExpenseStore.getState().expenses
      seedRow(SYNC_CODE, fence)
      const upserts = relay().upserts

      const result = await trigger(phone)
      expect(result).toMatchObject({ ok: false, error: kind })
      expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('paused')
      expect(relay().upserts).toBe(upserts)
      expect(rowPayload(SYNC_CODE)).toEqual(fence)
      expect(phone.expense.useExpenseStore.getState().expenses).toBe(local)
      await advance(5 * MINUTE)
      expect(relay().upserts).toBe(upserts)

      seedRow(SYNC_CODE, payloadOf([expense('e1')]))
      expect(await trigger(phone)).toMatchObject({ ok: true, pushed: true })
      expect(relayRows()).toHaveLength(2)
    },
  )

  it('a trigger that arrives while a paused cycle is on the wire gets a cycle of its own', async () => {
    // A pause schedules no retry, so resolving the later trigger with the paused result would
    // leave nothing to sync until yet another trigger.
    const phone = await connected()
    seedRow(SYNC_CODE, { version: '4.0', expenses: 'moved', categories: [] })
    relay().latency = { pull: 1000, push: 50, realtime: 20 }
    const first = phone.sync.useSyncStore.getState().triggerSync()
    await advance(400) // the pull is on the wire and will read the fence
    const second = phone.sync.useSyncStore.getState().triggerSync()

    expect(await settle(first, 700)).toMatchObject({ ok: false, error: 'moved' })
    seedRow(SYNC_CODE, payloadOf([expense('e1')])) // the fence is gone
    expect(await settle(second, 2000)).toMatchObject({ ok: true })
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      lastError: null,
    })
  })

  it('a trigger during a failing cycle that retries resolves with that failure (no hammering)', async () => {
    const phone = await connected()
    relay().latency = { pull: 1000, push: 50, realtime: 20 }
    failNext('pull', { status: 503 })
    const first = phone.sync.useSyncStore.getState().triggerSync()
    await advance(400)
    const second = phone.sync.useSyncStore.getState().triggerSync()
    const pulls = relay().pulls
    expect(await settle(first, 700)).toMatchObject({ ok: false, error: 'server' })
    expect(await settle(second, 10)).toMatchObject({ ok: false, error: 'server' })
    expect(relay().pulls).toBe(pulls) // the 2 s backoff retry runs the next one
  })
})

// v5 (intentional change from PR-0): an unreadable relay row is no longer passed through. It is
// quarantined here (Needs attention, downloadable, never deleted) and the relay then carries this
// device's readable doc.
describe('pulls: unreadable rows are quarantined, never merged blind (AC-21, AC-22)', () => {
  const unreadable: unknown[] = [
    { ...expense('b1'), date: 'last tuesday' },
    { ...expense('b2'), date: '18/10/2026' },
    { ...expense('b3'), amount: 'abc' },
    { ...expense('b4'), amount: null },
    { ...expense('b5'), notes: { x: 1 } },
    { ...expense('b6'), category: {} },
    { ...expense('b7'), amount: 0 },
    { ...expense('b8'), amount: -5 },
    { itemName: 'no id', amount: 1, category: 'Other', date: '2026-10-01' },
    null,
  ]
  const idOf = (row: unknown): unknown => (isRecord(row) ? row.id : row)

  it('merges what it can read; the rest is kept for the owner, once, and sync goes quiet', async () => {
    seedRow(SYNC_CODE, payloadOf([...unreadable, expense('g1')], { categories: 5 }))
    const phone = await bootDevice({ expenses: [expense('e1')] })
    expect(await connect(phone)).toMatchObject({ ok: true, pushed: true })

    const store = phone.expense.useExpenseStore
    const live = new Set(store.getState().expenses.map((e) => e.id))
    expect(live.has('e1') && live.has('g1')).toBe(true)
    // A row is either readable after repair (live) or in Needs attention: none is lost.
    const notLive = unreadable.filter((row) => !live.has(String(idOf(row))))
    expect(store.getState().attention.quarantined).toBeGreaterThanOrEqual(notLive.length)
    expect(rowPayload(SYNC_CODE)).toMatchObject({ categories: ['Other', 'Meals'] })
    for (const row of notLive) expect(relayRows().map(idOf)).not.toContain(idOf(row))

    // Pulled again, the same rows are not kept twice (P2-15), and nothing is pushed.
    const attention = store.getState().attention.quarantined
    const upserts = relay().upserts
    await advance(10 * MINUTE)
    expect(await trigger(phone)).toMatchObject({ ok: true, pushed: false })
    expect(store.getState().attention.quarantined).toBe(attention)
    expect(relay().upserts).toBe(upserts)
  })

  // It used to overflow the content key's recursion: every device failed the read ('invalid')
  // and retried forever, so sync stopped for all of them until someone rewrote the row.
  it('a hostile row nested 3,000 levels deep never stops sync', async () => {
    let deep: unknown = 1
    for (let i = 0; i < 3000; i++) deep = { a: deep }
    const hostile = { ...expense('h1'), x: deep }
    seedRow(SYNC_CODE, payloadOf([hostile, expense('g1')]))
    const phone = await bootDevice({ expenses: [expense('e1')] })
    expect(await connect(phone)).toMatchObject({ ok: true, pushed: true })
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(MINUTE)

    const state = phone.sync.useSyncStore.getState()
    expect(state).toMatchObject({ cloudStatus: 'synced', lastError: null, pendingLocal: false })
    const ids = phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['e1', 'g1']))
    expect(JSON.stringify(rowPayload(SYNC_CODE)).length).toBeLessThan(10_000)
    const upserts = relay().upserts
    await advance(10 * MINUTE)
    expect(relay().upserts).toBe(upserts)
  })

  it('keeps a local unreadable row in Needs attention and in storage, and never sends it', async () => {
    const bad = { ...expense('bad'), date: 'last tuesday' }
    const phone = await bootDevice({ persist: true, storedRows: [expense('e1'), bad, null] })
    await connect(phone)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)

    const store = phone.expense.useExpenseStore.getState()
    expect(store.expenses.map((e) => e.id)).not.toContain('bad')
    expect(store.expenses).toHaveLength(2)
    expect(store.attention.quarantined).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(store.quarantineFile())).toContain('last tuesday')
    const relayIds = relayRows().map(idOf)
    expect(relayIds).not.toContain('bad')
    expect(relayIds).not.toContain(null)
    expect(relayIds).toContain('e1')
  })

  it('keeps a local row with no positive amount out of the doc and never sends it', async () => {
    const zero = { ...expense('zero'), amount: 0 }
    const phone = await bootDevice({ persist: true, storedRows: [expense('e1'), zero] })
    await connect(phone)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)

    expect(phone.expense.useExpenseStore.getState().attention.quarantined).toBeGreaterThanOrEqual(1)
    const relayIds = relayRows().map(idOf)
    expect(relayIds).toContain('e1')
    expect(relayIds).not.toContain('zero')
  })
})

describe('the writer stamp and local markers (AC-28)', () => {
  it('stamps every push with x5 (its device, a fresh rev, min 4) on the v4 payload, and no wr', async () => {
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)
    const pushes = relay().pushes
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    const revs = new Set<unknown>()
    let dev: unknown = undefined
    for (const push of pushes) {
      expect(push.payload).toMatchObject({ version: '4.0', x5: { schema: 5, min: 4 } })
      expect(push.payload).not.toHaveProperty('wr')
      const x5 = isRecord(push.payload) && isRecord(push.payload.x5) ? push.payload.x5 : {}
      expect(x5.rev).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(x5.dev).toMatch(/^[0-9a-z]{6}$/)
      dev ??= x5.dev
      expect(x5.dev).toBe(dev)
      revs.add(x5.rev)
    }
    expect(revs.size).toBe(pushes.length)
  })

  it('marks the rollback copy with spendtrack:app = 5', async () => {
    const phone = await bootDevice({ persist: true })
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(3000) // the mirror is written on a 1 s idle debounce
    expect(phone.storage.getItem('spendtrack:app')).toBe('5')
  })
})
