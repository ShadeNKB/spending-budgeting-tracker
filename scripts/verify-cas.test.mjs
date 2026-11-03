// @vitest-environment node
// scripts/verify-cas.mjs (DATA-ENGINE-SPEC §18.1, PR-5 track spec §3.8), end to end with real
// fetch against the data-engine e2e relay on an ephemeral port, and that relay held to the PR-5
// contract (§3.10, §4 tables A to C): what migrations 004 and 005 really do. The script is never
// run against a real project here. Invented data and keys only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { jsonbTextBytes, startRelay } from '../e2e/data-engine/support/relayServer.ts'
import {
  LOCKDOWN_ROW,
  OLD_FORMAT,
  PAYLOAD,
  checkKey,
  checkRow,
  checkUrl,
  run,
  sameInstant,
  secondRow,
} from './verify-cas.mjs'

// Real sockets: a refused connection to localhost can take a few seconds on Windows.
vi.setConfig({ testTimeout: 20_000 })

const RPC_MAX = 1_258_291
const TABLE_MAX = 2_097_152
const ROW = '00000000-0000-4000-8000-202611030001'
/** An owner-like row: a real-looking code and v5 payload, which no run may touch or print. */
const OWNER = '7c0f4e1a-93b2-4d6e-a1f8-5b2c9d0e3f47'
const CANARY = 'CANARY-kaya-toast-0311'
const ownerPayload = {
  version: '4.0',
  exportDate: '2026-11-03T04:00:00.000Z',
  expenses: [
    { id: 'e1', itemName: CANARY, amount: 4.2, category: 'Meals', date: '2026-11-03T12:00:00' },
  ],
  deletedIds: [],
  x5: { schema: 5, rev: 'r1' },
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** An unsigned JWT with these claims (the script reads the role claim; it never verifies). */
const jwt = (claims) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.aW52ZW50ZWQtc2lnbmF0dXJl`
const claims = { iss: 'supabase', ref: 'inventedref000000', iat: 1_760_000_000, exp: 4_102_444_800 }
const ANON = jwt({ ...claims, role: 'anon' })
const SERVICE = jwt({ ...claims, role: 'service_role' })
const PUBLISHABLE = 'sb_publishable_InventedKeyForTests_0123456789'
const SECRET = 'sb_secret_InventedKeyForTests_0123456789'

/** @type {import('../e2e/data-engine/support/relayServer.ts').Relay} */
let relay

beforeAll(async () => {
  relay = await startRelay(0)
})

afterAll(async () => {
  await relay.close()
})

const ownerSnapshot = () => JSON.stringify(relay.row(OWNER))
let ownerBefore = ''

beforeEach(() => {
  relay.reset()
  relay.put(OWNER, ownerPayload)
  ownerBefore = ownerSnapshot()
})

// The owner-like row is byte-identical after every test: no run, check or refusal touches it.
afterEach(() => {
  expect(ownerSnapshot()).toBe(ownerBefore)
})

/**
 * Runs the script's `run()` against the relay and captures what it printed. `env` overrides the
 * two variables (undefined removes one).
 */
async function verify(argv, { env = {}, fetch = globalThis.fetch, timeoutMs } = {}) {
  let out = ''
  let err = ''
  const code = await run({
    argv,
    env: { ST_VERIFY_URL: relay.origin, ST_VERIFY_ANON_KEY: ANON, ...env },
    fetch,
    out: { write: (text) => (out += text) },
    err: { write: (text) => (err += text) },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  const all = out + err
  return { code, out, err, all, lines: all.trimEnd().split('\n') }
}

/** Nothing a run prints may hold a key, the owner's code or the owner's data. */
function expectNothingLeaked(all) {
  for (const secret of [ANON, SERVICE, SECRET, PUBLISHABLE, ANON.split('.')[1], OWNER, CANARY]) {
    expect(all).not.toContain(secret)
  }
}

const http = async (method, path, body, headers = {}) => {
  const res = await fetch(`${relay.origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

const rpc = (fn, args) => http('POST', `/rest/v1/rpc/${fn}`, args)
const push = (args) => rpc('st_sync_push', { p_base: null, p_force: false, ...args })
const upsert = (row) =>
  http('POST', '/rest/v1/sync_buckets?select=updated_at', row, {
    Prefer: 'resolution=merge-duplicates,return=representation',
  })
const insert = (row) =>
  http('POST', '/rest/v1/sync_buckets?select=updated_at', row, {
    Prefer: 'return=representation',
  })
const patch = (id, body, base) =>
  http(
    'PATCH',
    `/rest/v1/sync_buckets?sync_id=eq.${id}${
      base === undefined ? '' : `&updated_at=eq.${encodeURIComponent(base)}`
    }&select=updated_at`,
    body,
    { Prefer: 'return=representation' },
  )

/** `{"expenses": [], "x5": {}, "pad": "…"}` with jsonb text of exactly `bytes` (37 + the pad). */
function sized(bytes, unit = 'x') {
  const room = bytes - 37
  const per = unit === 'x' ? 1 : 3
  return { expenses: [], x5: {}, pad: unit.repeat(Math.floor(room / per)) + 'x'.repeat(room % per) }
}

const TOKEN = '2026-11-03T04:00:00.123456Z'
/** An etag older than any the relay hands out in a run. */
const OLD_ETAG = '2000-01-01T00:00:00+00:00'

/**
 * A relay that answers one request wrongly: the first request `pick(url, method)` chooses reaches
 * the real relay, and its JSON body is replaced by `edit(body)` (same status and headers).
 */
function tampering(pick, edit) {
  let done = false
  return async (input, init) => {
    const res = await fetch(input, init)
    if (done || !pick(new URL(String(input)), init?.method ?? 'GET')) return res
    done = true
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    const body = JSON.stringify(edit(JSON.parse(await res.text())))
    return new Response(body, { status: res.status, headers })
  }
}
const writesSince = (n) => relay.log.slice(n).filter((q) => relay.pushes().includes(q))

// ---------------------------------------------------------------------------
// The relay against the PR-5 contract (AC-19, AC-20)
// ---------------------------------------------------------------------------

describe('relayServer: the ephemeral port', () => {
  it('startRelay(0) binds a free port and reports it as its origin', async () => {
    expect(relay.origin).toMatch(/^http:\/\/localhost:\d+$/)
    const port = Number(new URL(relay.origin).port)
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(4219)
    expect((await rpc('st_sync_head', { p_row: ROW })).status).toBe(404) // its own, before 004
  })
})

describe('relayServer: jsonb text bytes (§3.10 vectors)', () => {
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
  ])('%s is %i bytes', (text, bytes) => {
    expect(jsonbTextBytes(JSON.parse(text))).toBe(bytes)
  })
})

