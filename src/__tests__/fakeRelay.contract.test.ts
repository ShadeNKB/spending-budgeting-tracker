// The fake relay against the frozen contract of PR-5 (track spec §4 tables A, B and C, §3.10):
// what migrations 004 and 005 really do, so the sync suites test the client against the server
// it will meet. `rpc === 'present'` stands for 004 applied, `lockdown` for 005. U1 proves the
// same tables on real Postgres; e2e/data-engine/support/relayServer.ts is held to them in
// scripts/verify-cas.test.mjs. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeClient,
  jsonbTextBytes,
  micros,
  migrate,
  relay,
  requestsOf,
  resetRelay,
  rowPayload,
  rowStamp,
  seedRow,
  type RelayResponse,
} from './fakeRelay'

const ROW = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
/** A valid id written in upper case (Postgres's `~` is case-sensitive). */
const UPPER = 'ABCDEF12-3456-4789-8ABC-DEF123456789'
const TABLE = 'sync_buckets'
const RPC_MAX = 1_258_291
const TABLE_MAX = 2_097_152

/** An invented v5 plaintext payload (the shape st_sync_push accepts). */
const v5 = (rev = 'r1'): Record<string, unknown> => ({
  version: '4.0',
  exportDate: '2026-11-03T04:00:00.000Z',
  expenses: [{ id: 'e1', itemName: 'item e1', amount: 1, date: '2026-11-03T12:00:00' }],
  deletedIds: [],
  x5: { schema: 5, rev },
})

/** A 0.8.x-0.10.0 table payload: v4, no `x5` (fine on the table, refused by st_sync_push). */
const v4 = (): Record<string, unknown> => ({
  version: '4.0',
  exportDate: '2026-11-03T04:00:00.000Z',
  expenses: [],
  deletedIds: [],
})

/**
 * A v5-shaped payload whose jsonb text is exactly `bytes` long. The jsonb text of
 * `{"expenses": [], "x5": {}, "pad": "<p>"}` is 37 bytes plus the UTF-8 bytes of `p`
 * (key order and the `": "` / `", "` separators of jsonb_out), counted by hand here so the
 * test does not lean on the measure it checks.
 */
function sized(bytes: number, unit: 'x' | '漢' = 'x'): Record<string, unknown> {
  const room = bytes - 37
  const per = unit === 'x' ? 1 : 3
  const pad = unit.repeat(Math.floor(room / per)) + 'x'.repeat(room % per)
  return { expenses: [], x5: {}, pad }
}

const client = () => new FakeClient()

const push = (args: Record<string, unknown>): PromiseLike<RelayResponse> =>
  client().rpc('st_sync_push', { p_base: null, p_force: false, ...args })

const head = (row: unknown) => client().rpc('st_sync_head', { p_row: row })
const pull = (row: unknown) => client().rpc('st_sync_pull', { p_row: row })

const stamp = (value: unknown): number => {
  const t = typeof value === 'string' ? micros(value) : null
  if (t === null) throw new Error(`not a stamp: ${String(value)}`)
  return t
}

/** The data of a successful answer (fails the test on an error). */
/** An instant in microseconds, written as tok() sends it: Z and six fraction digits. */
function zulu(us: number): string {
  const iso = new Date(Math.floor(us / 1000)).toISOString().slice(0, 23)
  return `${iso}${String(us % 1000).padStart(3, '0')}Z`
}

function dataOf(res: RelayResponse): unknown {
  expect(res.error).toBeNull()
  return res.data
}

/** The SQLSTATE and status of a refusal. */
const refusal = (res: RelayResponse) => ({
  status: res.status,
  code: res.error?.code,
  message: res.error?.message,
})

// Only Date is faked (the relay's own timers stay real): the clock reads 3 Nov 2026, so the
// year-end case below has a clock behind its base whenever the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 10, 3, 4, 0, 0))
  resetRelay()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// §3.10 jsonb text vectors (AC-19, U2 half)
// ---------------------------------------------------------------------------

