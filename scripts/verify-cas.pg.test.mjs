// @vitest-environment node
// scripts/verify-cas.mjs against the REAL migrations: the script's own requests through
// supabase-js, the PostgREST-shaped adapter (src/__tests__/pgRest.ts) and Postgres (PGlite) with
// 001 to 005 applied as the owner applies them. verify-cas.test.mjs holds the script to the fake
// relay; this file proves the gate C and gate E answers that docs/brain/sync-runbook.md quotes
// against the SQL itself, and the runbook's own cleanup SQL. Invented data and keys only;
// nothing here reaches a network.
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootRelay, closeTemplate } from '../src/__tests__/pgRelay.ts'
import { pgRest } from '../src/__tests__/pgRest.ts'
import { run, secondRow } from './verify-cas.mjs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** The script allows plain http only for localhost; the adapter ignores the host. */
const ORIGIN = 'http://localhost:54321'
const ROW = '00000000-0000-4000-8000-202611030001'
/** An owner-like row: a real-looking code and v5 payload, which no run may touch or print. */
const OWNER = '7c0f4e1a-93b2-4d6e-a1f8-5b2c9d0e3f47'
const CANARY = 'CANARY-chicken-rice-0311'
const OWNER_PAYLOAD = JSON.stringify({
  version: '4.0',
  exportDate: '2026-11-03T04:00:00.000Z',
  expenses: [
    { id: 'e1', itemName: CANARY, amount: 5.5, category: 'Meals', date: '2026-11-03T12:00:00' },
  ],
  deletedIds: [],
  x5: { schema: 5, rev: 'r1' },
})
/** A token as PostgREST prints it: microseconds without trailing zeros, the session's offset. */
const ETAG = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{0,5}[1-9])?\+00:00`

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const ANON = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ iss: 'supabase', ref: 'inventedref000000', role: 'anon', exp: 4_102_444_800 }),
  'aW52ZW50ZWQtc2lnbmF0dXJl',
].join('.')

/** @type {import('../src/__tests__/pgRelay.ts').PgRelay | null} */
let relay = null
let ownerBefore = ''

const ownerRow = async () =>
  JSON.stringify(
    await relay.rows(
      `SELECT payload::text AS payload, updated_at::text AS at FROM public.sync_buckets WHERE sync_id = $1`,
      [OWNER],
    ),
  )

/** Boots a relay at `stage` holding the owner-like row. */
async function boot(stage) {
  relay = await bootRelay(stage)
  await relay.seed([{ id: OWNER, payload: OWNER_PAYLOAD }])
  ownerBefore = await ownerRow()
  return relay
}

/** Runs the script's `run()` against the relay as anon over HTTP and captures what it printed. */
async function verify(argv) {
  let out = ''
  let err = ''
  const rest = pgRest(relay)
  const code = await run({
    argv,
    env: { ST_VERIFY_URL: ORIGIN, ST_VERIFY_ANON_KEY: ANON },
    fetch: rest.fetch,
    out: { write: (text) => (out += text) },
    err: { write: (text) => (err += text) },
  })
  const all = out + err
  for (const secret of [ANON, OWNER, CANARY]) expect(all).not.toContain(secret)
  return { code, lines: all.trimEnd().split('\n'), rest }
}

const syncIds = async () =>
  (await relay.rows(`SELECT sync_id FROM public.sync_buckets ORDER BY sync_id`)).map(
    (r) => r.sync_id,
  )

const rowOf = (rows, item) => rows.find((r) => r.item === item)?.value

beforeEach(() => {
  relay = null
  ownerBefore = ''
})

// No run, check or refusal touches the owner-like row.
afterEach(async () => {
  if (relay === null) return
  expect(await ownerRow()).toBe(ownerBefore)
  await relay.close()
})

afterAll(async () => {
  await closeTemplate()
})

describe('gate C: the CAS check on the real SQL', () => {
  it('before 004: a to d pass and the functions are skipped (4/4), one throwaway row added', async () => {
    await boot('001-003')
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(0)
    expect(res.lines.slice(1, 5).map((l) => l.slice(0, 7))).toEqual([
      'PASS a.',
      'PASS b.',
      'PASS c.',
      'PASS d.',
    ])
    expect(res.lines.slice(5)).toEqual([
      'SKIP e–j. sync functions not found (apply 004 first)',
      'RESULT: PASS (4/4). Safe to set VITE_SYNC_CAS=on.',
    ])
    expect(await syncIds()).toEqual([ROW, OWNER])
  })

  it('after 004: every line the runbook quotes, 10/10, and check j creates nothing', async () => {
    await boot('004')
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(0)
    const expected = [
      `verify-cas: localhost:54321  row ${ROW}`,
      `PASS a\\. insert created the throwaway row; etag ${ETAG}`,
      'PASS b\\. a write based on that exact etag changed 1 row',
      'PASS c\\. a write based on the old etag changed 0 rows \\(a conflict\\)',
      `PASS d\\. the new etag ${ETAG} is later than the old one`,
      'PASS e\\. st_sync_head returns the current etag',
      `PASS f\\. st_sync_push based on the current etag landed; etag ${ETAG}`,
      'PASS g\\. st_sync_push based on an old etag is a conflict',
      'PASS h\\. st_sync_pull returns the payload and the current etag',
      'PASS i\\. st_sync_push refuses a payload without x5 \\(22023\\)',
      'PASS j\\. a forced write to a missing row returns missing and creates nothing',
      'RESULT: PASS \\(10/10\\)\\. Safe to set VITE_SYNC_CAS=on\\.',
    ]
    expect(res.lines).toHaveLength(expected.length)
    res.lines.forEach((line, i) => {
      expect(line).toMatch(new RegExp(`^${expected[i] ?? ''}$`))
    })
    // the functions were reached through the API (j: a head, the forced push, a head again),
    // and the second throwaway id stays free
    expect(res.rest.log.filter((q) => q.kind === 'rpc').map((q) => [q.fn, q.status])).toEqual([
      ['st_sync_head', 200],
      ['st_sync_push', 200],
      ['st_sync_push', 200],
      ['st_sync_pull', 200],
      ['st_sync_push', 400],
      ['st_sync_head', 200],
      ['st_sync_push', 200],
      ['st_sync_head', 200],
    ])
    expect(await syncIds()).toEqual([ROW, OWNER])
    expect(await syncIds()).not.toContain(secondRow(ROW))

    // what the runbook says next: 004_verify still passes, the preflight counts the check row
    const verifyRows = await relay.check('004_verify')
    expect(verifyRows[0]?.actual).toBe('PASS 34/34')
    const preflight = await relay.check('preflight')
    expect(rowOf(preflight, 'verdict')).toBe('GO')
    expect(rowOf(preflight, 'stage')).toBe('004 applied')
    expect(rowOf(preflight, 'writer_classes')).toContain('check rows 1')
  })

  it('a rerun on the same id is refused before any write', async () => {
    await boot('004')
    expect((await verify(['--row', ROW])).code).toBe(0)
    const before = await relay.dataSnapshot()
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(2)
    expect(res.lines.at(-1)).toBe(
      `REFUSED: row ${ROW} already exists. Use a new id (the next run number). Nothing was written.`,
    )
    expect(res.rest.log.map((q) => q.method)).toEqual(['GET'])
    expect(await relay.dataSnapshot()).toBe(before)
  })

  it('after 005: CAS mode stops at a, writes nothing and points to --lockdown', async () => {
    await boot('005')
    const before = await relay.dataSnapshot()
    const res = await verify(['--row', ROW])
    expect(res.code).toBe(1)
    expect(res.lines.slice(1)).toEqual([
      'FAIL a. the table is locked (005 applied); use --lockdown',
      'RESULT: FAIL (1 of 1 failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.',
    ])
    expect(await relay.dataSnapshot()).toBe(before)
  })
})

describe('gate E: the lockdown check on the real SQL', () => {
  it('after 005: l and m pass (2/2), read-only', async () => {
    await boot('005')
    const before = await relay.dataSnapshot()
    const res = await verify(['--lockdown'])
    expect(res.code).toBe(0)
    expect(res.lines).toEqual([
      'verify-cas: localhost:54321  row 00000000-0000-4000-8000-000000000000',
      'PASS l. the table refuses to list rows (HTTP 401, 42501: permission denied for table sync_buckets)',
      'PASS m. st_sync_head answers (HTTP 200)',
      'RESULT: PASS (2/2). The lockdown holds.',
    ])
    expect(res.rest.log.map((q) => q.method)).toEqual(['GET', 'POST'])
    expect(await relay.dataSnapshot()).toBe(before)
  })

  it('before 005, and again after its rollback: l fails without printing a row', async () => {
    await boot('004')
    const expected = [
      'FAIL l. the table still lists rows (HTTP 200); the lockdown is not applied',
      'PASS m. st_sync_head answers (HTTP 200)',
      'RESULT: FAIL (1 of 2 failed). The lockdown does not hold. Paste this output to the lead.',
    ]
    expect((await verify(['--lockdown'])).lines.slice(1)).toEqual(expected)
    await relay.apply('005')
    expect((await verify(['--lockdown'])).code).toBe(0)
    await relay.apply('005-rollback')
    const res = await verify(['--lockdown'])
    expect(res.code).toBe(1)
    expect(res.lines.slice(1)).toEqual(expected)
  })
})

const runbook = readFileSync(new URL('../docs/brain/sync-runbook.md', import.meta.url), 'utf8')

describe('the runbook quotes what the checks print', () => {
  it.each([
    ['004', '004_verify'],
    ['005', '005_verify'],
  ])('after %s, %s: the RESULT line and every check name', async (stage, file) => {
    await boot(stage)
    const rows = await relay.check(file)
    const n = rows.length - 1
    expect(rows[0]?.actual).toBe(`PASS ${String(n)}/${String(n)}`)
    expect(runbook).toContain(`\`PASS ${String(n)}/${String(n)}\``)
    for (const row of rows.slice(1)) expect(runbook).toContain(`\`${String(row.check)}\``)
  })

  it('the preflight: every item name, and the values the runbook expects before 004', async () => {
    await boot('001-003')
    const rows = await relay.check('preflight')
    expect(rows).toHaveLength(21)
    for (const row of rows) expect(runbook).toContain(`\`${String(row.item)}\``)
    expect(rowOf(rows, 'verdict')).toBe('GO')
    expect(rowOf(rows, 'stage')).toBe('before 004')
    expect(rowOf(rows, 'sync_functions')).toBe('none')
    expect(rowOf(rows, 'write_guards')).toBe('none')
    expect(rowOf(rows, 'rows_bad_id')).toBe('0 in total, 0 written in the last 30 days')
  })
})

