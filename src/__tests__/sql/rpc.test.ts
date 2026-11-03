// @vitest-environment node
// The sync functions of 004 on real Postgres, called as anon over HTTP through the
// PostgREST-shaped adapter (PR-5 track spec §3.2, contract table A; AC-4 to AC-7, AC-17, AC-19):
// every answer and error below is JSON that Postgres produced.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRelay, closeTemplate, throwaway, type PgRelay } from '../pgRelay'
import { pgRest, statusOf, type PgRest } from '../pgRest'

const SLOW = 60_000
const BASE = 'http://relay.test'
const KEY = 'invented-anon-key'
const RPC_MAX = 1_258_291
/** `{"x5": {"pad": "<s>"}, "expenses": []}` is 35 bytes of jsonb text around the pad. */
const PAD_OVERHEAD = 35
/** Postgres's JSON form of a timestamptz: 0–6 fraction digits (zeros trimmed), ±HH:MM. */
const PG_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{0,5}[1-9])?[+-]\d{2}:\d{2}$/
/** Asymmetric matchers, typed as what they stand for in an expected value. */
const matching = (re: RegExp): unknown => expect.stringMatching(re)
const containing = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields)
const A_STAMP = matching(PG_STAMP)

interface Reply {
  readonly status: number
  readonly text: string
  readonly body: unknown
}

async function post(
  rest: PgRest,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Reply> {
  const res = await rest.fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  const body: unknown = text === '' ? undefined : JSON.parse(text)
  return { status: res.status, text, body }
}

const head = (rest: PgRest, row: unknown) => post(rest, 'st_sync_head', { p_row: row })
const pull = (rest: PgRest, row: unknown) => post(rest, 'st_sync_pull', { p_row: row })
const push = (
  rest: PgRest,
  row: unknown,
  payload: unknown,
  base: string | null = null,
  force = false,
) => post(rest, 'st_sync_push', { p_row: row, p_payload: payload, p_base: base, p_force: force })

const doc = (note = 'invented'): Record<string, unknown> => ({
  version: '4.0',
  expenses: [
    { id: 'e1', itemName: note, amount: 4.5, category: 'Other', date: '2026-10-01T12:00:00' },
  ],
  categories: ['Other'],
  x5: { schema: 5, rev: note },
})

function stampOf(reply: Reply): string {
  const b = reply.body
  if (
    typeof b === 'object' &&
    b !== null &&
    'updated_at' in b &&
    typeof b.updated_at === 'string'
  ) {
    return b.updated_at
  }
  if (typeof b === 'string') return b
  throw new Error(`no stamp in ${reply.text}`)
}

/** Microseconds since the epoch of a Postgres stamp (exact, for strict comparisons). */
function us(stamp: string): bigint {
  const m = /^(.+?)(?:\.(\d{1,6}))?([+-]\d{2}:\d{2}|Z)$/.exec(stamp)
  if (m === null) throw new Error(`not a stamp: ${stamp}`)
  const whole = Date.parse(`${m[1] ?? ''}${m[3] ?? 'Z'}`)
  return BigInt(whole) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0'))
}

const pad = (s: string) => ({ expenses: [], x5: { pad: s } })

function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined
}

let relay: PgRelay
let rest: PgRest

beforeAll(async () => {
  relay = await bootRelay('004')
  rest = pgRest(relay)
}, SLOW)

afterAll(async () => {
  await relay.close()
  await closeTemplate()
})