describe('jsonbTextBytes (§3.10 vectors)', () => {
  it.each([
    ['{}', 2],
    ['[]', 2],
    ['{"a":1}', 8],
    ['[1,2,3]', 9],
    ['{"a":1,"b":[1,2]}', 21],
    ['{"a":{"b":[]}}', 16],
    ['{"k":"é"}', 11],
    ['{"n":"\\n"}', 11],
    ['{"e":"😀"}', 13],
  ])('%s is %i bytes of jsonb text', (text, bytes) => {
    const value: unknown = JSON.parse(text)
    expect(jsonbTextBytes(value)).toBe(bytes)
  })

  it('agrees with the hand count of the padded payloads the boundary tests use', () => {
    expect(jsonbTextBytes(sized(RPC_MAX))).toBe(RPC_MAX)
    expect(jsonbTextBytes(sized(RPC_MAX, '漢'))).toBe(RPC_MAX)
    expect(jsonbTextBytes(sized(TABLE_MAX + 1))).toBe(TABLE_MAX + 1)
  })
})

// ---------------------------------------------------------------------------
// Table A: the sync functions, as anon (after 004; unchanged after 005)
// ---------------------------------------------------------------------------

describe('table A: st_sync_head and st_sync_pull', () => {
  beforeEach(() => {
    migrate('004')
  })

  it('head answers the row’s updated_at in PostgREST’s JSON form, null for a missing row', async () => {
    expect(dataOf(await head(ROW))).toBeNull()
    seedRow(ROW, v5())
    const etag = dataOf(await head(ROW))
    expect(etag).toBe(rowStamp(ROW))
    expect(etag).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/)
  })

  it('pull answers {payload, updated_at, now}, null for a missing row', async () => {
    expect(dataOf(await pull(ROW))).toBeNull()
    seedRow(ROW, v5())
    const data = dataOf(await pull(ROW))
    expect(Object.keys(data ?? {}).sort()).toEqual(['now', 'payload', 'updated_at'])
    expect(data).toMatchObject({ payload: v5(), updated_at: rowStamp(ROW) })
    const now = typeof data === 'object' && data !== null && 'now' in data ? data.now : null
    expect(typeof now === 'string' && micros(now) !== null).toBe(true)
  })

  it('head and pull answer null for a null, non-UUID or upper-case id, even if such a row exists', async () => {
    const junk = ['not-a-uuid', UPPER, `${ROW} `, '']
    for (const id of junk) seedRow(id, v5())
    for (const id of [...junk, null, 42]) {
      expect(dataOf(await head(id))).toBeNull()
      expect(dataOf(await pull(id))).toBeNull()
    }
  })

  it('every function is 404 PGRST202 before 004 and after its rollback', async () => {
    resetRelay()
    for (const fn of ['st_sync_head', 'st_sync_pull', 'st_sync_push']) {
      expect(refusal(await client().rpc(fn, { p_row: ROW }))).toMatchObject({
        status: 404,
        code: 'PGRST202',
      })
    }
    migrate('004')
    migrate('rollback 004')
    expect(refusal(await head(ROW))).toMatchObject({ status: 404, code: 'PGRST202' })
  })
})

