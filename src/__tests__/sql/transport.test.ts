// @vitest-environment node
// 0.11.0's sync transport, unmodified, against the real SQL (PR-5 track spec §3.9; AC-16 to
// AC-18): src/services/syncService.ts → the real supabase-js → the PostgREST-shaped adapter →
// Postgres with 001 to 005 applied and rolled back. Build flags as Vercel would set them
// (VITE_SYNC_CAS, VITE_SYNC_RELAY), the session time zone as Supabase might have it, and the
// JSONB slack of the owner's documents measured on Postgres itself.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ownerDoc } from '../../data/__tests__/support/ownerShape'
import { encodeWire } from '../../data/core/wire'
import type { Doc } from '../../data/core/types'
import { bootRelay, closeTemplate, throwaway, type PgRelay, type Stage } from '../pgRelay'
import { pgRest, type PgRest } from '../pgRest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const BASE = 'http://relay.test'
const KEY = 'invented-anon-key'
const ROW = throwaway(0xa1)
const PG_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{0,5}[1-9])?[+-]\d{2}:\d{2}$/
const RPC_PAYLOAD_MAX = 1_258_291 // syncEngine's limit, the size 004 refuses above
const JSONB_SLACK = 1.15 // syncEngine's estimate of jsonb text over JSON.stringify

type Service = typeof import('../../services/syncService')
type Transport = Awaited<ReturnType<Service['openTransport']>>['transport']

/** An invented relay payload in the v5 plaintext shape (the transport never reads it). */
const doc = (rev: string): Record<string, unknown> => ({
  version: '4.0',
  exportDate: '2026-10-01T04:00:00.000Z',
  expenses: [
    {
      id: 'e1',
      itemName: `item ${rev}`,
      amount: 1,
      category: 'Other',
      date: '2026-10-01T12:00:00',
    },
  ],
  categories: ['Other'],
  deletedIds: [],
  x5: { schema: 5, minor: 0, min: 4, rev, dig: 'abc' },
})

const PLAIN = { base: null, force: false, keepalive: false }
const casOn = (base: string) => ({ base, force: false, keepalive: false })
const FORCE = { base: null, force: true, keepalive: false }

let relay: PgRelay
let rest: PgRest

async function at(stage: Stage): Promise<void> {
  await relay.close()
  relay = await bootRelay(stage)
  rest = pgRest(relay)
  vi.stubGlobal('fetch', rest.fetch)
}

async function loadService(env: Readonly<Record<string, string>> = {}): Promise<Service> {
  vi.stubEnv('VITE_SUPABASE_URL', BASE)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', KEY)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return import('../../services/syncService')
}

async function open(svc: Service, reprobe = false, hint: 'table' | 'rpc' | null = null) {
  return svc.openTransport(ROW, { mode: hint, probedAt: 0 }, Date.now(), reprobe)
}

interface Failure {
  readonly kind: unknown
  readonly code: unknown
  readonly status: unknown
}

/** The SyncTransportError a call threw (by name: each module reload has its own class). */
async function failureOf(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run()
  } catch (err) {
    if (err instanceof Error && err.name === 'SyncTransportError') {
      return {
        kind: 'kind' in err ? err.kind : undefined,
        code: 'code' in err ? err.code : undefined,
        status: 'status' in err ? err.status : undefined,
      }
    }
    throw err
  }
  throw new Error('expected a SyncTransportError')
}

/** Exact microseconds of a stamp, for strict ordering. */
function us(stamp: string): bigint {
  const m = /^(.+?)(?:\.(\d{1,6}))?([+-]\d{2}:\d{2}|Z)$/.exec(stamp)
  if (m === null) throw new Error(`not a stamp: ${stamp}`)
  return (
    BigInt(Date.parse(`${m[1] ?? ''}${m[3] ?? 'Z'}`)) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0'))
  )
}

/** The stamp 1 µs later, in Postgres's JSON form (Postgres does the sum). */
async function microLater(stamp: string): Promise<string> {
  const rows = await relay.rows<{ t: string }>(
    `SELECT to_json($1::timestamptz + interval '1 microsecond') #>> '{}' AS t`,
    [stamp],
  )
  const t = rows[0]?.t
  if (t === undefined) throw new Error(`no stamp after ${stamp}`)
  expect(us(t) - us(stamp)).toBe(1n)
  return t
}

function etagOf(outcome: { readonly ok: boolean; readonly etag?: string }): string {
  if (!outcome.ok || outcome.etag === undefined) throw new Error('the push did not land')
  return outcome.etag
}