async function clear(): Promise<void> {
  await relay.run(`DELETE FROM public.sync_buckets`)
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

describe("the adapter's HTTP status for a SQLSTATE (PostgREST's error table)", () => {
  it.each([
    ['53400', 'anon', 500], // config limit exceeded: the relay is full
    ['53300', 'anon', 503], // the rest of class 53: insufficient resources
    ['08006', 'anon', 503],
    ['42501', 'anon', 401],
    ['42501', 'authenticated', 403],
    ['22023', 'anon', 400],
    ['23514', 'anon', 400],
    ['23505', 'anon', 409],
    ['P0001', 'anon', 400],
    ['XX000', 'anon', 500],
  ] as const)('%s as %s is HTTP %i', (code, role, status) => {
    expect(statusOf(code, role)).toBe(status)
  })
})

describe('contract table A, row by row, as anon (AC-4)', () => {
  it('head: the token in Postgres JSON form, or null for a missing or invalid id', async () => {
    await clear()
    await relay.seed([
      {
        id: throwaway(0xa1),
        payload: JSON.stringify(doc()),
        updatedAt: '2026-11-03 02:15:09.123400+00',
      },
      { id: throwaway(0xa2), payload: JSON.stringify(doc()), updatedAt: '2026-11-03 02:15:09+00' },
    ])
    expect(await head(rest, throwaway(0xa1))).toEqual({
      status: 200,
      text: '"2026-11-03T02:15:09.1234+00:00"',
      body: '2026-11-03T02:15:09.1234+00:00',
    })
    expect((await head(rest, throwaway(0xa2))).text).toBe('"2026-11-03T02:15:09+00:00"')
    for (const id of [
      throwaway(0xa3),
      null,
      throwaway(0xa1).toUpperCase(),
      'not-a-uuid',
      '',
      `${throwaway(0xa1)}' OR '1'='1`,
    ]) {
      expect(await head(rest, id), String(id)).toEqual({ status: 200, text: 'null', body: null })
    }
  })

  it('pull: {payload, updated_at, now}, or null', async () => {
    await clear()
    await relay.seed([
      {
        id: throwaway(0xa1),
        payload: JSON.stringify(doc('pulled')),
        updatedAt: '2026-11-03 02:15:09.5+00',
      },
    ])
    const got = await pull(rest, throwaway(0xa1))
    expect(got.status).toBe(200)
    expect(got.body).toEqual({
      payload: doc('pulled'),
      updated_at: '2026-11-03T02:15:09.5+00:00',
      now: A_STAMP,
    })
    for (const id of [throwaway(0xa2), null, 'not-a-uuid', throwaway(0xa1).toUpperCase()]) {
      expect(await pull(rest, id), String(id)).toEqual({ status: 200, text: 'null', body: null })
    }
  })

  it('push refuses a bad id, a non-object payload, too many bytes and a foreign shape (22023, HTTP 400)', async () => {
    await clear()
    const refused = (message: string) => ({
      status: 400,
      body: { code: '22023', details: null, hint: null, message },
    })
    for (const id of [null, 'not-a-uuid', throwaway(0xa1).toUpperCase(), '', 42]) {
      const r = await push(rest, id, doc())
      expect({ status: r.status, body: r.body }, String(id)).toEqual(refused('invalid row id'))
    }
    for (const p of [null, [], [doc()], 'text', 5, true]) {
      const r = await push(rest, throwaway(0xa1), p)
      expect({ status: r.status, body: r.body }, JSON.stringify(p)).toEqual(
        refused('invalid payload'),
      )
    }
    const big = await push(rest, throwaway(0xa1), pad('x'.repeat(RPC_MAX - PAD_OVERHEAD + 1)))
    expect({ status: big.status, body: big.body }).toEqual(refused('payload too large'))
    for (const p of [
      {},
      { version: '4.0', expenses: [] }, // v4 without x5
      { expenses: [], x5: [] },
      { expenses: {}, x5: {} },
      { st: '5', iv: 'AAAA', ct: 'AAAA' }, // st must be the number 5
      { st: 5, iv: 'AAAA' },
      { st: 5, iv: 1, ct: 'AAAA' },
      { st: 4, iv: 'AAAA', ct: 'AAAA' },
      { expenses: 'moved' },
      { expenses: 'gone', x5: {} },
    ]) {
      const r = await push(rest, throwaway(0xa1), p)
      expect({ status: r.status, body: r.body }, JSON.stringify(p)).toEqual(
        refused('invalid payload shape'),
      )
    }
    expect(await relay.rows(`SELECT 1 FROM public.sync_buckets`)).toEqual([])
  })

  it('push accepts the three shapes: v5 plaintext, a private envelope and a moved marker', async () => {
    await clear()
    const shapes = [
      doc(),
      { st: 5, k: 1, r: 'AAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAA', z: 1, ct: 'AAAA' },
      { st: 5.0, iv: 'B', ct: 'C' },
      {
        version: '4.0',
        expenses: 'moved',
        categories: [],
        x5: { schema: 5, min: 99, moved: { at: '2026-10-19T00:00:00Z' } },
      },
    ]
    for (const [i, p] of shapes.entries()) {
      const r = await push(rest, throwaway(0xb0 + i), p)
      expect(r.body, JSON.stringify(p)).toEqual({ ok: true, updated_at: A_STAMP })
    }
  })

  it('create, conflict, CAS, force and missing answer as table A says', async () => {
    await clear()
    const row = throwaway(0xa1)
    const created = await push(rest, row, doc('one'))
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ ok: true, updated_at: A_STAMP })
    const t1 = stampOf(created)
    expect(stampOf(await head(rest, row))).toBe(t1)

    // create of an existing row: a conflict with the current token, the payload unchanged
    expect((await push(rest, row, doc('two'))).body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: t1,
    })
    expect((await pull(rest, row)).body).toMatchObject({ payload: doc('one'), updated_at: t1 })

    // CAS with the exact etag string
    const cas = await push(rest, row, doc('three'), t1)
    expect(cas.body).toEqual({ ok: true, updated_at: A_STAMP })
    const t2 = stampOf(cas)
    expect(us(t2) > us(t1)).toBe(true)

    // CAS with an old etag, and with a token the row never had
    expect((await push(rest, row, doc('four'), t1)).body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: t2,
    })
    expect((await push(rest, row, doc('four'), '2001-01-01T00:00:00Z')).body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: t2,
    })
    // a base later than the token is a conflict too, 1 µs later or years: only the exact token lands
    for (const later of [await microLater(t2), '2099-01-01T00:00:00+00:00']) {
      expect((await push(rest, row, doc('four'), later)).body, later).toEqual({
        ok: false,
        reason: 'conflict',
        updated_at: t2,
      })
    }
    expect((await pull(rest, row)).body).toMatchObject({ payload: doc('three'), updated_at: t2 })

    // force over whatever is there
    const forced = await push(rest, row, doc('five'), null, true)
    expect(forced.body).toEqual({ ok: true, updated_at: A_STAMP })
    const t3 = stampOf(forced)
    expect(us(t3) > us(t2)).toBe(true)
    const forcedOld = await push(rest, row, doc('six'), t1, true) // force ignores the base
    expect(us(stampOf(forcedOld)) > us(t3)).toBe(true)

    // force and CAS on a missing row: missing, nothing created
    const gone = throwaway(0xa2)
    expect((await push(rest, gone, doc(), null, true)).body).toEqual({
      ok: false,
      reason: 'missing',
      updated_at: null,
    })
    expect((await push(rest, gone, doc(), t1)).body).toEqual({
      ok: false,
      reason: 'missing',
      updated_at: null,
    })
    expect((await head(rest, gone)).body).toBeNull()
    expect((await pull(rest, row)).body).toMatchObject({ payload: doc('six') })

    // an explicit JSON null for p_force is false, never force: create and CAS still decide
    const t4 = stampOf(await head(rest, row))
    for (const base of [null, t1]) {
      const r = await post(rest, 'st_sync_push', {
        p_row: row,
        p_payload: doc('seven'),
        p_base: base,
        p_force: null,
      })
      expect(r.body, String(base)).toEqual({ ok: false, reason: 'conflict', updated_at: t4 })
    }
    expect((await pull(rest, row)).body).toMatchObject({ payload: doc('six'), updated_at: t4 })
    const fresh = throwaway(0xa3)
    const made = await post(rest, 'st_sync_push', {
      p_row: fresh,
      p_payload: doc('new'),
      p_base: null,
      p_force: null,
    })
    expect(made.body).toEqual({ ok: true, updated_at: A_STAMP })
    expect((await pull(rest, fresh)).body).toMatchObject({ payload: doc('new') })
  })

  it('a CAS base matches as an instant: any offset, Z, trailing zeros', async () => {
    await clear()
    const row = throwaway(0xa1)
    await relay.seed([
      { id: row, payload: JSON.stringify(doc()), updatedAt: '2026-11-03 02:15:09.1234+00' },
    ])
    const forms = [
      '2026-11-03T02:15:09.1234+00:00',
      '2026-11-03T02:15:09.123400Z',
      '2026-11-03T10:15:09.1234+08:00',
      '2026-11-02T16:15:09.1234-10:00',
      '2026-11-03T16:15:09.1234+14:00',
    ]
    let current = forms[0] ?? ''
    for (const form of forms) {
      await relay.run(
        `UPDATE public.sync_buckets SET updated_at = '2026-11-03 02:15:09.1234+00' WHERE sync_id = '${row}'`,
      )
      const r = await push(rest, row, doc(form), form)
      expect(r.body, form).toEqual({ ok: true, updated_at: A_STAMP })
      current = stampOf(r)
    }
    expect(us(current) > us('2026-11-03T02:15:09.1234+00:00')).toBe(true)
  })
})

