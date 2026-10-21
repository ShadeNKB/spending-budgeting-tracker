import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupData, Expense } from '../types'
import { DEFAULT_CATEGORIES } from '../constants'
import {
  advance,
  failNext,
  relay,
  resetRelay,
  rowPayload,
  seedRow,
  settle,
  stubRelayEnv,
  type FakeChannel,
} from '../__tests__/fakeRelay'
import { contentKey, isSyncableExpense, mergeBackups, readRemote } from './syncService'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../__tests__/fakeRelay')).supabaseModule,
)

const T1 = '2026-10-01T04:00:00.000Z'
const T2 = '2026-10-02T04:00:00.000Z'

const row = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  itemName: `item ${id}`,
  amount: 1,
  category: 'Other',
  date: '2026-10-01T12:00:00',
  createdAt: T1,
  ...over,
})

const doc = (over: Partial<BackupData> = {}): BackupData => ({
  expenses: [],
  categories: ['Other'],
  categoryMappings: {},
  budgets: {},
  budgetUpdatedAt: {},
  budgetDeletedAt: {},
  deletedIds: [],
  exportDate: T1,
  version: '4.0',
  ...over,
})

/** Both merge orders give the same content, and merging the result again changes nothing. */
function expectJoin(a: BackupData, b: BackupData): BackupData {
  const ab = mergeBackups(a, b)
  const ba = mergeBackups(b, a)
  expect(contentKey(ab)).toBe(contentKey(ba))
  expect(contentKey(mergeBackups(ab, ab))).toBe(contentKey(ab))
  expect(contentKey(mergeBackups(ab, a))).toBe(contentKey(ab))
  return ab
}