describe('table A: st_sync_push validation (22023, nothing written)', () => {
  beforeEach(() => {
    migrate('004')
  })

  it.each([
    ['null', null],
    ['a number', 7],
    ['a non-UUID', 'my-sync-code'],
    ['an upper-case UUID', UPPER],
    ['a UUID with a space', ` ${ROW}`],
  ])('refuses %s row id', async (_label, row) => {
    expect(refusal(await push({ p_row: row, p_payload: v5() }))).toEqual({
      status: 400,
      code: '22023',
      message: 'invalid row id',
    })
    expect(relay().pushes).toHaveLength(0)
  })

  it.each([
    ['null', null],
    ['an array', [v5()]],
    ['a string', 'payload'],
    ['a number', 1],
  ])('refuses %s payload', async (_label, payload) => {
    expect(refusal(await push({ p_row: ROW, p_payload: payload }))).toEqual({
      status: 400,
      code: '22023',
      message: 'invalid payload',
    })
  })

  it.each([
    ['{}', {}],
    ['a v4 payload (no x5)', v4()],
    ['x5 an array', { expenses: [], x5: [] }],
    ['expenses an object', { expenses: {}, x5: {} }],
    ['a private envelope with st "5" as text', { st: '5', iv: 'aa', ct: 'bb' }],
    ['a private envelope without ct', { st: 5, iv: 'aa' }],
    ['a private envelope with a numeric iv', { st: 5, iv: 1, ct: 'bb' }],
    ['a moved marker without x5', { expenses: 'moved' }],
    ['expenses "gone"', { expenses: 'gone', x5: {} }],
  ])('refuses the shape %s', async (_label, payload) => {
    expect(refusal(await push({ p_row: ROW, p_payload: payload }))).toEqual({
      status: 400,
      code: '22023',
      message: 'invalid payload shape',
    })
    expect(relay().rows.has(ROW)).toBe(false)
  })

  it.each([
    ['v5 plaintext', v5()],
    ['a private envelope', { st: 5, iv: 'iv-b64', ct: 'ct-b64', topic: 'abc' }],
    ['the moved marker', { expenses: 'moved', x5: { schema: 5, moved: true } }],
  ])('accepts %s', async (_label, payload) => {
    expect(dataOf(await push({ p_row: ROW, p_payload: payload }))).toMatchObject({ ok: true })
    expect(rowPayload(ROW)).toEqual(payload)
  })

  it('checks the row id first, then the payload, its size, then its shape', async () => {
    expect(refusal(await push({ p_row: 'x', p_payload: [] })).message).toBe('invalid row id')
    expect(refusal(await push({ p_row: ROW, p_payload: [] })).message).toBe('invalid payload')
    const bigBadShape = { pad: 'x'.repeat(RPC_MAX) }
    expect(refusal(await push({ p_row: ROW, p_payload: bigBadShape })).message).toBe(
      'payload too large',
    )
  })

  it('AC-5: accepts exactly 1,258,291 bytes of jsonb text and refuses 1,258,292', async () => {
    expect(dataOf(await push({ p_row: ROW, p_payload: sized(RPC_MAX) }))).toMatchObject({
      ok: true,
    })
    expect(refusal(await push({ p_row: OTHER, p_payload: sized(RPC_MAX + 1) }))).toEqual({
      status: 400,
      code: '22023',
      message: 'payload too large',
    })
    expect(relay().rows.has(OTHER)).toBe(false)
  })

  it('AC-5: counts bytes, not characters (a CJK payload well under the limit in characters)', async () => {
    const atLimit = sized(RPC_MAX, '漢')
    expect(JSON.stringify(atLimit).length).toBeLessThan(RPC_MAX / 2)
    expect(dataOf(await push({ p_row: ROW, p_payload: atLimit }))).toMatchObject({ ok: true })
    expect(refusal(await push({ p_row: OTHER, p_payload: sized(RPC_MAX + 1, '漢') }))).toEqual({
      status: 400,
      code: '22023',
      message: 'payload too large',
    })
  })

  it('counts the separators jsonb adds: JSON within the limit can be over it as jsonb text', async () => {
    // 1 + 2 bytes per item: `[1, 1, …]` is a third longer than `[1,1,…]`
    const items = Math.floor((RPC_MAX - 40) / 2)
    const payload = { expenses: Array.from({ length: items }, () => 1), x5: {} }
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(RPC_MAX)
    expect(jsonbTextBytes(payload)).toBeGreaterThan(RPC_MAX)
    expect(refusal(await push({ p_row: ROW, p_payload: payload })).message).toBe(
      'payload too large',
    )
  })
})