describe('an id that is not a lower-case UUID is never a row, even where such a row exists (table A)', () => {
  it(
    'after 004 and after 005: head and pull answer null, every push is 22023, and no row changes',
    async () => {
      // written before 004, when the table still took any id
      const legacy = await bootRelay('001-003')
      try {
        const odd = ['legacy-code', throwaway(0xe1).toUpperCase()]
        await legacy.seed([
          ...odd.map((id) => ({ id, payload: JSON.stringify(doc('legacy')) })),
          { id: throwaway(0xe1), payload: JSON.stringify(doc('real')) },
        ])
        const anon = pgRest(legacy)
        const nothing = { status: 200, text: 'null', body: null }
        const refused = {
          status: 400,
          body: { code: '22023', details: null, hint: null, message: 'invalid row id' },
        }
        for (const stage of ['004', '005'] as const) {
          await legacy.apply(stage)
          const before = await legacy.dataSnapshot()
          for (const id of odd) {
            expect(await head(anon, id), `${stage} head ${id}`).toEqual(nothing)
            expect(await pull(anon, id), `${stage} pull ${id}`).toEqual(nothing)
            for (const [base, force] of [
              [null, false],
              ['2026-11-03T02:15:09+00:00', false],
              [null, true],
            ] as const) {
              const r = await push(anon, id, doc('overwrite'), base, force)
              expect({ status: r.status, body: r.body }, `${stage} push ${id}`).toEqual(refused)
            }
          }
          // the lower-case row is the one the functions serve
          expect((await pull(anon, throwaway(0xe1))).body, stage).toMatchObject({
            payload: doc('real'),
          })
          expect(await legacy.dataSnapshot(), stage).toBe(before)
        }
      } finally {
        await legacy.close()
      }
    },
    SLOW,
  )
})

