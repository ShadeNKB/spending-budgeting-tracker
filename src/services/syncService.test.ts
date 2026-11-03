// The sync transport (PR-3 track spec §3.2, §3.3, AC-T1 to AC-T6): table mode with and without
// compare-and-set, the relay's sync functions (migration 004) and their detection, the etag,
// error classes, keepalive, and realtime on the hashed topic (Broadcast + postgres_changes).
// What a payload means is the engine's business (the store suites); here it is opaque JSON.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainTopic } from '../data/core/e2e'
import {
  advance,
  failNext,
  relay,
  requestsOf,
  resetRelay,
  rowPayload,
  rowStamp,
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

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const ROW = '11111111-1111-4111-8111-111111111111'
const DAY = 86_400_000

/** An invented relay payload (any JSON object: the transport never reads it). */
const doc = (rev = 'r1'): Record<string, unknown> => ({
  version: '4.0',
  exportDate: '2026-10-01T04:00:00.000Z',
  expenses: [
    { id: 'e1', itemName: 'item e1', amount: 1, category: 'Other', date: '2026-10-01T12:00:00' },
  ],
  categories: ['Other'],
  deletedIds: [],
  x5: { schema: 5, minor: 0, min: 4, rev, dig: 'abc' },
})

type Service = typeof import('./syncService')

async function loadService(env: Record<string, string> = {}): Promise<Service> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return import('./syncService')
}

/** The transport for this run, opened the way the engine opens it (no hint yet). */
async function transportOf(svc: Service, row = ROW) {
  const opened = await settle(
    svc.openTransport(row, { mode: null, probedAt: 0 }, Date.now(), false),
  )
  return opened.transport
}

const noReturn = { base: null, force: false, keepalive: false }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// The etag and the write token (AC-T3, P3-3)
// ---------------------------------------------------------------------------