describe('table A: st_sync_push writes', () => {
  beforeEach(() => {
    migrate('004')
  })

  it('creates a missing row with p_base null; a second create is a conflict carrying the current token', async () => {
    const created = dataOf(await push({ p_row: ROW, p_payload: v5('a') }))
    expect(created).toEqual({ ok: true, updated_at: rowStamp(ROW) })
    const again = dataOf(await push({ p_row: ROW, p_payload: v5('b') }))
    expect(again).toEqual({ ok: false, reason: 'conflict', updated_at: rowStamp(ROW) })
    expect(rowPayload(ROW)).toEqual(v5('a'))
  })

  it('CAS on the current token (as an instant, in any zone) lands with a later token', async () => {
    seedRow(ROW, v5('a'))
    const current = rowStamp(ROW) ?? ''
    const t0 = stamp(current)
    // the same instant written another way: Z and six digits, as tok() sends it
    const res = dataOf(await push({ p_row: ROW, p_payload: v5('b'), p_base: zulu(t0) }))
    expect(res).toEqual({ ok: true, updated_at: rowStamp(ROW) })
    expect(stamp(rowStamp(ROW))).toBeGreaterThan(t0)
  })

  it('CAS on another token is a conflict with the current one; on a missing row it is missing', async () => {
    seedRow(ROW, v5('a'))
    const stale = '2026-01-01T00:00:00+00:00'
    const current = rowStamp(ROW)
    // older or later: only the exact token lands (an older build's upsert can move it back)
    for (const base of [stale, zulu(stamp(current) + 1), '2099-01-01T00:00:00+00:00']) {
      expect(dataOf(await push({ p_row: ROW, p_payload: v5('b'), p_base: base })), base).toEqual({
        ok: false,
        reason: 'conflict',
        updated_at: current,
      })
    }
    expect(dataOf(await push({ p_row: OTHER, p_payload: v5('b'), p_base: stale }))).toEqual({
      ok: false,
      reason: 'missing',
      updated_at: null,
    })
    expect(relay().rows.has(OTHER)).toBe(false)
    expect(rowPayload(ROW)).toEqual(v5('a'))
  })

  it('force overwrites an existing row with a later token and never creates one', async () => {
    expect(
      dataOf(await push({ p_row: ROW, p_payload: v5(), p_base: null, p_force: true })),
    ).toEqual({ ok: false, reason: 'missing', updated_at: null })
    expect(relay().rows.has(ROW)).toBe(false)
    seedRow(ROW, v5('a'))
    const before = stamp(rowStamp(ROW))
    const res = dataOf(
      await push({ p_row: ROW, p_payload: v5('b'), p_base: '2000-01-01T00:00:00Z', p_force: true }),
    )
    expect(res).toEqual({ ok: true, updated_at: rowStamp(ROW) })
    expect(stamp(rowStamp(ROW))).toBeGreaterThan(before)
  })

  it('AC-7: every write’s token is strictly after the previous one, also over a 2099 token', async () => {
    const future = '2099-01-01T00:00:00.123456+00:00'
    relay().rows.set(ROW, { payload: v5('a'), updated_at: future })
    const forced = dataOf(await push({ p_row: ROW, p_payload: v5('b'), p_force: true }))
    expect(forced).toEqual({ ok: true, updated_at: '2099-01-01T00:00:00.123457+00:00' })
    const cas = dataOf(
      await push({ p_row: ROW, p_payload: v5('c'), p_base: '2099-01-01T00:00:00.123457+00:00' }),
    )
    expect(cas).toEqual({ ok: true, updated_at: '2099-01-01T00:00:00.123458+00:00' })
  })

  it('AC-7: a non-finite token is ignored: the write gets the server clock', async () => {
    relay().rows.set(ROW, { payload: v5('a'), updated_at: 'infinity' })
    const before = Date.now() * 1000
    const res = dataOf(await push({ p_row: ROW, p_payload: v5('b'), p_base: 'infinity' }))
    expect(res).toMatchObject({ ok: true })
    expect(stamp(rowStamp(ROW))).toBeGreaterThanOrEqual(before)
  })

  it('AC-7: a base at the end of a year rolls into the next, and the fraction-less etag round-trips', async () => {
    relay().rows.set(ROW, { payload: v5('a'), updated_at: '2026-12-31T23:59:59.999999+00:00' })
    // a clock behind the base: the token is base + 1 µs, exactly midnight, with no fraction
    const res = dataOf(
      await push({ p_row: ROW, p_payload: v5('b'), p_base: '2026-12-31T23:59:59.999999+00:00' }),
    )
    expect(res).toEqual({ ok: true, updated_at: '2027-01-01T00:00:00+00:00' })
    const next = dataOf(
      await push({ p_row: ROW, p_payload: v5('c'), p_base: '2027-01-01T00:00:00+00:00' }),
    )
    expect(next).toEqual({ ok: true, updated_at: '2027-01-01T00:00:00.000001+00:00' })
  })

  it('AC-6: a full relay refuses a new row (500 53400, as PostgREST answers it), but a create of an existing row is a conflict', async () => {
    seedRow(ROW, v5('a'))
    relay().rpcFull = true
    expect(refusal(await push({ p_row: OTHER, p_payload: v5() }))).toMatchObject({
      status: 500,
      code: '53400',
    })
    expect(relay().rows.has(OTHER)).toBe(false)
    expect(dataOf(await push({ p_row: ROW, p_payload: v5('b') }))).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
  })

  it('AC-6: CAS and force on an existing row ignore the caps', async () => {
    seedRow(ROW, v5('a'))
    relay().rpcFull = true
    const base = rowStamp(ROW)
    expect(dataOf(await push({ p_row: ROW, p_payload: v5('b'), p_base: base }))).toMatchObject({
      ok: true,
    })
    expect(dataOf(await push({ p_row: ROW, p_payload: v5('c'), p_force: true }))).toMatchObject({
      ok: true,
    })
  })

  it('keeps working after 005: the functions are owned by the table owner', async () => {
    migrate('005')
    expect(dataOf(await push({ p_row: ROW, p_payload: v5() }))).toMatchObject({ ok: true })
    expect(dataOf(await head(ROW))).toBe(rowStamp(ROW))
    expect(dataOf(await pull(ROW))).toMatchObject({ payload: v5() })
  })
})