describe("the runbook's optional cleanup of CAS-check rows", () => {
  const sqlBlocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')
  const countSql = sqlBlocks.find((s) => s.trimStart().startsWith('SELECT count(*)')) ?? ''
  const deleteSql = sqlBlocks.find((s) => s.trimStart().startsWith('DELETE')) ?? ''

  it('counts and removes only the throwaway rows the script wrote, after the lockdown too', async () => {
    expect(countSql).toContain("payload->>'spendtrack' = 'verify-cas'")
    expect(deleteSql).toContain("sync_id LIKE '00000000-0000-4000-8000-%'")
    await boot('004')
    const second = '00000000-0000-4000-8000-202611030002'
    expect((await verify(['--row', ROW])).code).toBe(0)
    expect((await verify(['--row', second])).code).toBe(0)
    // look-alikes the cleanup must leave: a throwaway-shaped id without the marker, and the
    // marker on an id outside the throwaway range
    const unmarked = '00000000-0000-4000-8000-0000000000ff'
    const outside = '20000000-0000-4000-8000-000000000001'
    await relay.seed([
      { id: unmarked, payload: OWNER_PAYLOAD },
      {
        id: outside,
        payload: JSON.stringify({ spendtrack: 'verify-cas', expenses: [], x5: { schema: 5 } }),
      },
    ])
    await relay.apply('005')

    expect(await relay.rows(countSql)).toEqual([{ count: 2 }])
    const removed = await relay.rows(deleteSql)
    expect(removed.map((r) => r.sync_id).sort()).toEqual([ROW, second])
    expect(await syncIds()).toEqual([unmarked, outside, OWNER])
    expect((await relay.check('005_verify'))[0]?.actual).toBe('PASS 20/20')
  })
})