describe('relayServer table A: st_sync_push', () => {
  beforeEach(() => {
    relay.enableRpc()
  })

  it('AC-5: accepts exactly 1,258,291 bytes of jsonb text and refuses 1,258,292 (22023)', async () => {
    expect((await push({ p_row: ROW, p_payload: sized(RPC_MAX) })).body).toMatchObject({ ok: true })
    const over = await push({ p_row: LOCKDOWN_ROW, p_payload: sized(RPC_MAX + 1) })
    expect(over).toEqual({
      status: 400,
      body: { code: '22023', details: null, hint: null, message: 'payload too large' },
    })
    expect(relay.row(LOCKDOWN_ROW)).toBeNull()
  })

  it('AC-5: counts bytes, not characters (CJK)', async () => {
    const atLimit = sized(RPC_MAX, '漢')
    expect(JSON.stringify(atLimit).length).toBeLessThan(RPC_MAX / 2)
    expect((await push({ p_row: ROW, p_payload: atLimit })).body).toMatchObject({ ok: true })
    const over = await push({ p_row: LOCKDOWN_ROW, p_payload: sized(RPC_MAX + 1, '漢') })
    expect(over.body).toMatchObject({ code: '22023', message: 'payload too large' })
  })

  it('validates in 004’s order: row id, payload, size, shape', async () => {
    const msg = async (args) => (await push(args)).body.message
    expect(await msg({ p_row: 'not-a-uuid', p_payload: [] })).toBe('invalid row id')
    expect(
      await msg({ p_row: ROW.toUpperCase().replace('0001', '00AB'), p_payload: PAYLOAD }),
    ).toBe('invalid row id')
    expect(await msg({ p_row: ROW, p_payload: [] })).toBe('invalid payload')
    expect(await msg({ p_row: ROW, p_payload: { pad: 'x'.repeat(RPC_MAX) } })).toBe(
      'payload too large',
    )
    expect(await msg({ p_row: ROW, p_payload: OLD_FORMAT })).toBe('invalid payload shape')
    expect(await msg({ p_row: ROW, p_payload: { st: '5', iv: 'a', ct: 'b' } })).toBe(
      'invalid payload shape',
    )
  })

  it('head and pull answer null for an id that is not a lower-case UUID', async () => {
    relay.put('legacy-code', PAYLOAD)
    for (const id of ['legacy-code', null, 'ABCDEF12-3456-4789-8ABC-DEF123456789']) {
      expect(await rpc('st_sync_head', { p_row: id })).toEqual({ status: 200, body: null })
      expect(await rpc('st_sync_pull', { p_row: id })).toEqual({ status: 200, body: null })
    }
  })

  it('AC-7: a forced or CAS write’s token is after the current one, also over a 2099 token', async () => {
    const up = await upsert({
      sync_id: ROW,
      payload: PAYLOAD,
      updated_at: '2099-01-01T00:00:00.123456Z',
    })
    expect(up.body).toEqual([{ updated_at: '2099-01-01T00:00:00.123456+00:00' }])
    const forced = await push({ p_row: ROW, p_payload: PAYLOAD, p_force: true })
    expect(forced.body).toEqual({ ok: true, updated_at: '2099-01-01T00:00:00.123457+00:00' })
    const cas = await push({ p_row: ROW, p_payload: PAYLOAD, p_base: forced.body.updated_at })
    expect(cas.body).toEqual({ ok: true, updated_at: '2099-01-01T00:00:00.123458+00:00' })
  })

  it('force never creates; a create of an existing row is a conflict with the current token', async () => {
    const forced = await push({ p_row: ROW, p_payload: PAYLOAD, p_base: TOKEN, p_force: true })
    expect(forced.body).toEqual({ ok: false, reason: 'missing', updated_at: null })
    expect(relay.row(ROW)).toBeNull()
    const created = await push({ p_row: ROW, p_payload: PAYLOAD })
    const again = await push({ p_row: ROW, p_payload: PAYLOAD })
    expect(again.body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: created.body.updated_at,
    })
  })
})