// ---------------------------------------------------------------------------
// Table B: the table, as anon
// ---------------------------------------------------------------------------

const upsert = (row: Record<string, unknown>) =>
  client().from(TABLE).upsert(row).select('updated_at')
const insert = (row: Record<string, unknown>) =>
  client().from(TABLE).insert(row).select('updated_at').single()
const update = (patch: Record<string, unknown>, id: string, base?: string) => {
  const match = client().from(TABLE).update(patch).eq('sync_id', id)
  return (base === undefined ? match : match.eq('updated_at', base)).select('updated_at')
}

const TOKEN = '2026-11-03T04:00:00.123456Z'

describe('table B before 004: the table takes anything (F-068 reproduced where modelled)', () => {
  it('stores a non-UUID id, a non-object payload and an infinity token', async () => {
    expect(
      (await upsert({ sync_id: 'not-a-uuid', payload: v4(), updated_at: TOKEN })).error,
    ).toBeNull()
    expect((await upsert({ sync_id: ROW, payload: [1, 2], updated_at: TOKEN })).error).toBeNull()
    expect((await upsert({ sync_id: OTHER, payload: v4(), updated_at: 'infinity' })).error).toBe(
      null,
    )
    expect(
      (await upsert({ sync_id: ROW, payload: sized(TABLE_MAX + 1), updated_at: TOKEN })).error,
    ).toBeNull()
    expect(relay().rows.size).toBe(3)
  })
})

