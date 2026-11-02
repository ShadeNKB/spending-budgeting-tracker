// The sync transport: pull, upsert and realtime against the fake relay. What a payload means
// is the engine's business (the store suites); here a payload is an opaque JSON value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../__tests__/fakeRelay')).supabaseModule,
)

// The first request of a fresh module graph imports the SDK (slow in a busy worker).
vi.setConfig({ testTimeout: 20_000 })

const T1 = '2026-10-01T04:00:00.000Z'
const T2 = '2026-10-02T04:00:00.000Z'

/** An invented relay payload (any JSON object: the transport never reads it). */
const doc = (): Record<string, unknown> => ({
  version: '4.0',
  exportDate: T1,
  expenses: [
    { id: 'e1', itemName: 'item e1', amount: 1, category: 'Other', date: '2026-10-01T12:00:00' },
  ],
  categories: ['Other'],
  categoryMappings: {},
  budgets: {},
  budgetUpdatedAt: {},
  budgetDeletedAt: {},
  deletedIds: [],
  x5: { schema: 5, minor: 0, min: 4, rev: 'r1', dig: 'abc' },
})

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

  const payload = doc()

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
    const body = doc()
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