describe('relayServer table B: the table, as anon', () => {
  it('before 004 takes a non-UUID id, an array payload and lists every row (F-006)', async () => {
    expect((await upsert({ sync_id: 'legacy-code', payload: [1], updated_at: TOKEN })).status).toBe(
      201,
    )
    const listed = await http('GET', '/rest/v1/sync_buckets?select=sync_id&limit=1')
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
  })

  it.each([
    ['a non-UUID id', { sync_id: 'legacy-code' }, 'sync_buckets_id_uuid'],
    [
      'an upper-case id',
      { sync_id: 'ABCDEF12-3456-4789-8ABC-DEF123456789' },
      'sync_buckets_id_uuid',
    ],
    ['an array payload', { payload: [PAYLOAD] }, 'sync_buckets_payload_bounded'],
    ['an infinity token', { updated_at: 'infinity' }, 'sync_buckets_updated_at_finite'],
  ])(
    'after 004 refuses an upsert or insert with %s (400 23514), writing nothing',
    async (_l, over, name) => {
      relay.enableRpc()
      const row = { sync_id: ROW, payload: PAYLOAD, updated_at: TOKEN, ...over }
      for (const res of [await upsert(row), await insert(row)]) {
        expect(res).toEqual({
          status: 400,
          body: {
            code: '23514',
            details: null,
            hint: null,
            message: `new row for relation "sync_buckets" violates check constraint "${name}"`,
          },
        })
      }
      expect(relay.row(ROW)).toBeNull()
      expect(relay.writes()).toHaveLength(0) // nothing landed
    },
  )

  it('after 004 refuses a null payload as NOT NULL (23502) and a PATCH that leaves a bad row', async () => {
    relay.enableRpc()
    expect((await upsert({ sync_id: ROW, payload: null, updated_at: TOKEN })).body.code).toBe(
      '23502',
    )
    expect((await insert({ sync_id: ROW, payload: PAYLOAD, updated_at: TOKEN })).status).toBe(201)
    const before = JSON.stringify(relay.row(ROW))
    const bad = await patch(ROW, { payload: PAYLOAD, updated_at: 'Infinity' })
    expect(bad.body).toMatchObject({ code: '23514' })
    const stale = await patch(ROW, { payload: [1], updated_at: TOKEN }, '2000-01-01T00:00:00Z')
    expect(stale).toEqual({ status: 200, body: [] }) // no row matched: no check ran
    expect(JSON.stringify(relay.row(ROW))).toBe(before)
  })

  it('after 004 takes exactly 2,097,152 bytes of jsonb text and refuses one more', async () => {
    relay.enableRpc()
    expect(
      (await upsert({ sync_id: ROW, payload: sized(TABLE_MAX), updated_at: TOKEN })).status,
    ).toBe(201)
    const over = await upsert({
      sync_id: LOCKDOWN_ROW,
      payload: sized(TABLE_MAX + 1),
      updated_at: TOKEN,
    })
    expect(over.body).toMatchObject({ code: '23514' })
  })

  it('after the 004 rollback the guards are gone again', async () => {
    relay.enableRpc()
    relay.disableRpc()
    expect((await upsert({ sync_id: 'legacy-code', payload: [1], updated_at: TOKEN })).status).toBe(
      201,
    )
  })

  it('after 005 refuses every table call (401 42501) while the functions keep working', async () => {
    relay.enableRpc()
    relay.lockTable()
    const denied = {
      status: 401,
      body: {
        code: '42501',
        details: null,
        hint: null,
        message: 'permission denied for table sync_buckets',
      },
    }
    expect(await http('GET', '/rest/v1/sync_buckets?select=sync_id&limit=1')).toEqual(denied)
    expect(
      await http('GET', `/rest/v1/sync_buckets?select=updated_at&sync_id=eq.${OWNER}`),
    ).toEqual(denied)
    expect(await upsert({ sync_id: ROW, payload: PAYLOAD, updated_at: TOKEN })).toEqual(denied)
    expect(await insert({ sync_id: ROW, payload: PAYLOAD, updated_at: TOKEN })).toEqual(denied)
    expect(await patch(OWNER, { payload: PAYLOAD, updated_at: TOKEN })).toEqual(denied)
    expect((await push({ p_row: ROW, p_payload: PAYLOAD })).body).toMatchObject({ ok: true })
    expect((await rpc('st_sync_head', { p_row: ROW })).status).toBe(200)
  })
})