describe('table B after 004: the write guards (23514), nothing written on a refusal', () => {
  beforeEach(() => {
    migrate('004')
  })

  it('AC-8: 0.8.x–0.11.0 writes still land: upsert, insert, CAS PATCH and forced PATCH', async () => {
    const up = await upsert({ sync_id: ROW, payload: v4(), updated_at: TOKEN })
    expect(up.error).toBeNull()
    expect(up.status).toBe(201)
    const base = rowStamp(ROW) ?? ''
    const cas = await update(
      { payload: v5(), updated_at: '2026-11-03T04:00:01.000000Z' },
      ROW,
      base,
    )
    expect(cas.data).toEqual([{ updated_at: rowStamp(ROW) }])
    const forced = await update({ payload: v5('f'), updated_at: '2026-11-03T04:00:02Z' }, ROW)
    expect(forced.data).toEqual([{ updated_at: rowStamp(ROW) }])
    const created = await insert({ sync_id: OTHER, payload: v5(), updated_at: TOKEN })
    expect(created.data).toEqual({ updated_at: rowStamp(OTHER) })
  })

  it.each([
    ['a non-UUID id', { sync_id: 'my-sync-code' }, 'sync_buckets_id_uuid'],
    ['an upper-case id', { sync_id: UPPER }, 'sync_buckets_id_uuid'],
    ['an array payload', { payload: [v4()] }, 'sync_buckets_payload_bounded'],
    ['a string payload', { payload: 'x' }, 'sync_buckets_payload_bounded'],
    ['an infinity token', { updated_at: 'infinity' }, 'sync_buckets_updated_at_finite'],
    ['a -infinity token', { updated_at: '-Infinity' }, 'sync_buckets_updated_at_finite'],
  ])('refuses an upsert or insert with %s', async (_label, over, constraint) => {
    const row = { sync_id: ROW, payload: v4(), updated_at: TOKEN, ...over }
    for (const res of [await upsert(row), await insert(row)]) {
      expect(refusal(res)).toEqual({
        status: 400,
        code: '23514',
        message: `new row for relation "sync_buckets" violates check constraint "${constraint}"`,
      })
    }
    expect(relay().rows.size).toBe(0)
    expect(relay().pushes).toHaveLength(0)
  })

  it('refuses a null payload as NOT NULL (23502), as it always has', async () => {
    expect(refusal(await upsert({ sync_id: ROW, payload: null, updated_at: TOKEN }))).toEqual({
      status: 400,
      code: '23502',
      message:
        'null value in column "payload" of relation "sync_buckets" violates not-null constraint',
    })
    expect(relay().rows.size).toBe(0)
  })

  it('accepts exactly 2,097,152 bytes of jsonb text and refuses one byte more', async () => {
    expect(
      (await upsert({ sync_id: ROW, payload: sized(TABLE_MAX), updated_at: TOKEN })).error,
    ).toBe(null)
    const over = await upsert({ sync_id: OTHER, payload: sized(TABLE_MAX + 1), updated_at: TOKEN })
    expect(refusal(over)).toMatchObject({ status: 400, code: '23514' })
    expect(relay().rows.has(OTHER)).toBe(false)
  })

  it('names the first violated check in name order (id before payload before token)', async () => {
    const res = await upsert({ sync_id: 'junk', payload: [], updated_at: 'infinity' })
    expect(refusal(res).message).toContain('"sync_buckets_id_uuid"')
    const res2 = await upsert({ sync_id: ROW, payload: [], updated_at: 'infinity' })
    expect(refusal(res2).message).toContain('"sync_buckets_payload_bounded"')
  })

  it('refuses a PATCH that would leave a bad row, but not one that matches no row', async () => {
    seedRow(ROW, v4())
    const before = rowStamp(ROW)
    expect(refusal(await update({ payload: [1], updated_at: TOKEN }, ROW))).toMatchObject({
      status: 400,
      code: '23514',
    })
    expect(rowPayload(ROW)).toEqual(v4())
    expect(rowStamp(ROW)).toBe(before)
    // a CAS that matches nothing changes no row, so no check runs: an empty answer, no error
    const miss = await update({ payload: [1], updated_at: TOKEN }, ROW, '2000-01-01T00:00:00Z')
    expect({ error: miss.error, data: miss.data }).toEqual({ error: null, data: [] })
    const none = await update({ payload: [1], updated_at: TOKEN }, OTHER)
    expect({ error: none.error, data: none.data }).toEqual({ error: null, data: [] })
  })

  it('refuses any write to a pre-004 junk row: its id fails the check on update', async () => {
    seedRow('legacy-code', v4())
    const res = await update({ payload: v4(), updated_at: TOKEN }, 'legacy-code')
    expect(refusal(res)).toMatchObject({ status: 400, code: '23514' })
  })

  it('lifts the guards again when 004 is rolled back', async () => {
    migrate('rollback 004')
    expect((await upsert({ sync_id: 'junk', payload: [1], updated_at: TOKEN })).error).toBeNull()
  })
})