describe('mergeBackups', () => {
  it('keeps the newer copy of an expense', () => {
    const merged = expectJoin(
      doc({ expenses: [row('e1', { amount: 5, updatedAt: T1 })] }),
      doc({ expenses: [row('e1', { amount: 7, updatedAt: T2 })] }),
    )
    expect(merged.expenses).toEqual([row('e1', { amount: 7, updatedAt: T2 })])
  })

  it('breaks an equal-stamp tie by the larger canonical JSON, in both orders', () => {
    const merged = expectJoin(
      doc({ expenses: [row('e1', { amount: 5, updatedAt: T1 })] }),
      doc({ expenses: [row('e1', { amount: 7, updatedAt: T1 })] }),
    )
    expect(merged.expenses[0]?.amount).toBe(7)
  })

  it('keeps the local object when both copies are identical', () => {
    const local = row('e1', { updatedAt: T1 })
    const merged = mergeBackups(doc({ expenses: [local] }), doc({ expenses: [{ ...local }] }))
    expect(merged.expenses[0]).toBe(local)
  })

  it('orders out-of-window stamps as 0, so a hostile 9999 stamp loses to a real edit', () => {
    const merged = expectJoin(
      doc({ expenses: [row('e1', { amount: 2, updatedAt: T1 })] }),
      doc({ expenses: [row('e1', { amount: 1, updatedAt: '9999-12-31T00:00:00.000Z' })] }),
    )
    expect(merged.expenses[0]?.amount).toBe(2)
  })

  it('resolves a mapping conflict to the larger value, in both orders', () => {
    const merged = expectJoin(
      doc({ categoryMappings: { coffee: 'Drinks', tea: 'Drinks' } }),
      doc({ categoryMappings: { coffee: 'Food & Dining' } }),
    )
    expect(merged.categoryMappings).toEqual({ coffee: 'Food & Dining', tea: 'Drinks' })
  })

  it.each([
    ['equal stamps', { Meals: T1 }, { Meals: T1 }],
    ['both stamps missing', {}, {}],
    [
      'both stamps legacy',
      { Meals: '1970-01-01T00:00:00.000Z' },
      { Meals: '1970-01-01T00:00:00.000Z' },
    ],
  ])('resolves a budget tie (%s) to the larger value', (_label, aStamps, bStamps) => {
    const merged = expectJoin(
      doc({ budgets: { Meals: 200 }, budgetUpdatedAt: aStamps }),
      doc({ budgets: { Meals: 300 }, budgetUpdatedAt: bStamps }),
    )
    expect(merged.budgets).toEqual({ Meals: 300 })
  })

  it('writes the legacy stamp for a winning budget set whose stamp is unknown', () => {
    const merged = expectJoin(doc({ budgets: { Meals: 200 } }), doc())
    expect(merged.budgets).toEqual({ Meals: 200 })
    expect(merged.budgetUpdatedAt).toEqual({ Meals: '1970-01-01T00:00:00.000Z' })
  })

  it('lets a stamped budget beat an unstamped one, without an exportDate fallback', () => {
    const merged = expectJoin(
      doc({ budgets: { Meals: 999 }, exportDate: '2026-12-31T00:00:00.000Z' }),
      doc({ budgets: { Meals: 100 }, budgetUpdatedAt: { Meals: T1 } }),
    )
    expect(merged.budgets).toEqual({ Meals: 100 })
    expect(merged.budgetUpdatedAt).toEqual({ Meals: T1 })
  })

  it('lets a budget delete win a tie with a set, and keeps the larger delete stamp string', () => {
    const merged = expectJoin(
      doc({ budgets: { Meals: 200 }, budgetUpdatedAt: { Meals: T1 } }),
      doc({ budgetDeletedAt: { Meals: '2026-10-01T04:00:00Z' } }),
    )
    expect(merged.budgets).toEqual({})
    expect(merged.budgetDeletedAt).toEqual({ Meals: '2026-10-01T04:00:00Z' })

    const deletes = expectJoin(
      doc({ budgetDeletedAt: { Meals: '2026-10-01T04:00:00Z' } }),
      doc({ budgetDeletedAt: { Meals: T1 } }),
    )
    expect(deletes.budgetDeletedAt).toEqual({ Meals: '2026-10-01T04:00:00Z' })
  })

  it('never lets a delete with an unknown stamp remove a budget, in both orders', () => {
    const merged = expectJoin(
      doc({ budgets: { Meals: 100 } }),
      doc({ budgetDeletedAt: { Meals: 'not a date' } }),
    )
    expect(merged.budgets).toEqual({ Meals: 100 })
    expect(merged.budgetDeletedAt).toEqual({})
  })

  it('keeps a newer budget set over an older delete', () => {
    const merged = expectJoin(
      doc({ budgets: { Meals: 250 }, budgetUpdatedAt: { Meals: T2 } }),
      doc({ budgetDeletedAt: { Meals: T1 } }),
    )
    expect(merged.budgets).toEqual({ Meals: 250 })
    expect(merged.budgetDeletedAt).toEqual({})
  })

  it('applies tombstones from either side and unions them in insertion order', () => {
    const merged = expectJoin(
      doc({ expenses: [row('e1'), row('e2')], deletedIds: ['x'] }),
      doc({ expenses: [row('e1')], deletedIds: ['e1', 'y'] }),
    )
    expect(merged.expenses.map((e) => e.id)).toEqual(['e2'])
    expect(
      mergeBackups(doc({ deletedIds: ['x'] }), doc({ deletedIds: ['e1', 'y'] })).deletedIds,
    ).toEqual(['x', 'e1', 'y'])
  })

  it('unions categories with local order first and falls back to the defaults', () => {
    expect(
      mergeBackups(doc({ categories: ['B', 'A'] }), doc({ categories: ['A', 'C'] })).categories,
    ).toEqual(['B', 'A', 'C'])
    expect(mergeBackups(doc({ categories: [] }), doc({ categories: [] })).categories).toEqual(
      DEFAULT_CATEGORIES,
    )
  })

  it('keeps up to 20,000 tombstones, newest last', () => {
    const local = Array.from({ length: 15_000 }, (_, i) => `l${i}`)
    const remote = Array.from({ length: 10_000 }, (_, i) => `r${i}`)
    const merged = mergeBackups(doc({ deletedIds: local }), doc({ deletedIds: remote }))
    expect(merged.deletedIds).toHaveLength(20_000)
    expect(merged.deletedIds?.[0]).toBe('l5000')
    expect(merged.deletedIds?.at(-1)).toBe('r9999')
  })

  it('leaves 1,500 tombstones untouched (F-013: the 1,000 cap resurrected deletions)', () => {
    const ids = Array.from({ length: 1_500 }, (_, i) => `d${i}`)
    const resurrected = ids.map((id) => row(id))
    const merged = mergeBackups(doc({ deletedIds: ids }), doc({ expenses: resurrected }))
    expect(merged.deletedIds).toEqual(ids)
    expect(merged.expenses).toEqual([])
  })

  it('never sets a prototype from __proto__ or constructor keys in a pulled payload', () => {
    const raw: unknown = JSON.parse(
      '{"expenses":[],"categories":["Other"],"categoryMappings":{"__proto__":{"polluted":"yes"},"constructor":"Other","coffee":"Food"},' +
        '"budgets":{"__proto__":{"polluted":1},"constructor":50},"budgetUpdatedAt":{"constructor":"2026-10-01T04:00:00.000Z"},"deletedIds":[]}',
    )
    const read = readRemote(raw)
    if (read.kind !== 'ok') throw new Error(`expected ok, got ${read.kind}`)
    const local = doc({
      categoryMappings: Object.fromEntries([['__proto__', 'Other']]),
      budgets: Object.fromEntries([['__proto__', 70]]),
      budgetUpdatedAt: Object.fromEntries([['__proto__', T1]]),
    })
    const merged = mergeBackups(local, read.data)
    expect(Object.getPrototypeOf(merged.categoryMappings)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(merged.budgets)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(merged.budgetUpdatedAt)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(merged.categoryMappings, '__proto__')).toBe(true)
    expect(merged.categoryMappings.constructor).toBe('Other')
    expect(merged.budgets?.constructor).toBe(50)
    expect(contentKey(mergeBackups(merged, merged))).toBe(contentKey(merged))
  })
})