/** Microseconds of an ISO stamp (an independent reading for the assertions). */
function us(text: string): bigint {
  const m = /^(.*?)(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(text)
  if (m === null) throw new Error(`not a stamp: ${text}`)
  const whole = Date.parse(`${m[1] ?? ''}${m[3] ?? 'Z'}`)
  return BigInt(whole) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0'))
}

describe('tok and sameEtag', () => {
  it('AC-T3: tok(base) is strictly later than base at microsecond precision, 6 digits, Z', async () => {
    const { tok } = await loadService()
    const bases = [
      null,
      '2026-11-02T04:00:00+00:00',
      '2026-11-02T04:00:00.1+00:00',
      '2026-11-02T04:00:00.999999+00:00',
      '2026-11-02T12:00:00.5+08:00', // 04:00:00.5 UTC
      '2026-11-02T04:00:00.000999Z',
      '2026-11-02T04:00:00', // no zone = UTC
      '2099-01-01T00:00:00.123456+00:00', // a skewed device wrote far ahead
    ]
    for (const base of bases) {
      for (const r of [0, 0.5, 0.999_999]) {
        const t = tok(base, NOW, () => r)
        expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        if (base !== null) expect(us(t) > us(base)).toBe(true)
        expect(us(t) >= BigInt(NOW) * 1000n).toBe(true)
      }
    }
    expect(tok('2099-01-01T00:00:00.123456+00:00', NOW, () => 0)).toBe(
      '2099-01-01T00:00:00.123457Z',
    )
    expect(tok(null, NOW, () => 0.5)).toBe('2026-11-02T04:00:00.000500Z')
  })

  it('compares the instant, whatever the zone or the trailing zeros', async () => {
    const { sameEtag } = await loadService()
    expect(sameEtag('2026-11-02T04:00:00.1234+00:00', '2026-11-02T04:00:00.123400Z')).toBe(true)
    expect(sameEtag('2026-11-02T12:00:00.5+08:00', '2026-11-02T04:00:00.500000Z')).toBe(true)
    expect(sameEtag('2026-11-02T04:00:00', '2026-11-02T04:00:00+00:00')).toBe(true)
    expect(sameEtag('2026-11-02T04:00:00.000001Z', '2026-11-02T04:00:00Z')).toBe(false)
    expect(sameEtag('not-a-stamp', 'not-a-stamp')).toBe(true)
    expect(sameEtag('not-a-stamp', 'not-a-stamp!')).toBe(false)
    expect(sameEtag(null, '2026-11-02T04:00:00Z')).toBe(false)
    expect(sameEtag(null, null)).toBe(false)
    expect(sameEtag(undefined, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Table mode (AC-T1, AC-T2)
// ---------------------------------------------------------------------------

describe('table mode without flags (AC-T1)', () => {
  it('pushes one upsert with updated_at = tok() and select=updated_at; the stored string is the etag', async () => {
    const svc = await loadService()
    expect(svc.CAS_ON).toBe(false)
    expect(svc.RELAY_PIN).toBe('table')
    const t = await transportOf(svc)
    expect(t.mode).toBe('table')
    const res = await settle(t.push(ROW, doc(), noReturn))
    expect(res).toEqual({ ok: true, etag: rowStamp(ROW) })
    const [upsert] = requestsOf('upsert')
    expect(upsert?.returning).toBe('updated_at')
    expect(upsert?.body?.updated_at).toMatch(/\.\d{6}Z$/)
    expect(rowPayload(ROW)).toEqual(doc())
    // a base changes nothing about the write: still one plain upsert, never conditional
    const again = await settle(t.push(ROW, doc('r2'), { ...noReturn, base: 'stale' }))
    expect(again.ok).toBe(true)
    expect(relay().upserts).toBe(2)
    expect(
      relay().requests.every((r) => r.filters.every((f) => !f.startsWith('updated_at='))),
    ).toBe(true)
    expect(relay().rpcs).toBe(0)
  })

  it('pulls the payload with its etag, heads the etag alone, and answers null for no row', async () => {
    const svc = await loadService()
    const t = await transportOf(svc)
    expect(await settle(t.head(ROW))).toBeNull()
    expect(await settle(t.pull(ROW))).toBeNull()
    seedRow(ROW, doc())
    const etag = rowStamp(ROW)
    expect(etag).toMatch(/\+00:00$/)
    expect(await settle(t.head(ROW))).toBe(etag)
    expect(await settle(t.pull(ROW))).toEqual({ payload: doc(), etag })
    expect({ heads: relay().heads, pulls: relay().pulls }).toEqual({ heads: 2, pulls: 2 })
  })
})

describe('table mode with VITE_SYNC_CAS=on (AC-T2)', () => {
  const cas = { VITE_SYNC_CAS: 'on' }

  it('writes an existing row by PATCH on sync_id and the pulled updated_at verbatim', async () => {
    const svc = await loadService(cas)
    expect(svc.CAS_ON).toBe(true)
    const t = await transportOf(svc)
    seedRow(ROW, doc())
    const pulled = await settle(t.pull(ROW))
    const base = pulled?.etag ?? ''
    expect(base).toContain('+00:00')
    const res = await settle(t.push(ROW, doc('r2'), { ...noReturn, base }))
    expect(res).toEqual({ ok: true, etag: rowStamp(ROW) })
    const [update] = requestsOf('update')
    expect(update?.filters).toEqual([`sync_id=eq.${ROW}`, `updated_at=eq.${base}`])
    expect(update?.returning).toBe('updated_at')
    expect(relay().upserts).toBe(0)
  })

  it('reports a conflict (and writes nothing) when the row moved since the pull', async () => {
    const svc = await loadService(cas)
    const t = await transportOf(svc)
    seedRow(ROW, doc())
    const base = (await settle(t.pull(ROW)))?.etag ?? ''
    seedRow(ROW, doc('other'))
    expect(await settle(t.push(ROW, doc('r2'), { ...noReturn, base }))).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(rowPayload(ROW)).toEqual(doc('other'))
  })

  it('creates a missing row by INSERT; an existing one (23505) is a conflict, never an error', async () => {
    const svc = await loadService(cas)
    const t = await transportOf(svc)
    expect(await settle(t.push(ROW, doc(), noReturn))).toEqual({ ok: true, etag: rowStamp(ROW) })
    expect(requestsOf('insert')).toHaveLength(1)
    expect(await settle(t.push(ROW, doc('r2'), noReturn))).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(rowPayload(ROW)).toEqual(doc())
  })

  it('forces over an existing row, and a forced write never creates one', async () => {
    const svc = await loadService(cas)
    const t = await transportOf(svc)
    expect(await settle(t.push(ROW, doc(), { ...noReturn, base: 'x', force: true }))).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(relay().rows.has(ROW)).toBe(false)
    seedRow(ROW, doc())
    const res = await settle(t.push(ROW, doc('r2'), { ...noReturn, base: 'stale', force: true }))
    expect(res).toEqual({ ok: true, etag: rowStamp(ROW) })
    expect(requestsOf('update').at(-1)?.filters).toEqual([`sync_id=eq.${ROW}`])
  })
})

// ---------------------------------------------------------------------------
// The relay's sync functions and their detection (AC-T4, AC-T5)
// ---------------------------------------------------------------------------

describe('detection (AC-T4)', () => {
  it("never probes with the default pin 'table', even when the functions exist", async () => {
    relay().rpc = 'present'
    const svc = await loadService()
    const opened = await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, true))
    expect(opened.transport.mode).toBe('table')
    expect(relay().rpcs).toBe(0)
  })

  it("pin 'rpc' uses the functions only, without a probe", async () => {
    relay().rpc = 'present'
    const svc = await loadService({ VITE_SYNC_RELAY: 'rpc' })
    const opened = await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    expect(opened.transport.mode).toBe('rpc')
    expect(relay().rpcs).toBe(0)
  })

  it("pin 'auto' probes st_sync_head once: functions there → rpc, PGRST202 → table", async () => {
    const svc = await loadService({ VITE_SYNC_RELAY: 'auto' })
    expect(svc.RELAY_PIN).toBe('auto')
    const none = await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    expect(none.transport.mode).toBe('table')
    expect(none.hint).toEqual({ mode: 'table', probedAt: NOW })
    expect(requestsOf('rpc').map((r) => [r.fn, r.args])).toEqual([['st_sync_head', { p_row: ROW }]])

    relay().rpc = 'present'
    const there = await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    expect(there.transport.mode).toBe('rpc')
    expect(there.hint).toEqual({ mode: 'rpc', probedAt: NOW })
  })

  it('re-probes a table hint after 24 h or when asked, and keeps an RPC hint', async () => {
    relay().rpc = 'present'
    const svc = await loadService({ VITE_SYNC_RELAY: 'auto' })
    const young = { mode: 'table' as const, probedAt: NOW - DAY + 1 }
    expect((await settle(svc.openTransport(ROW, young, NOW, false))).transport.mode).toBe('table')
    expect(relay().rpcs).toBe(0)
    const old = { mode: 'table' as const, probedAt: NOW - DAY }
    expect((await settle(svc.openTransport(ROW, old, NOW, false))).transport.mode).toBe('rpc')
    expect((await settle(svc.openTransport(ROW, young, NOW, true))).transport.mode).toBe('rpc')
    const rpcHint = { mode: 'rpc' as const, probedAt: NOW - 30 * DAY }
    const kept = await settle(svc.openTransport(ROW, rpcHint, NOW, false))
    expect(kept).toMatchObject({ transport: { mode: 'rpc' }, hint: rpcHint })
    expect(relay().rpcs).toBe(2)
  })

  it('keeps the hint (or table) without stamping it when the probe meets a network failure', async () => {
    const svc = await loadService({ VITE_SYNC_RELAY: 'auto' })
    failNext('head', { status: 0 })
    const none = await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    expect(none).toMatchObject({ transport: { mode: 'table' }, hint: { mode: null, probedAt: 0 } })
    failNext('head', { status: 0 })
    const hint = { mode: 'rpc' as const, probedAt: 5 }
    const kept = await settle(svc.openTransport(ROW, hint, NOW, true))
    expect(kept).toMatchObject({ transport: { mode: 'rpc' }, hint })
  })
})

describe('RPC mode (AC-T5)', () => {
  async function rpcTransport() {
    relay().rpc = 'present'
    const svc = await loadService({ VITE_SYNC_RELAY: 'rpc' })
    return { svc, t: await transportOf(svc) }
  }

  it('calls the functions with exactly p_row, p_payload, p_base and p_force', async () => {
    const { t } = await rpcTransport()
    expect(await settle(t.head(ROW))).toBeNull()
    expect(await settle(t.pull(ROW))).toBeNull()
    const created = await settle(t.push(ROW, doc(), noReturn))
    expect(created).toEqual({ ok: true, etag: rowStamp(ROW) })
    const pulled = await settle(t.pull(ROW))
    expect(pulled).toEqual({ payload: doc(), etag: rowStamp(ROW) })
    expect(await settle(t.head(ROW))).toBe(rowStamp(ROW))
    const base = pulled?.etag ?? ''
    await settle(t.push(ROW, doc('r2'), { base, force: false, keepalive: false }))
    await settle(t.push(ROW, doc('r3'), { base: 'stale', force: true, keepalive: false }))
    expect(requestsOf('rpc').map((r) => [r.fn, r.args])).toEqual([
      ['st_sync_head', { p_row: ROW }],
      ['st_sync_pull', { p_row: ROW }],
      ['st_sync_push', { p_row: ROW, p_payload: doc(), p_base: null, p_force: false }],
      ['st_sync_pull', { p_row: ROW }],
      ['st_sync_head', { p_row: ROW }],
      ['st_sync_push', { p_row: ROW, p_payload: doc('r2'), p_base: base, p_force: false }],
      ['st_sync_push', { p_row: ROW, p_payload: doc('r3'), p_base: 'stale', p_force: true }],
    ])
    expect(relay().upserts + relay().inserts + relay().updates).toBe(0)
  })

  it('maps the server answer to conflict and missing', async () => {
    const { t } = await rpcTransport()
    expect(await settle(t.push(ROW, doc(), { base: 'x', force: true, keepalive: false }))).toEqual({
      ok: false,
      reason: 'missing',
    })
    seedRow(ROW, doc())
    expect(await settle(t.push(ROW, doc('r2'), noReturn))).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(
      await settle(
        t.push(ROW, doc('r2'), { base: '2000-01-01T00:00:00Z', force: false, keepalive: false }),
      ),
    ).toEqual({ ok: false, reason: 'conflict' })
  })

  it('classifies 22023 as invalid, 53400 as a full relay and PGRST202 as no functions', async () => {
    const { svc, t } = await rpcTransport()
    relay().rpcMaxBytes = 10
    await expect(settle(t.push(ROW, doc(), noReturn))).rejects.toMatchObject({
      kind: 'invalid',
      code: '22023',
    })
    relay().rpcMaxBytes = 1_000_000
    relay().rpcFull = true
    const full = settle(t.push(ROW, doc(), noReturn))
    await expect(full).rejects.toBeInstanceOf(svc.SyncTransportError)
    await expect(full).rejects.toMatchObject({ kind: 'full', code: '53400' })
    relay().rpc = 'absent'
    await expect(settle(t.pull(ROW))).rejects.toMatchObject({ kind: 'no-rpc', code: 'PGRST202' })
  })
})

// ---------------------------------------------------------------------------
// Errors, deadlines, size, keepalive (AC-T6)
// ---------------------------------------------------------------------------

describe('errors and deadlines', () => {
  it.each([
    ['network', { status: 0 }],
    ['server', { status: 503, message: 'Service Unavailable' }],
    ['server', { status: 500, message: 'Internal' }],
    ['permission', { status: 401, message: 'Unauthorized' }],
    ['permission', { status: 403, message: 'Forbidden' }],
    ['permission', { status: 400, code: '42501', message: 'permission denied for table' }],
    ['no-rpc', { status: 404, code: 'PGRST202', message: 'no such function' }],
    ['full', { status: 503, code: '53400', message: 'relay is full' }],
    ['invalid', { status: 400, code: '22023', message: 'invalid payload' }],
  ] as const)('classifies a %s failure (%j) on head, pull and push', async (kind, failure) => {
    const svc = await loadService()
    const t = await transportOf(svc)
    failNext('head', failure)
    failNext('pull', failure)
    failNext('push', failure)
    // one at a time: each rejection is observed as soon as it settles
    const calls: (() => Promise<unknown>)[] = [
      () => t.head(ROW),
      () => t.pull(ROW),
      () => t.push(ROW, doc(), noReturn),
    ]
    for (const call of calls) {
      await expect(settle(call())).rejects.toMatchObject({ name: 'SyncTransportError', kind })
    }
  })

  it('classifies an RPC 404 as no functions', async () => {
    relay().rpc = 'present'
    const svc = await loadService({ VITE_SYNC_RELAY: 'rpc' })
    const t = await transportOf(svc)
    failNext('head', { status: 404, message: 'Not Found' })
    await expect(settle(t.head(ROW))).rejects.toMatchObject({ kind: 'no-rpc', status: 404 })
  })

  it('AC-T6: ends a request that never answers as a network failure after 15 s', async () => {
    const svc = await loadService()
    const t = await transportOf(svc)
    for (const op of ['head', 'pull', 'push'] as const) {
      failNext(op, { hang: true })
      const call = op === 'push' ? t.push(ROW, doc(), noReturn) : t[op](ROW)
      const outcome = expect(call).rejects.toMatchObject({ kind: 'network' })
      await advance(14_999)
      await advance(1)
      await outcome
    }
    failNext('push', { abortable: true })
    const aborted = expect(t.push(ROW, doc(), noReturn)).rejects.toMatchObject({ kind: 'network' })
    await advance(15_000)
    await aborted
  })

  it('refuses a payload over 1 MiB before any request', async () => {
    const svc = await loadService()
    const t = await transportOf(svc)
    const big = { ...doc(), categories: ['x'.repeat(1024 * 1024)] }
    await expect(t.push(ROW, big, noReturn)).rejects.toBeInstanceOf(svc.PayloadTooLargeError)
    expect(relay().upserts).toBe(0)
  })

  it('reports a failed SDK import as a network failure and loads it again next time', async () => {
    const svc = await loadService()
    relay().importFailures = 1
    await expect(
      settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false)),
    ).rejects.toMatchObject({ kind: 'network' })
    const t = await transportOf(svc)
    expect(await settle(t.pull(ROW))).toBeNull()
  })

  it('fails an SDK download that never finishes as network after 15 s, then loads it again', async () => {
    const svc = await loadService()
    relay().importStalls = 1
    const pending = svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false)
    const outcome = expect(pending).rejects.toMatchObject({ kind: 'network' })
    await advance(15_000)
    await outcome
    const t = await transportOf(svc)
    seedRow(ROW, doc())
    expect(await settle(t.pull(ROW))).toMatchObject({ payload: doc() })
  })

  it.each([
    ['a network failure', { status: 0 }],
    ['a 503', { status: 503, message: 'Service Unavailable' }],
  ] as const)(
    'sends one request for a pull that meets %s: the engine backoff is the only retry',
    async (_label, failure) => {
      const svc = await loadService()
      const t = await transportOf(svc)
      failNext('pull', failure, failure, failure, failure)
      const outcome = expect(t.pull(ROW)).rejects.toMatchObject({ name: 'SyncTransportError' })
      await advance(10_000)
      await outcome
      expect(relay().pulls).toBe(1)
    },
  )
})

describe('keepalive (AC-T6)', () => {
  it('gives the SDK a fetch that keeps a hide push of ≤ 60,000 chars alive, and nothing else', async () => {
    const svc = await loadService()
    const t = await transportOf(svc)
    expect(relay().clientOptions.at(-1)).toMatchObject({ global: { fetch: svc.relayFetch } })
    const fetched: (RequestInit | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        fetched.push(init)
        return Promise.resolve(new Response('[]'))
      }),
    )
    const small = { method: 'PATCH', body: 'x'.repeat(60_000) }
    const large = { method: 'PATCH', body: 'x'.repeat(60_001) }
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', small)
    relay().latency.push = 1000
    const hide = t.push(ROW, doc(), { ...noReturn, keepalive: true })
    await advance(10)
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', small)
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', large)
    await settle(hide, 1000)
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', small)
    expect(fetched.map((init) => init?.keepalive === true)).toEqual([false, true, false, false])
  })

  it('counts the quota in UTF-8 bytes: a body under 60,000 characters but over in bytes is no keepalive', async () => {
    const svc = await loadService()
    const t = await transportOf(svc)
    const fetched: (RequestInit | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        fetched.push(init)
        return Promise.resolve(new Response('[]'))
      }),
    )
    relay().latency.push = 1000
    const hide = t.push(ROW, doc(), { ...noReturn, keepalive: true })
    await advance(10)
    // item names in CJK and emoji: 3 and 4 bytes a character
    const cjk = '咖啡'.repeat(10_001) // 20,002 chars, 60,006 bytes
    const emoji = '☕'.repeat(19_999) // 19,999 chars, 59,997 bytes
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', { method: 'PATCH', body: cjk })
    await svc.relayFetch('http://relay.test/rest/v1/sync_buckets', { method: 'PATCH', body: emoji })
    await settle(hide, 1000)
    expect(fetched.map((init) => init?.keepalive === true)).toEqual([false, true])
  })
})