beforeAll(async () => {
  relay = await bootRelay('004')
  rest = pgRest(relay)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await relay.close()
  await closeTemplate()
})

describe('default flags: the plain upsert (AC-16)', () => {
  for (const stage of ['001-003', '004'] as const) {
    it(`${stage}: the upsert answers a Postgres etag that head and pull agree with`, async () => {
      await at(stage)
      const svc = await loadService()
      expect([svc.CAS_ON, svc.RELAY_PIN]).toEqual([false, 'table'])
      const { transport } = await open(svc)
      expect(transport.mode).toBe('table')
      const etag = etagOf(await transport.push(ROW, doc('r1'), PLAIN))
      expect(etag).toMatch(PG_STAMP)
      expect(etag).toMatch(/\+00:00$/)
      expect(await transport.head(ROW)).toBe(etag)
      expect(await transport.pull(ROW)).toEqual({ payload: doc('r1'), etag })
      const again = etagOf(await transport.push(ROW, doc('r2'), { ...PLAIN, base: etag }))
      expect(us(again) > us(etag)).toBe(true)
      expect(rest.log.map((r) => [r.kind, r.status])).toEqual([
        ['upsert', 201],
        ['head', 200],
        ['pull', 200],
        ['upsert', 201],
      ])
    })
  }
})

describe('VITE_SYNC_CAS=on: compare-and-set over the table (AC-16)', () => {
  it('insert, exact-etag PATCH, conflict, create-conflict, force and missing', async () => {
    await at('004')
    const svc = await loadService({ VITE_SYNC_CAS: 'on' })
    expect(svc.CAS_ON).toBe(true)
    const { transport } = await open(svc)
    const e1 = etagOf(await transport.push(ROW, doc('r1'), PLAIN))
    expect(e1).toMatch(PG_STAMP)
    const e2 = etagOf(await transport.push(ROW, doc('r2'), casOn(e1)))
    expect(us(e2) > us(e1)).toBe(true)
    expect(await transport.head(ROW)).toBe(e2)
    expect(await transport.push(ROW, doc('stale'), casOn(e1))).toEqual({
      ok: false,
      reason: 'conflict',
    })
    // a base later than the row's token matches no row either: only the exact etag lands
    for (const later of [await microLater(e2), '2099-01-01T00:00:00+00:00']) {
      expect(await transport.push(ROW, doc('later'), casOn(later)), later).toEqual({
        ok: false,
        reason: 'conflict',
      })
    }
    expect(await transport.pull(ROW)).toEqual({ payload: doc('r2'), etag: e2 })
    expect(await transport.push(ROW, doc('again'), PLAIN)).toEqual({
      ok: false,
      reason: 'conflict',
    })
    const e3 = etagOf(await transport.push(ROW, doc('forced'), FORCE))
    expect(us(e3) > us(e2)).toBe(true)
    expect(await transport.push(throwaway(0xa2), doc('gone'), FORCE)).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(await transport.pull(throwaway(0xa2))).toBeNull()
    expect(await transport.pull(ROW)).toEqual({ payload: doc('forced'), etag: e3 })
    expect(rest.log.filter((r) => r.kind === 'insert').map((r) => r.status)).toEqual([201, 409])
    expect(rest.log.filter((r) => r.kind === 'update').map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ])
  })
})