describe('table B after 005: every table call is refused (401 42501)', () => {
  beforeEach(() => {
    migrate('004')
    migrate('005')
  })

  it('refuses select, upsert, insert and update; writes nothing', async () => {
    seedRow(ROW, v5())
    const before = { payload: rowPayload(ROW), stamp: rowStamp(ROW) }
    const answers = [
      await client().from(TABLE).select('updated_at').eq('sync_id', ROW).maybeSingle(),
      await client().from(TABLE).select('payload,updated_at').eq('sync_id', ROW).maybeSingle(),
      await upsert({ sync_id: ROW, payload: v5('x'), updated_at: TOKEN }),
      await insert({ sync_id: OTHER, payload: v5('x'), updated_at: TOKEN }),
      await update({ payload: v5('x'), updated_at: TOKEN }, ROW),
    ]
    for (const res of answers) {
      expect(refusal(res)).toEqual({
        status: 401,
        code: '42501',
        message: 'permission denied for table sync_buckets',
      })
    }
    expect({ payload: rowPayload(ROW), stamp: rowStamp(ROW) }).toEqual(before)
    expect(relay().rows.has(OTHER)).toBe(false)
  })

  it('refuses row events (the table left the realtime publication)', () => {
    expect(relay().rowEvents).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// Table C: states and guards
// ---------------------------------------------------------------------------

describe('table C: the migration states', () => {
  const state = () => ({
    rpc: relay().rpc,
    lockdown: relay().lockdown,
    rowEvents: relay().rowEvents,
  })
  const before004 = { rpc: 'absent', lockdown: false, rowEvents: 'on' }
  const after004 = { rpc: 'present', lockdown: false, rowEvents: 'on' }
  const after005 = { rpc: 'present', lockdown: true, rowEvents: 'rejected' }

  it('005 is refused (55000, nothing changed) unless 004 is applied', () => {
    expect(state()).toEqual(before004)
    expect(() => {
      migrate('005')
    }).toThrow(/55000.*Apply 004/)
    expect(state()).toEqual(before004)
  })

  it('the 004 rollback is refused (55000, nothing changed) while 005 is applied', () => {
    migrate('004')
    migrate('005')
    expect(() => {
      migrate('rollback 004')
    }).toThrow(/55000.*Roll back 005 first/)
    expect(state()).toEqual(after005)
  })

  it('every step is idempotent, and the full cycle returns to each state', () => {
    for (const [step, expected] of [
      ['004', after004],
      ['004', after004],
      ['005', after005],
      ['005', after005],
      ['rollback 005', after004],
      ['rollback 005', after004],
      ['rollback 004', before004],
      ['rollback 004', before004],
      ['004', after004],
      ['005', after005],
    ] as const) {
      migrate(step)
      expect(state(), step).toEqual(expected)
    }
  })

  it('no step touches a row', () => {
    seedRow(ROW, v5())
    seedRow('legacy-code', v4())
    const snapshot = () => JSON.stringify([...relay().rows.entries()])
    const before = snapshot()
    for (const step of ['004', '005', 'rollback 005', 'rollback 004'] as const) {
      migrate(step)
      expect(snapshot(), step).toBe(before)
    }
    expect(requestsOf('rpc')).toHaveLength(0)
    expect(relay().pushes).toHaveLength(0)
  })
})