describe('a write that matches no row answers conflict, never ok (the token re-match)', () => {
  it('CAS and force answer conflict with the current token, and the payload stays', async () => {
    await clear()
    const row = throwaway(0xa1)
    const t = stampOf(await push(rest, row, doc('kept')))
    // Stands in for a crossing write that got in between the read and the UPDATE (what the row
    // lock prevents): a trigger that skips the UPDATE, so it matches no row.
    await relay.run(`
      CREATE FUNCTION public.st_test_skip_update() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER st_test_skip_update BEFORE UPDATE ON public.sync_buckets
        FOR EACH ROW EXECUTE FUNCTION public.st_test_skip_update();`)
    try {
      for (const [base, force] of [
        [t, false],
        [null, true],
      ] as const) {
        expect((await push(rest, row, doc('lost'), base, force)).body, String(force)).toEqual({
          ok: false,
          reason: 'conflict',
          updated_at: t,
        })
      }
    } finally {
      await relay.run(`
        DROP TRIGGER st_test_skip_update ON public.sync_buckets;
        DROP FUNCTION public.st_test_skip_update();`)
    }
    expect((await pull(rest, row)).body).toMatchObject({ payload: doc('kept'), updated_at: t })
    expect((await push(rest, row, doc('lands'), t)).body).toMatchObject({ ok: true })
  })
})