describe('isSyncableExpense', () => {
  it('accepts a full row and the lenient optional fields', () => {
    expect(isSyncableExpense(row('e1'))).toBe(true)
    expect(isSyncableExpense({ ...row('e1'), notes: null })).toBe(true)
    expect(
      isSyncableExpense({
        id: 'e1',
        itemName: 'x',
        amount: 1,
        category: 'Other',
        date: '2026-10-01',
      }),
    ).toBe(true)
    expect(
      isSyncableExpense({ ...row('e1'), day: '2026-10-01', fs: [1], h: 'x', kind: 'v5' }),
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['an array', [row('e1')]],
    ['a missing id', { ...row('e1'), id: undefined }],
    ['an empty id', { ...row('e1'), id: '' }],
    ['a numeric id', { ...row('e1'), id: 7 }],
    ['itemName missing', { ...row('e1'), itemName: undefined }],
    ["amount 'abc'", { ...row('e1'), amount: 'abc' }],
    ['amount null', { ...row('e1'), amount: null }],
    ["date 'last tuesday'", { ...row('e1'), date: 'last tuesday' }],
    ["date '18/10/2026'", { ...row('e1'), date: '18/10/2026' }],
    ['category {}', { ...row('e1'), category: {} }],
    ['notes {x:1}', { ...row('e1'), notes: { x: 1 } }],
    ['createdAt 5', { ...row('e1'), createdAt: 5 }],
    ['updatedAt {}', { ...row('e1'), updatedAt: {} }],
  ])('rejects a row with %s', (_label, value) => {
    expect(isSyncableExpense(value)).toBe(false)
  })
})

describe('contentKey', () => {
  const base = doc({
    expenses: [row('e1'), row('e2', { amount: 2 })],
    categories: ['Other', 'Meals'],
    categoryMappings: { kopi: 'Meals' },
    budgets: { Meals: 300 },
    budgetUpdatedAt: { Meals: T1 },
    deletedIds: ['x', 'y'],
  })

  it('ignores exportDate, version, wr, x5, key order and collection order', () => {
    const shuffled = {
      wr: { app: '0.8.5', dev: 'abc123', rev: 'r', at: T2 },
      x5: { schema: 5, min: 4 },
      version: '5.0',
      exportDate: T2,
      deletedIds: ['y', 'x', 'y'],
      categories: ['Meals', 'Other', 'Meals'],
      expenses: [{ ...row('e2', { amount: 2 }) }, { ...row('e1') }].map((e) =>
        Object.fromEntries(Object.entries(e).reverse()),
      ),
      categoryMappings: { kopi: 'Meals' },
      budgetUpdatedAt: { Meals: T1 },
      budgets: { Meals: 300 },
    }
    expect(contentKey(shuffled)).toBe(contentKey(base))
  })

  it('treats a missing budgetDeletedAt as empty', () => {
    const { budgetDeletedAt: _drop, ...rest } = base
    expect(contentKey(rest)).toBe(contentKey(base))
  })

  it('changes when any synced field changes', () => {
    expect(
      contentKey({ ...base, expenses: [row('e1', { amount: 9 }), row('e2', { amount: 2 })] }),
    ).not.toBe(contentKey(base))
    expect(contentKey({ ...base, categoryMappings: {} })).not.toBe(contentKey(base))
    expect(contentKey({ ...base, deletedIds: ['x'] })).not.toBe(contentKey(base))
    expect(contentKey({ ...base, budgets: { Meals: 301 } })).not.toBe(contentKey(base))
  })

  it('canonicalises non-array collections raw, so garbage never equals a clean payload', () => {
    expect(contentKey({ ...base, categories: 5 })).not.toBe(contentKey({ ...base, categories: [] }))
    expect(contentKey({ ...base, expenses: null })).not.toBe(contentKey({ ...base, expenses: [] }))
  })
})

describe('readRemote', () => {
  it('reads no row as empty', () => {
    expect(readRemote(null)).toEqual({ kind: 'empty' })
    expect(readRemote(undefined)).toEqual({ kind: 'empty' })
  })

  it('fails closed on the moved marker and on x5.min above 4', () => {
    expect(readRemote({ version: '4.0', expenses: 'moved', x5: { min: 99 } })).toEqual({
      kind: 'moved',
    })
    expect(readRemote({ expenses: [], x5: { schema: 5, min: 5 } })).toEqual({
      kind: 'update-required',
    })
    expect(readRemote({ expenses: [], x5: { schema: 5, min: 4 } })).toMatchObject({
      kind: 'ok',
      writer: 'v5',
    })
  })

  it.each([
    ['a string', 'garbage'],
    ['a number', 5],
    ['a top-level array', [row('e1')]],
    ['expenses: null', { expenses: null, categories: [] }],
    ['no expenses', { categories: ['Other'] }],
  ])('reads %s as invalid', (_label, raw) => {
    expect(readRemote(raw)).toMatchObject({ kind: 'invalid' })
  })

  it('classifies the writer from x5 and wr', () => {
    expect(readRemote(doc())).toMatchObject({ kind: 'ok', writer: 'legacy' })
    expect(
      readRemote({ ...doc(), wr: { app: '0.8.5', dev: 'a', rev: 'b', at: T1 } }),
    ).toMatchObject({
      writer: 'v085',
    })
    expect(readRemote({ ...doc(), wr: 'x', x5: { schema: 5, min: 4 } })).toMatchObject({
      writer: 'v5',
    })
  })

  it('merges readable rows only and passes every unreadable row through untouched', () => {
    const bad: unknown[] = [
      { ...row('b1'), date: 'last tuesday' },
      { ...row('b2'), date: '18/10/2026' },
      { ...row('b3'), amount: 'abc' },
      { ...row('b4'), amount: null },
      { ...row('b5'), notes: { x: 1 } },
      { ...row('b6'), category: {} },
      { itemName: 'no id', amount: 1, category: 'Other', date: '2026-10-01' },
      null,
    ]
    const good = { ...row('g1'), day: '2026-10-01', fs: [1, 2], h: 'abc', kind: 'future' }
    const raw = { ...doc(), expenses: [bad[0], good, ...bad.slice(1)], categories: 5 }
    const read = readRemote(raw)
    if (read.kind !== 'ok') throw new Error(`expected ok, got ${read.kind}`)
    expect(read.data.expenses).toEqual([good])
    expect(read.passthrough).toEqual(bad)
    expect(read.data.categories).toEqual([])
    expect(read.key).toBe(contentKey(raw))
  })
})

// ---------------------------------------------------------------------------
// Transport: postgrest error classes, the 15 s deadline, lazy SDK import.
// ---------------------------------------------------------------------------

async function loadService() {
  vi.resetModules()
  return import('./syncService')
}

describe('pullSync / pushSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubRelayEnv()
    resetRelay()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  const payload = {
    ...doc({ expenses: [row('e1')] }),
    wr: { app: '0.8.5', dev: 'abc123', rev: 'r1', at: T1 },
  }

  it('pulls the payload, or null when there is no row', async () => {
    const svc = await loadService()
    expect(await settle(svc.pullSync('code'))).toBeNull()
    seedRow('code', payload)
    expect(await settle(svc.pullSync('code'))).toEqual(payload)
  })

  it('upserts the payload and returns the updated_at it sent', async () => {
    vi.setSystemTime(new Date(T2))
    const svc = await loadService()
    const result = await settle(svc.pushSync('code', payload))
    expect(result).toEqual({ updatedAt: T2 })
    expect(rowPayload('code')).toEqual(payload)
  })

  it.each([
    ['network', { status: 0 }],
    ['server', { status: 503, message: 'Service Unavailable' }],
    ['permission', { status: 401, message: 'Unauthorized' }],
    ['permission', { status: 403, message: 'Forbidden' }],
    [
      'permission',
      { status: 400, code: '42501', message: 'permission denied for table sync_buckets' },
    ],
  ] as const)('classifies a %s failure (%j)', async (kind, failure) => {
    const svc = await loadService()
    failNext('pull', failure)
    failNext('push', failure)
    await expect(settle(svc.pullSync('code'))).rejects.toMatchObject({
      name: 'SyncTransportError',
      kind,
    })
    await expect(settle(svc.pushSync('code', payload))).rejects.toMatchObject({
      name: 'SyncTransportError',
      kind,
    })
  })

  it('settles a request that never answers as a network failure after 15 s', async () => {
    const svc = await loadService()
    failNext('pull', { hang: true })
    const pending = svc.pullSync('code')
    const outcome = expect(pending).rejects.toMatchObject({ kind: 'network' })
    await advance(14_999)
    await advance(1)
    await outcome
    seedRow('code', payload)
    expect(await settle(svc.pullSync('code'))).toEqual(payload)
  })

  it('aborts the request through its signal at the deadline', async () => {
    const svc = await loadService()
    failNext('push', { abortable: true })
    const pending = svc.pushSync('code', payload)
    const outcome = expect(pending).rejects.toMatchObject({ kind: 'network' })
    await advance(15_000)
    await outcome
  })

  it('refuses a payload over 1 MB before any request', async () => {
    const svc = await loadService()
    const big = { ...payload, categories: ['x'.repeat(1024 * 1024)] }
    await expect(svc.pushSync('code', big)).rejects.toBeInstanceOf(svc.PayloadTooLargeError)
    expect(relay().upserts).toBe(0)
  })

  it('reports a failed SDK import as a network failure and retries the import next time', async () => {
    const svc = await loadService()
    relay().importFailures = 1
    await expect(settle(svc.pullSync('code'))).rejects.toMatchObject({ kind: 'network' })
    expect(await settle(svc.pullSync('code'))).toBeNull()
  })

  it('fails an SDK download that never finishes as network after 15 s, then loads it again', async () => {
    const svc = await loadService()
    relay().importStalls = 1
    const pending = svc.pullSync('code')
    const outcome = expect(pending).rejects.toMatchObject({ kind: 'network' })
    await advance(15_000)
    await outcome
    expect(relay().pulls).toBe(0)
    seedRow('code', payload)
    expect(await settle(svc.pullSync('code'))).toEqual(payload)
  })

  it.each([
    ['a network failure', { status: 0 }],
    ['a 503', { status: 503, message: 'Service Unavailable' }],
  ] as const)(
    'sends one request for a pull that meets %s: the engine backoff is the only retry',
    async (_label, failure) => {
      const svc = await loadService()
      failNext('pull', failure, failure, failure, failure)
      const outcome = expect(svc.pullSync('code')).rejects.toMatchObject({
        name: 'SyncTransportError',
      })
      await advance(10_000)
      await outcome
      expect(relay().pulls).toBe(1)
    },
  )
})