describe('VITE_SYNC_RELAY=auto through every database state (AC-16, AC-9)', () => {
  it('table before 004, the functions after 004, permission from the table after 005 while they still work, table again after the 004 rollback', async () => {
    await at('001-003')
    const svc = await loadService({ VITE_SYNC_RELAY: 'auto', VITE_SYNC_CAS: 'on' })
    expect(svc.RELAY_PIN).toBe('auto')

    const before = await open(svc)
    expect(before.transport.mode).toBe('table')
    expect(before.hint.mode).toBe('table')
    expect(rest.log.at(-1)).toMatchObject({
      kind: 'rpc',
      fn: 'st_sync_head',
      status: 404,
      code: 'PGRST202',
    })
    const t0 = etagOf(await before.transport.push(ROW, doc('table'), PLAIN))

    await relay.apply('004')
    const after004 = await open(svc, true, 'table')
    expect(after004.transport.mode).toBe('rpc')
    const rpc: Transport = after004.transport
    expect(await rpc.head(ROW)).toBe(t0)
    const t1 = etagOf(await rpc.push(ROW, doc('rpc'), casOn(t0)))
    expect(us(t1) > us(t0)).toBe(true)
    expect(await rpc.pull(ROW)).toEqual({ payload: doc('rpc'), etag: t1 })
    expect(await rpc.push(ROW, doc('stale'), casOn(t0))).toEqual({ ok: false, reason: 'conflict' })
    for (const later of [await microLater(t1), '2099-01-01T00:00:00+00:00']) {
      expect(await rpc.push(ROW, doc('later'), casOn(later)), later).toEqual({
        ok: false,
        reason: 'conflict',
      })
    }
    expect(await rpc.pull(ROW)).toEqual({ payload: doc('rpc'), etag: t1 })

    await relay.apply('005')
    const table = before.transport
    expect(await failureOf(() => table.head(ROW))).toEqual({
      kind: 'permission',
      code: '42501',
      status: 401,
    })
    expect(await failureOf(() => table.push(ROW, doc('locked'), casOn(t1)))).toMatchObject({
      kind: 'permission',
      status: 401,
    })
    const reprobed = await open(svc, true, 'table')
    expect(reprobed.transport.mode).toBe('rpc')
    const t2 = etagOf(await reprobed.transport.push(ROW, doc('locked rpc'), casOn(t1)))
    expect(await reprobed.transport.head(ROW)).toBe(t2)

    await relay.apply('005-rollback')
    await relay.apply('004-rollback')
    expect(await failureOf(() => rpc.head(ROW))).toEqual({
      kind: 'no-rpc',
      code: 'PGRST202',
      status: 404,
    })
    const back = await open(svc, true, 'rpc')
    expect(back.transport.mode).toBe('table')
    expect(back.hint.mode).toBe('table')
    expect(await back.transport.head(ROW)).toBe(t2)
    const t3 = etagOf(await back.transport.push(ROW, doc('table again'), casOn(t2)))
    expect(us(t3) > us(t2)).toBe(true)
  })
})

describe('between gate C and gate E, an older build moves the token back (AC-16)', () => {
  it("a CAS device's base is then later than the token: a conflict, so the older build's write is merged, never overwritten", async () => {
    await at('004')
    const cas = await loadService({ VITE_SYNC_RELAY: 'auto', VITE_SYNC_CAS: 'on' })
    const a = (await open(cas)).transport
    expect(a.mode).toBe('rpc')
    const tA = etagOf(await a.push(ROW, doc('A'), PLAIN))

    vi.unstubAllEnvs()
    const older = await loadService() // the default flags: the plain upsert over the table
    const b = (await open(older)).transport
    expect(b.mode).toBe('table')
    // its clock runs 2 s slow, and the plain upsert writes that clock's token
    const realNow = Date.now.bind(Date)
    const slow = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 2000)
    let tB: string
    try {
      tB = etagOf(await b.push(ROW, doc('B'), PLAIN))
    } finally {
      slow.mockRestore()
    }
    expect(us(tB) < us(tA), `${tB} before ${tA}`).toBe(true)

    expect(await a.head(ROW)).toBe(tB)
    expect(await a.push(ROW, doc('A2'), casOn(tA))).toEqual({ ok: false, reason: 'conflict' })
    expect(await a.pull(ROW)).toEqual({ payload: doc('B'), etag: tB })
    // after the merge, the next token is later than every token the row ever had
    const tA2 = etagOf(await a.push(ROW, doc('A2 + B'), casOn(tB)))
    expect(us(tA2) > us(tA)).toBe(true)
  })
})

describe('error classes from the real SQL (AC-16)', () => {
  it('22023 → invalid, 53400 → full, 401 → permission', async () => {
    await at('004')
    const svc = await loadService({ VITE_SYNC_RELAY: 'rpc' })
    const { transport } = await open(svc)
    expect(transport.mode).toBe('rpc')
    expect(await failureOf(() => transport.push(ROW, { a: 1 }, PLAIN))).toEqual({
      kind: 'invalid',
      code: '22023',
      status: 400,
    })
    // under the client's 1 M-character guard, over the relay's 1.2 MB of jsonb text
    const cjk = { ...doc('big'), note: '中'.repeat(450_000) }
    expect(JSON.stringify(cjk).length).toBeLessThan(1024 * 1024)
    expect(await failureOf(() => transport.push(ROW, cjk, PLAIN))).toEqual({
      kind: 'invalid',
      code: '22023',
      status: 400,
    })
    await relay.fill({ count: 20, createdAgo: '5 minutes' })
    expect(await failureOf(() => transport.push(ROW, doc('full'), PLAIN))).toEqual({
      kind: 'full',
      code: '53400',
      status: 500,
    })
    await relay.apply('005')
    const table = await loadService({ VITE_SYNC_RELAY: 'table' })
    const t = (await open(table)).transport
    expect(await failureOf(() => t.pull(ROW))).toEqual({
      kind: 'permission',
      code: '42501',
      status: 401,
    })
  })
})

