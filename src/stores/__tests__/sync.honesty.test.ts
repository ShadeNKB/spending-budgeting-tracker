// F-016 honest results, F-005 lenient pulls with fences, and the writer stamp on the wire
// (AC-17 to AC-22, AC-28). Every failure resolves a SyncResult; nothing throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { isRecord } from '../../lib/backup'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  settle,
  stubRelayEnv,
  writeAsOther,
  type Device,
  type Failure,
} from '../../__tests__/fakeRelay'

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
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
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
    await advance(2000) // the first backoff retry loads the SDK again
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      pendingLocal: false,
    })
    expect(relayRows()).toHaveLength(1)
  })

  it.each([
    ['a non-object', 'garbage'],
    ['a top-level array', [expense('e1')]],
    ['expenses: null', { expenses: null, categories: [] }],
  ])('an unreadable relay copy (%s) is invalid: no merge, no push', async (_label, raw) => {
    const phone = await connected()
    const before = phone.expense.useExpenseStore.getState().expenses
    seedRow(SYNC_CODE, raw)
    const upserts = relay().upserts
    const result = await trigger(phone)
    expect(result).toMatchObject({ ok: false, error: 'invalid' })
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('error')
    expect(phone.expense.useExpenseStore.getState().expenses).toBe(before)
    expect(relay().upserts).toBe(upserts)
  })

  it('setupSync resolves the same honest result', async () => {
    const phone = await bootDevice()
    failNext('pull', { status: 503 })
    const result = await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE))
    expect(result).toMatchObject({ ok: false, error: 'server' })
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
    expect(relay().pulls).toBe(pulls) // no retry storm
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
})

describe('fences fail closed and resume (AC-20)', () => {
  it.each([
    [
      'the moved marker',
      { version: '4.0', expenses: 'moved', categories: [], x5: { min: 99 } },
      'moved',
    ],
    [
      'x5.min above 4',
      { ...payloadOf([expense('e1')]), x5: { schema: 5, min: 5 } },
      'update-required',
    ],
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
})

describe('lenient pulls: unreadable rows are never merged and never deleted (AC-21, AC-22)', () => {
  const unreadable: unknown[] = [
    { ...expense('b1'), date: 'last tuesday' },
    { ...expense('b2'), date: '18/10/2026' },
    { ...expense('b3'), amount: 'abc' },
    { ...expense('b4'), amount: null },
    { ...expense('b5'), notes: { x: 1 } },
    { ...expense('b6'), category: {} },
    { itemName: 'no id', amount: 1, category: 'Other', date: '2026-10-01' },
    null,
  ]

  it('merges the readable rows only and puts every unreadable row back on the relay', async () => {
    seedRow(SYNC_CODE, payloadOf([...unreadable, expense('g1')], { categories: 5 }))
    const phone = await bootDevice({ expenses: [expense('e1')] })
    const result = await connect(phone)
    expect(result).toMatchObject({ ok: true, pushed: true })

    const local = phone.expense.useExpenseStore.getState().expenses
    expect(local.map((e) => e.id).sort()).toEqual(['e1', 'g1'])
    const rows = relayRows()
    for (const row of unreadable) expect(rows).toContainEqual(row)
    expect(rows).toHaveLength(unreadable.length + 2)
    expect(rowPayload(SYNC_CODE)).toMatchObject({ categories: ['Other', 'Meals'] })
  })

  it('keeps a local unreadable row in the store and in storage, and never sends it', async () => {
    const bad = { ...expense('bad'), date: 'last tuesday' }
    // Hydrate no longer runs the category migration, so a corrupt row reaches the store.
    const phone = await bootDevice({ persist: true, storedRows: [expense('e1'), bad, null] })
    await connect(phone)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)

    const stored: readonly unknown[] = phone.expense.useExpenseStore.getState().expenses
    expect(stored).toHaveLength(4)
    expect(stored).toContainEqual(bad)
    expect(stored).toContain(null)
    expect(localStorage.getItem('expenses')).toContain('last tuesday')
    const relayIds = relayRows().map((r) =>
      typeof r === 'object' && r !== null && 'id' in r ? r.id : r,
    )
    expect(relayIds).not.toContain('bad')
    expect(relayIds).not.toContain(null)
    expect(relayIds).toContain('e1')
  })

  it('drops a local unreadable row once the relay has deleted its id', async () => {
    const bad = { ...expense('bad'), date: 'last tuesday' }
    seedRow(SYNC_CODE, payloadOf([expense('e1')], { deletedIds: ['bad'] }))
    const phone = await bootDevice({ persist: true, storedRows: [expense('e1'), bad] })
    await connect(phone)

    const stored: readonly unknown[] = phone.expense.useExpenseStore.getState().expenses
    expect(stored).not.toContainEqual(bad)
    expect(stored).toHaveLength(1)
    expect(rowPayload(SYNC_CODE)).toMatchObject({ deletedIds: ['bad'] })
  })
})

describe('the writer stamp and local markers (AC-28)', () => {
  it('stamps every push with wr and keeps version 4.0 and no x5', async () => {
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)
    const pushes = relay().pushes
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    const dev = localStorage.getItem('spendtrack:dev')
    expect(dev).toMatch(/^[0-9a-z]{6}$/)
    const revs = new Set<unknown>()
    for (const push of pushes) {
      expect(push.payload).toMatchObject({ version: '4.0', wr: { app: '0.8.5', dev } })
      expect(push.payload).not.toHaveProperty('x5')
      const wr = isRecord(push.payload) && isRecord(push.payload.wr) ? push.payload.wr : {}
      expect(wr.rev).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(new Date(String(wr.at)).toISOString()).toBe(wr.at)
      revs.add(wr.rev)
    }
    expect(revs.size).toBe(pushes.length)
  })

  it('marks every save with spendtrack:app', async () => {
    const phone = await bootDevice({ persist: true })
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(1000)
    expect(localStorage.getItem('spendtrack:app')).toBe('0.8.5')
  })
})