describe('relayServer table C: the states', () => {
  it('refuses the lockdown without 004, and the 004 rollback under the lockdown (55000)', () => {
    expect(() => {
      relay.lockTable()
    }).toThrow(/55000.*Apply 004/)
    relay.enableRpc()
    relay.lockTable()
    expect(() => {
      relay.disableRpc()
    }).toThrow(/55000.*Roll back 005 first/)
    relay.unlockTable()
    relay.disableRpc()
  })
})

// ---------------------------------------------------------------------------
// The script's pure parts
// ---------------------------------------------------------------------------

describe('checkUrl, checkKey, checkRow', () => {
  it.each([
    ['https://abcdefghijklmnop.supabase.co', null],
    ['https://abcdefghijklmnop.supabase.co/', null],
    ['http://localhost:54321', null],
    ['http://127.0.0.1:54321', null],
    ['http://[::1]:54321', null],
    [undefined, 'ST_VERIFY_URL is not set'],
    ['', 'ST_VERIFY_URL is not set'],
    ['not a url', 'ST_VERIFY_URL is not a URL'],
    ['http://abcdefghijklmnop.supabase.co', 'ST_VERIFY_URL must start with https://'],
    ['ftp://localhost', 'ST_VERIFY_URL must start with https://'],
    ['https://abcdefghijklmnop.supabase.co/rest/v1', 'must be the project URL alone'],
    ['https://abcdefghijklmnop.supabase.co?x=1', 'must be the project URL alone'],
    ['https://user:pw@abcdefghijklmnop.supabase.co', 'must not carry a user name or password'],
  ])('%s', (url, problem) => {
    const checked = checkUrl(url)
    if (problem === null) expect(checked).toHaveProperty('origin')
    else expect(checked.refused).toContain(problem)
  })

  it.each([
    [ANON, null],
    [PUBLISHABLE, null],
    ['', 'ST_VERIFY_ANON_KEY is not set'],
    [SECRET, 'a secret key'],
    [SERVICE, 'the service_role key'],
    [jwt({ ...claims, role: 'authenticated' }), 'the authenticated key'],
    [jwt({ ...claims }), 'not an anon key'],
    ['not-a-key', 'not an anon key'],
    ['a.b.c', 'not an anon key'],
  ])('key %#', (key, problem) => {
    if (problem === null) expect(checkKey(key)).toBeNull()
    else expect(checkKey(key)).toContain(problem)
  })

  it.each([
    ['00000000-0000-4000-8000-202611030001', null],
    ['00000000-0000-4000-8000-abcdef012345', null],
    [null, '--row is missing'],
    ['00000000-0000-4000-8000-ABCDEF012345', 'lower case'],
    ['7c0f4e1a-93b2-4d6e-a1f8-5b2c9d0e3f47', 'throwaway id'],
    ['00000000-0000-4000-8000-2026110300', 'throwaway id'],
    ['00000000-0000-4000-8000-2026110300011', 'throwaway id'],
  ])('row %s', (row, problem) => {
    if (problem === null) expect(checkRow(row)).toBeNull()
    else expect(checkRow(row)).toContain(problem)
  })

  it('pairs each throwaway id with another throwaway id', () => {
    expect(secondRow(ROW)).toBe('00000000-0000-4000-8000-dfd9eefcfffe')
    expect(secondRow('00000000-0000-4000-8000-ffffffffffff')).toBe(LOCKDOWN_ROW)
    expect(checkRow(secondRow(ROW))).toBeNull()
  })

  it('compares etags as instants', () => {
    expect(sameInstant('2026-11-03T04:00:00.1+00:00', '2026-11-03T12:00:00.100000+08:00')).toBe(
      true,
    )
    expect(sameInstant('2026-11-03T04:00:00+00:00', '2026-11-03T04:00:00.000001Z')).toBe(false)
    expect(sameInstant(null, null)).toBe(false)
    expect(sameInstant('x', 'x')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// run(): refusals (AC-21: exit 2 before any write, the key never printed)
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it.each([
    [
      'ST_VERIFY_URL missing',
      ['--row', ROW],
      { ST_VERIFY_URL: undefined },
      'ST_VERIFY_URL is not set',
    ],
    [
      'ST_VERIFY_ANON_KEY missing',
      ['--row', ROW],
      { ST_VERIFY_ANON_KEY: undefined },
      'ST_VERIFY_ANON_KEY is not set',
    ],
    [
      'a plain-http remote URL',
      ['--row', ROW],
      { ST_VERIFY_URL: 'http://abcdefghijklmnop.supabase.co' },
      'https://',
    ],
    ['a secret key', ['--row', ROW], { ST_VERIFY_ANON_KEY: SECRET }, 'a secret key'],
    ['a service_role key', ['--row', ROW], { ST_VERIFY_ANON_KEY: SERVICE }, 'the service_role key'],
    [
      'a key of no known kind',
      ['--row', ROW],
      { ST_VERIFY_ANON_KEY: 'not-a-key' },
      'not an anon key',
    ],
    ['no --row', [], {}, '--row is missing'],
    ['an upper-case row', ['--row', ROW.replace('0001', '00AB')], {}, 'lower case'],
    ['a row outside the throwaway range', ['--row', OWNER], {}, 'throwaway id'],
    ['an unknown option', ['--row', ROW, '--force'], {}, 'unknown option --force'],
    ['--row with no id', ['--row'], {}, '--row needs an id'],
    ['a bad --row in lockdown mode', ['--lockdown', '--row', 'abc'], {}, 'throwaway id'],
    [
      'only the app’s own variables (never read)',
      ['--row', ROW],
      {
        ST_VERIFY_URL: undefined,
        ST_VERIFY_ANON_KEY: undefined,
        VITE_SUPABASE_URL: 'http://localhost:1',
        VITE_SUPABASE_ANON_KEY: ANON,
      },
      'ST_VERIFY_URL is not set',
    ],
  ])('%s: exit 2, no request at all', async (_label, argv, env, why) => {
    const before = relay.log.length
    const res = await verify(argv, { env })
    expect(res.code).toBe(2)
    expect(res.err).toMatch(
      new RegExp(
        `^REFUSED: .*${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\. Nothing was written\\.\\n$`,
      ),
    )
    expect(res.out).toBe('')
    expect(relay.log.length).toBe(before)
    expectNothingLeaked(res.all)
  })

  it('refuses a row that already exists, after one read and no write', async () => {
    relay.put(ROW, PAYLOAD)
    const before = relay.log.length
    const stored = JSON.stringify(relay.row(ROW))
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(2)
    expect(res.err).toContain(`REFUSED: row ${ROW} already exists`)
    expect(res.err).toContain('Nothing was written.')
    expect(relay.log.slice(before).map((q) => [q.method, q.kind])).toEqual([['GET', 'pull']])
    expect(JSON.stringify(relay.row(ROW))).toBe(stored)
    expectNothingLeaked(res.all)
  })

  it('refuses a rerun with the same id (the first run’s row exists)', async () => {
    expect((await verify(['--row', ROW])).code).toBe(0)
    const writes = relay.pushes().length
    const again = await verify(['--row', ROW])
    expect(again.code).toBe(2)
    expect(again.err).toContain('already exists')
    expect(relay.pushes()).toHaveLength(writes)
  })

  it('prints the usage for --help and exits 0 without a request', async () => {
    const before = relay.log.length
    const res = await verify(['--help'], { env: { ST_VERIFY_URL: undefined } })
    expect(res.code).toBe(0)
    expect(res.out).toContain('node scripts/verify-cas.mjs --row 00000000-0000-4000-8000-')
    expect(relay.log.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// run(): the CAS check (AC-21)
// ---------------------------------------------------------------------------

describe('CAS mode', () => {
  it('passes a–d and skips e–j before 004; writes only the throwaway row, by insert and PATCH', async () => {
    const owner = ownerSnapshot()
    const before = relay.log.length
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(0)
    const host = new URL(relay.origin).host
    expect(res.lines[0]).toBe(`verify-cas: ${host}  row ${ROW}`)
    expect(res.lines.slice(1).map((l) => l.slice(0, 7))).toEqual([
      'PASS a.',
      'PASS b.',
      'PASS c.',
      'PASS d.',
      'SKIP e–',
      'RESULT:',
    ])
    expect(res.lines).toContain('SKIP e–j. sync functions not found (apply 004 first)')
    expect(res.lines.at(-1)).toBe('RESULT: PASS (4/4). Safe to set VITE_SYNC_CAS=on.')
    expect(res.err).toBe('')
    const sent = relay.log.slice(before)
    const writes = sent.filter((q) => ['push', 'insert', 'update'].includes(q.kind))
    expect(writes.map((q) => [q.kind, q.syncId, q.outcome])).toEqual([
      ['insert', ROW, 'ok'],
      ['update', ROW, 'ok'],
      ['update', ROW, 'conflict'],
    ])
    // every PATCH named its base verbatim, as PostgREST printed it (µs, +00:00)
    expect(
      writes.slice(1).every((q) => typeof q.base === 'string' && q.base.endsWith('+00:00')),
    ).toBe(true)
    expect(writes[2]?.base).toBe(writes[1]?.base) // (c) reused the old etag
    expect(relay.row(ROW)?.payload).toEqual(PAYLOAD)
    expect(ownerSnapshot()).toBe(owner)
    expectNothingLeaked(res.all)
  })

  it('passes a–j after 004, over the sync functions with 0.11.0’s exact arguments', async () => {
    relay.enableRpc()
    const owner = ownerSnapshot()
    const before = relay.log.length
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(0)
    expect(res.lines.slice(1, -1).map((l) => l.slice(0, 7))).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((c) => `PASS ${c}.`),
    )
    expect(res.lines.at(-1)).toBe('RESULT: PASS (10/10). Safe to set VITE_SYNC_CAS=on.')
    const calls = relay.log.slice(before).filter((q) => q.kind === 'rpc')
    expect(calls.map((q) => [q.fn, q.syncId, q.outcome])).toEqual([
      ['st_sync_head', ROW, 'ok'],
      ['st_sync_push', ROW, 'ok'],
      ['st_sync_push', ROW, 'conflict'],
      ['st_sync_pull', ROW, 'ok'],
      ['st_sync_push', ROW, 'invalid'],
      ['st_sync_head', secondRow(ROW), 'missing'],
      ['st_sync_push', secondRow(ROW), 'missing'],
      ['st_sync_head', secondRow(ROW), 'missing'],
    ])
    expect(relay.row(secondRow(ROW))).toBeNull() // (j) created nothing
    expect(relay.requests('push')).toEqual([]) // never an upsert
    expect(ownerSnapshot()).toBe(owner)
    expectNothingLeaked(res.all)
  })

  it('skips only j when the second throwaway id exists, and leaves it alone', async () => {
    relay.enableRpc()
    relay.put(secondRow(ROW), PAYLOAD)
    const second = JSON.stringify(relay.row(secondRow(ROW)))
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(0)
    expect(res.lines).toContain(`SKIP j. the second throwaway id ${secondRow(ROW)} exists`)
    expect(res.lines.at(-1)).toBe('RESULT: PASS (9/9). Safe to set VITE_SYNC_CAS=on.')
    expect(JSON.stringify(relay.row(secondRow(ROW)))).toBe(second)
  })

  it('fails c, and stops writing, when the server ignores the old etag', async () => {
    // a broken relay: it drops the updated_at condition from every PATCH
    const noCas = (input, init) => {
      const url = new URL(String(input))
      if (init?.method === 'PATCH') url.searchParams.delete('updated_at')
      return fetch(url, init)
    }
    const res = await verify(['--row', ROW], { fetch: noCas })
    expect(res.code).toBe(1)
    expect(res.lines.at(-2)).toBe(
      'FAIL c. a write based on the old etag changed 1 row (compare-and-set is not enforced)',
    )
    expect(res.lines.at(-1)).toBe(
      'RESULT: FAIL (1 of 3 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    )
    expect(res.all).not.toContain('RESULT: PASS')
  })

  it('fails d, and stops writing, when an update hands back an etag that is not later', async () => {
    relay.enableRpc()
    // the relay's answer to the first PATCH (check b) names an old etag
    const fetchOld = tampering(
      (url, method) => method === 'PATCH' && url.pathname === '/rest/v1/sync_buckets',
      () => [{ updated_at: OLD_ETAG }],
    )
    const before = relay.log.length
    const res = await verify(['--row', ROW], { fetch: fetchOld })
    expect(res.code).toBe(1)
    expect(res.lines.slice(1, 4).map((l) => l.slice(0, 7))).toEqual([
      'PASS a.',
      'PASS b.',
      'PASS c.',
    ])
    expect(res.lines.at(-2)).toMatch(
      /^FAIL d\. the new etag 2000-01-01T00:00:00\+00:00 is not later than \d{4}-\d{2}-\d{2}T/,
    )
    expect(res.lines.at(-1)).toBe(
      'RESULT: FAIL (1 of 4 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    )
    expect(relay.log.slice(before).filter((q) => q.kind === 'rpc')).toEqual([])
  })

  it('fails e, and stops writing, when st_sync_head names another instant', async () => {
    relay.enableRpc()
    const fetchOther = tampering(
      (url) => url.pathname === '/rest/v1/rpc/st_sync_head',
      () => OLD_ETAG,
    )
    const before = relay.log.length
    const res = await verify(['--row', ROW], { fetch: fetchOther })
    expect(res.code).toBe(1)
    expect(res.lines.at(-2)).toMatch(
      /^FAIL e\. st_sync_head returned "2000-01-01T00:00:00\+00:00", expected \d{4}-\d{2}-\d{2}T/,
    )
    expect(res.lines.at(-1)).toBe(
      'RESULT: FAIL (1 of 5 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    )
    const calls = relay.log.slice(before).filter((q) => q.kind === 'rpc')
    expect(calls.map((q) => q.fn)).toEqual(['st_sync_head'])
  })

  it('passes e when st_sync_head prints the same instant another way (Z, not +00:00)', async () => {
    relay.enableRpc()
    const fetchZulu = tampering(
      (url) => url.pathname === '/rest/v1/rpc/st_sync_head',
      (etag) => String(etag).replace('+00:00', 'Z'),
    )
    const res = await verify(['--row', ROW], { fetch: fetchZulu })
    expect(res.code).toBe(0)
    expect(res.lines).toContain('PASS e. st_sync_head returns the current etag')
    expect(res.lines.at(-1)).toBe('RESULT: PASS (10/10). Safe to set VITE_SYNC_CAS=on.')
  })

  it('fails h, and stops writing, when st_sync_pull returns another payload', async () => {
    relay.enableRpc()
    const fetchChanged = tampering(
      (url) => url.pathname === '/rest/v1/rpc/st_sync_pull',
      (body) => ({ ...body, payload: { ...body.payload, note: 'changed by the relay' } }),
    )
    const before = relay.log.length
    const res = await verify(['--row', ROW], { fetch: fetchChanged })
    expect(res.code).toBe(1)
    expect(res.lines.at(-2)).toBe(
      'FAIL h. st_sync_pull did not return the payload and the current etag',
    )
    expect(res.lines.at(-1)).toBe(
      'RESULT: FAIL (1 of 8 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    )
    const calls = relay.log.slice(before).filter((q) => q.kind === 'rpc')
    expect(calls.map((q) => q.fn).at(-1)).toBe('st_sync_pull')
    expect(relay.row(ROW)?.payload).toEqual(PAYLOAD)
  })

  it('fails a with "use --lockdown" after 005, writing nothing', async () => {
    relay.enableRpc()
    relay.lockTable()
    const writes = relay.pushes().length
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(1)
    expect(res.lines.slice(1)).toEqual([
      'FAIL a. the table is locked (005 applied); use --lockdown',
      'RESULT: FAIL (1 of 1 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    ])
    expect(relay.pushes()).toHaveLength(writes)
  })
})

// ---------------------------------------------------------------------------
// run(): the lockdown check (read-only)
// ---------------------------------------------------------------------------

describe('lockdown mode', () => {
  it('passes when the table is locked and the functions answer; sends no write', async () => {
    relay.enableRpc()
    relay.lockTable()
    const before = relay.log.length
    const res = await verify(['--lockdown'])
    expect(res.code).toBe(0)
    expect(res.lines[0]).toBe(`verify-cas: ${new URL(relay.origin).host}  row ${LOCKDOWN_ROW}`)
    expect(res.lines.slice(1).map((l) => l.slice(0, 7))).toEqual(['PASS l.', 'PASS m.', 'RESULT:'])
    expect(res.lines.at(-1)).toBe('RESULT: PASS (2/2). The lockdown holds.')
    const sent = relay.log.slice(before)
    expect(sent.map((q) => [q.kind, q.fn ?? null, q.outcome])).toEqual([
      ['list', null, 'denied'],
      ['rpc', 'st_sync_head', 'missing'],
    ])
    expect(writesSince(before)).toEqual([])
  })

  it('fails l when the table still lists rows, without printing any of them', async () => {
    relay.enableRpc()
    const res = await verify(['--lockdown', '--row', ROW])
    expect(res.code).toBe(1)
    expect(res.lines).toContain(
      'FAIL l. the table still lists rows (HTTP 200); the lockdown is not applied',
    )
    expect(res.lines.at(-1)).toBe(
      'RESULT: FAIL (1 of 2 failed). The lockdown does not hold. Paste this output to the lead.',
    )
    expectNothingLeaked(res.all)
  })

  it.each([
    [500, { code: 'XX000', message: 'internal error' }],
    [404, { code: 'PGRST125', message: 'Invalid path specified in request URL' }],
    [400, { code: '42P01', message: 'relation does not exist' }],
  ])('fails l on any other refusal of the listing (HTTP %i)', async (status, error) => {
    relay.enableRpc()
    relay.lockTable()
    const answer = (input, init) =>
      new URL(String(input)).pathname === '/rest/v1/sync_buckets'
        ? Promise.resolve(
            new Response(JSON.stringify({ details: null, hint: null, ...error }), {
              status,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : fetch(input, init)
    const res = await verify(['--lockdown'], { fetch: answer })
    expect(res.code).toBe(1)
    expect(res.lines.slice(1)).toEqual([
      `FAIL l. unexpected answer (HTTP ${status}, ${error.code}: ${error.message})`,
      'PASS m. st_sync_head answers (HTTP 200)',
      'RESULT: FAIL (1 of 2 failed). The lockdown does not hold. Paste this output to the lead.',
    ])
  })

  it('fails m too when the functions are missing', async () => {
    const res = await verify(['--lockdown'])
    expect(res.code).toBe(1)
    expect(res.lines).toContain(
      'FAIL m. st_sync_head is missing (HTTP 404, PGRST202); apply 004 first',
    )
    expect(res.lines.at(-1)).toMatch(/^RESULT: FAIL \(2 of 2 failed\)/)
  })
})

// ---------------------------------------------------------------------------
// run(): network failures (exit 1, never PASS)
// ---------------------------------------------------------------------------

describe('network failures', () => {
  it('exits 1 with "could not reach" when nothing answers', async () => {
    const gone = await startRelay(0)
    const origin = gone.origin
    await gone.close()
    const res = await verify(['--row', ROW], { env: { ST_VERIFY_URL: origin } })
    expect(res.code).toBe(1)
    expect(res.lines[1]).toMatch(
      new RegExp(`^FAIL a\\. could not reach ${new URL(origin).host} \\(`),
    )
    expect(res.all).not.toContain('PASS')
  })

  it('exits 1 when the network drops mid-run, and writes nothing more', async () => {
    let calls = 0
    const flaky = (input, init) => {
      calls++
      return calls <= 2 ? fetch(input, init) : Promise.reject(new TypeError('fetch failed'))
    }
    const res = await verify(['--row', ROW], { fetch: flaky })
    expect(res.code).toBe(1)
    expect(res.lines.at(-2)).toMatch(/^FAIL b\. could not reach .*\(TypeError: fetch failed\)$/)
    expect(res.lines.at(-1)).toMatch(/^RESULT: FAIL \(1 of 2 failed\)/)
    expect(res.all).not.toContain('RESULT: PASS')
  })

  it('gives up on a request that never answers (the deadline)', async () => {
    const hanging = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    const res = await verify(['--row', ROW], { fetch: hanging, timeoutMs: 50 })
    expect(res.code).toBe(1)
    expect(res.lines[1]).toMatch(/^FAIL a\. could not reach .*TimeoutError/)
  })
})

// ---------------------------------------------------------------------------
// As the owner runs it: `node scripts/verify-cas.mjs …` in its own process
// ---------------------------------------------------------------------------

describe('run directly', () => {
  const SCRIPT = fileURLToPath(new URL('./verify-cas.mjs', import.meta.url))

  /** The script in a child process with only these variables (the parent's ST_VERIFY_* never leak in). */
  const node = (argv, env) =>
    new Promise((resolve) => {
      const clean = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('ST_VERIFY_')),
      )
      execFile(
        process.execPath,
        [SCRIPT, ...argv],
        { env: { ...clean, ...env }, timeout: 30_000 },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : error.code, stdout, stderr })
        },
      )
    })

  it('passes a–j and exits 0 against the relay after 004', async () => {
    relay.enableRpc()
    const res = await node(['--row', ROW], {
      ST_VERIFY_URL: relay.origin,
      ST_VERIFY_ANON_KEY: ANON,
    })
    expect(res.code).toBe(0)
    expect(res.stdout.trimEnd().split('\n').at(-1)).toBe(
      'RESULT: PASS (10/10). Safe to set VITE_SYNC_CAS=on.',
    )
    expect(res.stderr).toBe('')
    expectNothingLeaked(res.stdout)
  })

  it('reads only ST_VERIFY_*: the app’s VITE_* variables leave it refusing (exit 2)', async () => {
    const before = relay.log.length
    const res = await node(['--row', ROW], {
      VITE_SUPABASE_URL: relay.origin,
      VITE_SUPABASE_ANON_KEY: ANON,
    })
    expect(res.code).toBe(2)
    expect(res.stderr).toBe('REFUSED: ST_VERIFY_URL is not set. Nothing was written.\n')
    expect(relay.log.length).toBe(before)
  })

  it('exits 1 on a FAIL (the lockdown check before 005)', async () => {
    relay.enableRpc()
    const res = await node(['--lockdown'], {
      ST_VERIFY_URL: relay.origin,
      ST_VERIFY_ANON_KEY: PUBLISHABLE,
    })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('FAIL l. the table still lists rows (HTTP 200)')
    expectNothingLeaked(res.stdout)
  })
})