describe('session time zones (AC-17)', () => {
  const zones = [
    'UTC',
    'Asia/Singapore',
    'Pacific/Honolulu',
    'Pacific/Kiritimati',
    'America/New_York',
  ]

  it("etags carry each zone's offset, and 0.11.0's CAS still matches over the table and the functions", async () => {
    await at('004')
    const offsets = new Set<string>()
    for (const [i, zone] of zones.entries()) {
      rest.setTimeZone(zone)
      for (const [m, relayMode] of (['table', 'rpc'] as const).entries()) {
        const row = throwaway(0xd0 + 2 * i + m)
        const svc = await loadService({ VITE_SYNC_CAS: 'on', VITE_SYNC_RELAY: relayMode })
        const { transport } = await svc.openTransport(
          row,
          { mode: null, probedAt: 0 },
          Date.now(),
          false,
        )
        expect(transport.mode).toBe(relayMode)
        const first = etagOf(await transport.push(row, doc(`${zone} 1`), PLAIN))
        expect(first, zone).toMatch(PG_STAMP)
        offsets.add(first.slice(-6))
        const second = etagOf(await transport.push(row, doc(`${zone} 2`), casOn(first)))
        expect(us(second) > us(first), zone).toBe(true)
        const headed = await transport.head(row)
        expect(headed, zone).toBe(second)
        expect(svc.sameEtag(headed, second)).toBe(true)
        expect(await transport.push(row, doc(`${zone} stale`), casOn(first))).toEqual({
          ok: false,
          reason: 'conflict',
        })
      }
    }
    expect(offsets.size).toBe(zones.length)
    rest.setTimeZone('UTC')
  })
})

describe("JSONB slack of the owner's documents (AC-18)", () => {
  /** The owner's shape with most rows deleted: tombstones dominate the wire. */
  function tombstoneHeavy(): Doc {
    const base = ownerDoc(3500, 11)
    const live = [...base.expenses.entries()]
    const kept = new Map(live.slice(0, 500))
    const tombs = new Map(base.tombs)
    for (const [id] of live.slice(500)) tombs.set(id, Date.UTC(2026, 9, 1, 4))
    return { ...base, expenses: kept, tombs }
  }

  it("measures octet_length(wire::jsonb::text) / utf8(JSON.stringify(wire)) and keeps the engine's estimate safe", async () => {
    await at('004')
    const docs: readonly (readonly [string, Doc])[] = [
      ['ownerDoc(700)', ownerDoc(700, 42)],
      ['ownerDoc(3500)', ownerDoc(3500, 42)],
      ['ownerDoc(5000)', ownerDoc(5000, 42)],
      ['tombstone-heavy (500 live, 3000 deleted)', tombstoneHeavy()],
    ]
    const report: string[] = []
    for (const [label, d] of docs) {
      const json = JSON.stringify(encodeWire(d, { rev: 'r-slack', dev: 'laptop' }))
      const bytes = new TextEncoder().encode(json).length
      const rows = await relay.rows<{ n: number }>(`SELECT octet_length($1::jsonb::text) AS n`, [
        json,
      ])
      const pg = rows[0]?.n ?? 0
      const slack = pg / bytes
      report.push(
        `${label}: ${String(bytes)} B JSON, ${String(pg)} B jsonb text, slack ${slack.toFixed(4)}`,
      )
      expect(slack, label).toBeGreaterThan(1)
      expect(slack, `${label}: over the engine's JSONB_SLACK (a 0.11.1 item)`).toBeLessThanOrEqual(
        JSONB_SLACK,
      )
      // the engine pauses ("too large") exactly when its estimate says the relay would refuse
      if (pg > RPC_PAYLOAD_MAX) expect(bytes * JSONB_SLACK, label).toBeGreaterThan(RPC_PAYLOAD_MAX)
    }
    console.info(`[AC-18] JSONB slack\n  ${report.join('\n  ')}`)
  })
})