describe('the size limit counts bytes of jsonb text (AC-5)', () => {
  it(
    'accepts exactly 1,258,291 bytes and refuses 1,258,292, in ASCII and in CJK',
    async () => {
      await clear()
      const ascii = 'x'.repeat(RPC_MAX - PAD_OVERHEAD)
      // 3-byte characters, then ASCII to land on the byte: fewer characters than bytes by far
      const cjkBytes = RPC_MAX - PAD_OVERHEAD
      const cjk = '中'.repeat(Math.floor(cjkBytes / 3)) + 'x'.repeat(cjkBytes % 3)
      expect(cjk.length).toBeLessThan(cjkBytes / 2)
      const sizes = await relay.rows<{ a: number; c: number; c1: number }>(
        `SELECT octet_length($1::jsonb::text) AS a, octet_length($2::jsonb::text) AS c,
                octet_length($3::jsonb::text) AS c1`,
        [JSON.stringify(pad(ascii)), JSON.stringify(pad(cjk)), JSON.stringify(pad(`${cjk}x`))],
      )
      expect(sizes).toEqual([{ a: RPC_MAX, c: RPC_MAX, c1: RPC_MAX + 1 }])
      expect((await push(rest, throwaway(0xa1), pad(ascii), null, false)).body).toMatchObject({
        ok: true,
      })
      expect((await push(rest, throwaway(0xa2), pad(cjk))).body).toMatchObject({ ok: true })
      for (const over of [`${ascii}x`, `${cjk}x`, `${cjk.slice(0, -2)}中`]) {
        const r = await push(rest, throwaway(0xa3), pad(over))
        expect([r.status, r.body], `${String(over.length)} chars`).toEqual([
          400,
          { code: '22023', details: null, hint: null, message: 'payload too large' },
        ])
      }
      // the same bytes through CAS and force: the limit holds on every path
      const t = stampOf(await head(rest, throwaway(0xa1)))
      expect((await push(rest, throwaway(0xa1), pad(`${ascii}x`), t)).status).toBe(400)
      expect((await push(rest, throwaway(0xa1), pad(`${ascii}x`), null, true)).status).toBe(400)
      expect((await push(rest, throwaway(0xa1), pad(ascii), t)).body).toMatchObject({ ok: true })
    },
    SLOW,
  )
})