// ---------------------------------------------------------------------------
// Realtime subscription
// ---------------------------------------------------------------------------

const RECONNECT_DELAY = 2000

function channelAt(index: number): FakeChannel {
  const channel = relay().created[index]
  if (!channel) throw new Error(`no channel #${index}`)
  return channel
}

describe('subscribeSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubRelayEnv()
    resetRelay()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  async function subscribe(handlers = { onRemoteChange: vi.fn(), onSubscribed: vi.fn() }) {
    const svc = await loadService()
    const unsubscribe = await svc.subscribeSync('sync-code', handlers)
    return { svc, unsubscribe, handlers }
  }

  it.each([
    ['on a later microtask', false],
    ['synchronously', true],
  ])(
    're-arms exactly once per drop when the old channel reports CLOSED %s',
    async (_label, closeSync) => {
      relay().closeSync = closeSync
      const { unsubscribe } = await subscribe()
      const first = channelAt(0)
      first.emit('SUBSCRIBED')
      first.emit('CHANNEL_ERROR')

      for (let i = 0; i < 10; i++) await advance(RECONNECT_DELAY)

      expect(relay().created).toHaveLength(2)
      expect(relay().removed).toEqual([first])

      unsubscribe()
      await advance(5 * RECONNECT_DELAY)
      expect(relay().created).toHaveLength(2)
      expect(relay().removed).toEqual([first, channelAt(1)])
    },
  )

  it('still reconnects when the replacement channel drops later', async () => {
    const { unsubscribe } = await subscribe()
    channelAt(0).emit('TIMED_OUT')
    await advance(RECONNECT_DELAY)
    expect(relay().created).toHaveLength(2)

    channelAt(1).emit('CLOSED')
    await advance(RECONNECT_DELAY)
    expect(relay().created).toHaveLength(3)

    unsubscribe()
  })

  it('cancels a pending reconnect on unsubscribe', async () => {
    const { unsubscribe } = await subscribe()
    channelAt(0).emit('CHANNEL_ERROR')
    unsubscribe()

    await advance(5 * RECONNECT_DELAY)
    expect(relay().created).toHaveLength(1)
    expect(relay().removed).toEqual([channelAt(0)])
  })

  it('reports every SUBSCRIBED, including after a reconnect', async () => {
    const { handlers, unsubscribe } = await subscribe()
    await advance(10)
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(1)
    channelAt(0).emit('CHANNEL_ERROR')
    await advance(RECONNECT_DELAY + 10)
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('passes the changed payload and updated_at to the handler', async () => {
    const { svc, handlers, unsubscribe } = await subscribe()
    await advance(10)
    const body = { ...doc(), wr: { app: '0.8.5', dev: 'abc123', rev: 'r1', at: T1 } }
    vi.setSystemTime(new Date(T2))
    await settle(svc.pushSync('sync-code', body), 10)
    expect(handlers.onRemoteChange).toHaveBeenCalledWith({ payload: body, updatedAt: T2 })

    relay().omitPayload = true
    vi.setSystemTime(new Date(T2))
    await settle(svc.pushSync('sync-code', body), 10)
    expect(handlers.onRemoteChange).toHaveBeenLastCalledWith({ payload: undefined, updatedAt: T2 })
    unsubscribe()
  })
})