// ---------------------------------------------------------------------------
// Realtime (P3-12)
// ---------------------------------------------------------------------------

const RECONNECT = 2000

function channelAt(index: number): FakeChannel {
  const channel = relay().created[index]
  if (!channel) throw new Error(`no channel #${String(index)}`)
  return channel
}

function handlers() {
  return { onRowChange: vi.fn(), onBroadcast: vi.fn(), onStatus: vi.fn() }
}

describe('topicOf', () => {
  it('is the hashed plaintext topic (st: + 32 hex), never the raw code', async () => {
    const svc = await loadService()
    const topic = await svc.topicOf(ROW)
    expect(topic).toBe(await plainTopic(ROW))
    expect(topic).toMatch(/^st:[0-9a-f]{32}$/)
    expect(topic).not.toContain(ROW)
    expect(topic).not.toContain(ROW.slice(-12))
  })
})

describe('subscribeSync', () => {
  const TOPIC = 'st:0123456789abcdef0123456789abcdef'

  async function subscribe(rowEvents = true, h = handlers()) {
    const svc = await loadService()
    const unsubscribe = await svc.subscribeSync({ topic: TOPIC, row: ROW, rowEvents }, h)
    return { svc, unsubscribe, h }
  }

  it('opens one channel on the topic: Broadcast always, postgres_changes on the row when asked', async () => {
    const { unsubscribe } = await subscribe(true)
    const ch = channelAt(0)
    expect(ch.name).toBe(TOPIC)
    expect(ch.options).toEqual({ config: { broadcast: { self: false, ack: false } } })
    expect(ch.broadcastEvents).toBe(true)
    expect(ch.rowFilter).toBe(`sync_id=eq.${ROW}`)
    unsubscribe()
    const { unsubscribe: off } = await subscribe(false)
    expect(channelAt(1).rowEvents).toBe(false)
    expect(channelAt(1).broadcastEvents).toBe(true)
    off()
  })

  it('reports joined, then dropped, and re-subscribes after 2, 4, 8 … 60 s', async () => {
    relay().realtimeDown = true // every join fails
    const { h, unsubscribe } = await subscribe(false)
    const created: number[] = []
    for (let ms = 0; ms < 400_000 && created.length < 8; ms += 100) {
      const before = relay().created.length
      await advance(100)
      if (relay().created.length > before) created.push(Date.now())
    }
    const gaps = created.slice(1).map((at, i) => Math.round((at - (created[i] ?? 0)) / 1000))
    expect(gaps).toEqual([4, 8, 16, 32, 60, 60, 60])
    expect(h.onStatus).toHaveBeenLastCalledWith('dropped')
    // a join resets the backoff
    relay().realtimeDown = false
    await advance(61_000)
    expect(h.onStatus).toHaveBeenLastCalledWith('joined')
    const before = relay().created.length
    relay().created.at(-1)?.emit('CLOSED')
    expect(h.onStatus).toHaveBeenLastCalledWith('dropped')
    await advance(RECONNECT)
    expect(relay().created.length).toBe(before + 1)
    unsubscribe()
  })

  it.each([
    ['on a later microtask', false],
    ['synchronously', true],
  ])('re-arms exactly once per drop when the old channel reports CLOSED %s', async (_l, sync) => {
    relay().closeSync = sync
    const { unsubscribe } = await subscribe()
    const first = channelAt(0)
    first.emit('SUBSCRIBED')
    first.emit('TIMED_OUT')
    await advance(RECONNECT)
    for (let i = 0; i < 5; i++) await advance(RECONNECT)
    expect(relay().created).toHaveLength(2)
    expect(relay().removed).toEqual([first])
    unsubscribe()
    await advance(5 * RECONNECT)
    expect(relay().removed).toEqual([first, channelAt(1)])
  })

  it('cancels a pending reconnect on unsubscribe', async () => {
    const { unsubscribe } = await subscribe()
    channelAt(0).emit('CLOSED')
    unsubscribe()
    await advance(5 * RECONNECT)
    expect(relay().created).toHaveLength(1)
    expect(relay().removed).toEqual([channelAt(0)])
  })

  it('gives up on postgres_changes after two CHANNEL_ERRORs in a row (failed), Broadcast-only never does', async () => {
    relay().rowEvents = 'rejected'
    const { h, unsubscribe } = await subscribe(true)
    await advance(10) // CHANNEL_ERROR
    expect(h.onStatus).toHaveBeenLastCalledWith('dropped')
    await advance(RECONNECT + 10) // CHANNEL_ERROR again
    expect(h.onStatus).toHaveBeenLastCalledWith('failed')
    const made = relay().created.length
    await advance(120_000)
    expect(relay().created.length).toBe(made) // the engine re-subscribes without row events
    unsubscribe()

    relay().rowEvents = 'on'
    relay().realtimeDown = true
    const second = await subscribe(false)
    await advance(60_000)
    expect(second.h.onStatus).not.toHaveBeenCalledWith('failed')
    second.unsubscribe()
  })

  it('hands row changes and Broadcast messages to their handlers; a malformed message is dropped', async () => {
    const { h, unsubscribe } = await subscribe(true)
    await advance(10)
    seedRow(ROW, doc())
    channelAt(0).deliver({
      eventType: 'UPDATE',
      schema: 'public',
      table: 'sync_buckets',
      new: { sync_id: ROW, payload: doc(), updated_at: rowStamp(ROW) },
      old: {},
    })
    expect(h.onRowChange).toHaveBeenCalledWith({ payload: doc(), updatedAt: rowStamp(ROW) })
    channelAt(0).hear({ type: 'broadcast', event: 'rev', payload: { rev: 'r9', dev: 'abc123' } })
    channelAt(0).hear({ type: 'broadcast', event: 'rev', payload: { rev: 9 } })
    channelAt(0).hear({ type: 'broadcast', event: 'rev', payload: 'nope' })
    expect(h.onBroadcast.mock.calls).toEqual([[{ rev: 'r9', dev: 'abc123' }]])
    unsubscribe()
  })

  it('ignores statuses and events of a channel it has replaced', async () => {
    const { h, unsubscribe } = await subscribe(true)
    const first = channelAt(0)
    await advance(10)
    first.emit('TIMED_OUT')
    await advance(RECONNECT + 10)
    h.onStatus.mockClear()
    first.emit('SUBSCRIBED')
    first.hear({ type: 'broadcast', event: 'rev', payload: { rev: 'r1', dev: 'x' } })
    expect(h.onStatus).not.toHaveBeenCalled()
    expect(h.onBroadcast).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('announce', () => {
  it('sends over the joined channel of the topic, never over REST then', async () => {
    const svc = await loadService()
    const topic = await svc.topicOf(ROW)
    const mine = await svc.subscribeSync({ topic, row: ROW, rowEvents: true }, handlers())
    await advance(10)
    // another client listens on the same topic
    const other = handlers()
    const theirs = await svc.subscribeSync({ topic, row: ROW, rowEvents: false }, other)
    await advance(10)
    svc.announce(topic, { rev: 'r7', dev: 'me0001' })
    await advance(10)
    expect(relay().broadcastLog.map((b) => b.via)).toEqual(['ws'])
    expect(relay().broadcastLog[0]).toMatchObject({
      topic,
      event: 'rev',
      payload: { rev: 'r7', dev: 'me0001' },
    })
    mine()
    theirs()
  })

  it("sends by REST over a subscription's channel that is still joining, and never removes it", async () => {
    relay().subscribeDelay = 500
    const svc = await loadService()
    const topic = await svc.topicOf(ROW)
    const h = handlers()
    const off = await svc.subscribeSync({ topic, row: ROW, rowEvents: true }, h)
    svc.announce(topic, { rev: 'r10', dev: 'me0001' })
    await advance(10)
    expect(relay().broadcastLog.map((b) => b.via)).toEqual(['http'])
    // the SDK handed out the subscription's own channel: it stays, and joins
    expect(relay().created).toHaveLength(1)
    expect(relay().removed).toHaveLength(0)
    await advance(600)
    expect(h.onStatus.mock.calls).toEqual([['joined']])
    off()
  })

  it('a subscription opened while a REST send is in flight shares its channel, which stays', async () => {
    const svc = await loadService()
    const topic = await svc.topicOf(ROW)
    await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    const h = handlers()
    svc.announce(topic, { rev: 'r11', dev: 'me0001' })
    const off = await svc.subscribeSync({ topic, row: ROW, rowEvents: true }, h)
    await advance(100)
    expect(relay().broadcastLog.map((b) => b.via)).toEqual(['http'])
    expect(relay().created).toHaveLength(1)
    expect(relay().removed).toHaveLength(0)
    expect(h.onStatus.mock.calls).toEqual([['joined']])
    off()
  })

  it('uses httpSend on a transient channel when not subscribed, removes it, and never throws', async () => {
    const svc = await loadService()
    const topic = await svc.topicOf(ROW)
    await settle(svc.openTransport(ROW, { mode: null, probedAt: 0 }, NOW, false))
    svc.announce(topic, { rev: 'r8', dev: 'me0001' })
    await advance(10)
    expect(relay().broadcastLog).toEqual([
      expect.objectContaining({ topic, via: 'http', payload: { rev: 'r8', dev: 'me0001' } }),
    ])
    expect(relay().removed).toContain(relay().created.at(-1))
    relay().broadcast = 'rejected'
    expect(() => {
      svc.announce(topic, { rev: 'r9', dev: 'me0001' })
    }).not.toThrow()
    await advance(10)
    expect(relay().broadcastLog).toHaveLength(1)
  })
})