describe('creation caps: 20 an hour, 500 rows (AC-6)', () => {
  const full = { code: '53400', details: null, hint: null, message: 'relay is full' }

  // PostgREST answers 53400 ("config limit exceeded") with HTTP 500, unlike the rest of class 53
  // (503); the app tells a full relay by the code, never by the status.
  it('the 21st create in an hour is 53400 (HTTP 500); existing rows still conflict, CAS and force', async () => {
    await clear()
    for (let i = 1; i <= 20; i++) {
      expect((await push(rest, throwaway(0x100 + i), doc())).body, String(i)).toMatchObject({
        ok: true,
      })
    }
    const r = await push(rest, throwaway(0x200), doc())
    expect([r.status, r.body]).toEqual([500, full])
    expect((await head(rest, throwaway(0x200))).body).toBeNull()
    const existing = throwaway(0x101)
    const t = stampOf(await head(rest, existing))
    expect((await push(rest, existing, doc('again'))).body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: t,
    })
    const cas = await push(rest, existing, doc('cas'), t)
    expect(cas.body).toMatchObject({ ok: true })
    expect((await push(rest, existing, doc('force'), null, true)).body).toMatchObject({ ok: true })
  })

  it('rows created over an hour ago do not count toward the hourly cap', async () => {
    await clear()
    await relay.fill({ count: 30, createdAgo: '61 minutes' })
    await relay.fill({ count: 19, createdAgo: '59 minutes', from: 100 })
    expect((await push(rest, throwaway(0xa1), doc())).body).toMatchObject({ ok: true })
    expect((await push(rest, throwaway(0xa2), doc())).status).toBe(500)
  })

  it('the 501st row is 53400; creating a row that exists at the cap is a conflict', async () => {
    await clear()
    await relay.fill({ count: 499, createdAgo: '2 hours' })
    expect((await push(rest, throwaway(0xa1), doc())).body).toMatchObject({ ok: true })
    const r = await push(rest, throwaway(0xa2), doc())
    expect([r.status, r.body]).toEqual([500, full])
    const t = stampOf(await head(rest, throwaway(0xa1)))
    expect((await push(rest, throwaway(0xa1), doc())).body).toEqual({
      ok: false,
      reason: 'conflict',
      updated_at: t,
    })
    expect((await push(rest, throwaway(0xa1), doc(), t)).body).toMatchObject({ ok: true })
    const count = await relay.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.sync_buckets`,
    )
    expect(count).toEqual([{ n: 500 }])
  })
})

describe('tokens only move forward (AC-7)', () => {
  let hostile: PgRelay
  let hostileRest: PgRest

  beforeAll(async () => {
    // rows written before 004, which then has to cope with them
    hostile = await bootRelay('001-003')
    await hostile.seed([
      {
        id: throwaway(0xc1),
        payload: JSON.stringify(doc()),
        updatedAt: '2099-06-01 00:00:00.123456+00',
      },
      { id: throwaway(0xc2), payload: JSON.stringify(doc()), updatedAt: 'infinity' },
      { id: throwaway(0xc3), payload: JSON.stringify(doc()), updatedAt: '-infinity' },
      {
        id: throwaway(0xc4),
        payload: JSON.stringify(doc()),
        updatedAt: '294276-12-31 23:59:59.999999+00',
      },
      {
        id: throwaway(0xc5),
        payload: JSON.stringify(doc()),
        updatedAt: '2026-12-31 23:59:59.999999+00',
      },
      {
        id: throwaway(0xc6),
        payload: JSON.stringify(doc()),
        updatedAt: '2099-12-31 23:59:59.999999+00',
      },
      // past the last token 004 moves on from: one more µs could print a 5-digit year
      { id: throwaway(0xc7), payload: JSON.stringify(doc()), updatedAt: '9999-12-31 00:00:00+00' },
      { id: throwaway(0xc8), payload: JSON.stringify(doc()), updatedAt: '10000-06-01 00:00:00+00' },
    ])
    await hostile.apply('004')
    hostileRest = pgRest(hostile)
  }, SLOW)

  afterAll(async () => {
    await hostile.close()
  })

  it('over a 2099 token: CAS and force answer the previous token + 1 µs', async () => {
    const row = throwaway(0xc1)
    const t0 = stampOf(await head(hostileRest, row))
    expect(t0).toBe('2099-06-01T00:00:00.123456+00:00')
    const cas = await push(hostileRest, row, doc(), t0)
    expect(cas.body).toEqual({ ok: true, updated_at: '2099-06-01T00:00:00.123457+00:00' })
    const forced = await push(hostileRest, row, doc(), null, true)
    expect(forced.body).toEqual({ ok: true, updated_at: '2099-06-01T00:00:00.123458+00:00' })
  })

  it('over infinity, -infinity and the last representable time: the token becomes the clock (nothing is later than infinity)', async () => {
    const before = BigInt(Date.now() - 5_000) * 1000n
    expect((await head(hostileRest, throwaway(0xc2))).body).toBe('infinity')
    const inf = await push(hostileRest, throwaway(0xc2), doc(), 'infinity')
    expect(inf.body).toEqual({ ok: true, updated_at: A_STAMP })
    const t = stampOf(inf)
    expect(us(t) >= before).toBe(true)
    const next = await push(hostileRest, throwaway(0xc2), doc(), t)
    expect(us(stampOf(next)) > us(t)).toBe(true)

    const minus = await push(hostileRest, throwaway(0xc3), doc(), null, true)
    expect(us(stampOf(minus)) >= before).toBe(true)

    const last = await push(hostileRest, throwaway(0xc4), doc(), null, true)
    expect(last.body).toEqual({ ok: true, updated_at: A_STAMP })
    expect(us(stampOf(last)) >= before).toBe(true)
  })

  it('over a token from 9999-12-31 on: the token becomes the clock (never a 5-digit year)', async () => {
    const before = BigInt(Date.now() - 5_000) * 1000n
    const soon = us('2200-01-01T00:00:00+00:00')
    for (const row of [throwaway(0xc7), throwaway(0xc8)]) {
      const forced = await push(hostileRest, row, doc(), null, true)
      expect(forced.body, row).toEqual({ ok: true, updated_at: A_STAMP })
      const t = us(stampOf(forced))
      expect(t >= before && t < soon, `${row}: ${stampOf(forced)}`).toBe(true)
    }
  })

  it('a base of 2026-12-31T23:59:59.999999+00:00 rolls into 2027; the fraction-less etag is the next base', async () => {
    const row = throwaway(0xc5)
    const r = await push(hostileRest, row, doc(), '2026-12-31T23:59:59.999999+00:00')
    const t = stampOf(r)
    expect(us(t) >= us('2027-01-01T00:00:00+00:00')).toBe(true)
    if (Date.now() < Date.UTC(2027, 0, 1)) expect(t).toBe('2027-01-01T00:00:00+00:00')
    expect((await push(hostileRest, row, doc(), t)).body).toMatchObject({ ok: true })
    // deterministic whatever today is: 2099 rolls into 2100
    const y2100 = await push(hostileRest, throwaway(0xc6), doc(), '2099-12-31T23:59:59.999999Z')
    expect(y2100.body).toEqual({ ok: true, updated_at: '2100-01-01T00:00:00+00:00' })
    expect(
      (await push(hostileRest, throwaway(0xc6), doc(), '2100-01-01T00:00:00+00:00')).body,
    ).toEqual({
      ok: true,
      updated_at: '2100-01-01T00:00:00.000001+00:00',
    })
  })

  it('twenty quick writes give twenty strictly increasing tokens', async () => {
    await clear()
    const row = throwaway(0xa1)
    let t = stampOf(await push(rest, row, doc()))
    for (let i = 0; i < 20; i++) {
      const next = stampOf(
        await push(rest, row, doc(String(i)), i % 2 === 0 ? t : null, i % 2 === 1),
      )
      expect(us(next) > us(t), `${next} after ${t}`).toBe(true)
      t = next
    }
  })
})

describe('session time zones (AC-17)', () => {
  const zones: readonly (readonly [string, RegExp])[] = [
    ['UTC', /\+00:00$/],
    ['Asia/Singapore', /\+08:00$/],
    ['Pacific/Honolulu', /-10:00$/],
    ['Pacific/Kiritimati', /\+14:00$/],
    ['America/New_York', /-0[45]:00$/],
  ]

  it('etags carry the zone offset, and each one is a working CAS base over RPC and the table', async () => {
    await clear()
    const offsets = new Set<string>()
    for (const [i, [zone, offset]] of zones.entries()) {
      rest.setTimeZone(zone)
      const row = throwaway(0xd0 + i)
      const t = stampOf(await push(rest, row, doc(zone)))
      expect(t, zone).toMatch(offset)
      expect(t, zone).toMatch(PG_STAMP)
      offsets.add(t.slice(-6))
      expect(stampOf(await head(rest, row)), zone).toBe(t)
      const cas = await push(rest, row, doc(`${zone} cas`), t)
      expect(cas.body, zone).toMatchObject({ ok: true })
      const t2 = stampOf(cas)
      expect(t2, zone).toMatch(offset)
      // the table CAS of VITE_SYNC_CAS=on: updated_at=eq.<etag>, `+` encoded as postgrest-js does
      const url = new URL(`${BASE}/rest/v1/sync_buckets`)
      url.searchParams.set('sync_id', `eq.${row}`)
      url.searchParams.set('updated_at', `eq.${t2}`)
      url.searchParams.set('select', 'updated_at')
      const patched = await rest.fetch(url, {
        method: 'PATCH',
        headers: {
          apikey: KEY,
          Prefer: 'return=representation',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payload: doc(`${zone} table`),
          updated_at: '2026-11-03T04:00:00.000001Z',
        }),
      })
      expect(patched.status, zone).toBe(200)
      const rows: unknown = await patched.json()
      expect(rows, zone).toEqual([{ updated_at: matching(offset) }])
    }
    expect(offsets.size).toBe(zones.length)
    rest.setTimeZone('UTC')
  })
})

describe('jsonb text (AC-19) and characters Postgres refuses', () => {
  it('the §3.10 vectors equal octet_length(v::jsonb::text)', async () => {
    const vectors: readonly (readonly [string, number])[] = [
      ['{}', 2],
      ['[]', 2],
      ['{"a":1}', 8],
      ['[1,2,3]', 9],
      ['{"a":1,"b":[1,2]}', 21],
      ['{"a":{"b":[]}}', 16],
      ['{"k":"é"}', 11],
      ['{"n":"\\n"}', 11],
      ['{"e":"😀"}', 13],
    ]
    const got = await relay.rows<{ v: string; n: number }>(
      `SELECT v, octet_length(v::jsonb::text) AS n FROM unnest($1::text[]) AS v`,
      [vectors.map(([v]) => v)],
    )
    expect(got.map((r) => [r.v, r.n])).toEqual(vectors)
  })

  it('NUL is refused with 22P05 and a lone surrogate with 22P02, over RPC and the table alike', async () => {
    await clear()
    const nul = { ...doc(), note: 'a\u0000b' }
    const lone = { ...doc(), note: '\ud800' }
    const viaRpc = [await push(rest, throwaway(0xa1), nul), await push(rest, throwaway(0xa1), lone)]
    expect(viaRpc.map((r) => [r.status, codeOf(r.body)])).toEqual([
      [400, '22P05'],
      [400, '22P02'],
    ])
    for (const [payload, code] of [
      [nul, '22P05'],
      [lone, '22P02'],
    ] as const) {
      const res = await rest.fetch(`${BASE}/rest/v1/sync_buckets?select=updated_at`, {
        method: 'POST',
        headers: {
          apikey: KEY,
          Prefer: 'resolution=merge-duplicates,return=representation',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sync_id: throwaway(0xa2),
          payload,
          updated_at: '2026-11-03T04:00:00Z',
        }),
      })
      const body: unknown = await res.json()
      expect([res.status, body]).toEqual([400, containing({ code })])
    }
    expect(await relay.rows(`SELECT 1 FROM public.sync_buckets`)).toEqual([])
  })
})
