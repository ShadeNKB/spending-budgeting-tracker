// @vitest-environment node
// Migration 006 (optional: a moved marker stays moved) and its rollback on real Postgres
// (PRIVATE-SYNC 4.5, finding A): the function text is 004's and 003's plus the marked lines; the
// push matrix answers as 004 does except where a marker would be written over; the prune keeps a
// marker four times as long; a direct table write still replaces one until 005; it applies over 004 with or without 005, in either order, twice; the rollback gives
// back the exact earlier catalog; the checks PASS and FAIL where they should; and 0.21.0's RPC
// transport meets the refusal. Invented data only.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { movedMarker } from '../../data/core/wire'
import {
  bootRelay,
  checkSql,
  closeTemplate,
  failureOf,
  migrationSql,
  OWNER,
  STRANGER,
  supabaseFile,
  throwaway,
  UUID_RE,
  v5Payload,
  type CheckFile,
  type Migration,
  type PgRelay,
  type Stage,
} from '../pgRelay'
import { pgRest } from '../pgRest'

const SLOW = 120_000
const open: PgRelay[] = []

async function relayAt(stage: Stage, ...more: readonly Migration[]): Promise<PgRelay> {
  const r = await bootRelay(stage)
  open.push(r)
  for (const m of more) await r.apply(m)
  return r
}

afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
afterAll(closeTemplate)

// ─── The text a reviewer reads ──────────────────────────────────────────────────────────────

/** The lines 006 adds to st_sync_push, right after 004's compare-and-set token check. */
const PUSH_BLOCK = [
  '  -- 006: a moved marker stays. Only another moved marker replaces it, by compare-and-set or',
  '  -- forced; anything else is a conflict and writes nothing (the row is locked above).',
  `  IF ((p_payload -> 'expenses') = '"moved"'::jsonb`,
  `      AND pg_catalog.jsonb_typeof(p_payload -> 'x5') = 'object') IS NOT TRUE`,
  '     AND EXISTS (SELECT 1 FROM public.sync_buckets AS b',
  '                  WHERE b.sync_id = p_row',
  `                    AND (b.payload -> 'expenses') = '"moved"'::jsonb`,
  `                    AND pg_catalog.jsonb_typeof(b.payload -> 'x5') = 'object') THEN`,
  `    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);`,
  '  END IF;',
]

/** The text from `start` (a line that begins so) to the next line that is exactly `end`. */
function section(sql: string, start: string, end: string): string[] {
  const lines = sql.split('\n')
  const from = lines.findIndex((l) => l.startsWith(start))
  expect(from, start).toBeGreaterThan(-1)
  const to = lines.indexOf(end, from)
  expect(to, end).toBeGreaterThan(from)
  return lines.slice(from, to + 1)
}

const pushText = (sql: string) =>
  section(sql, 'CREATE OR REPLACE FUNCTION public.st_sync_push(', '$fn$;')
const pruneText = (sql: string) =>
  section(sql, 'CREATE OR REPLACE FUNCTION public.prune_stale_sync_buckets(', '$$;')

/** `after` is `before` with exactly `added` inserted in one place; returns where. */
function insertedAt(before: string[], after: string[], added: string[]): number {
  let i = 0
  while (i < before.length && before[i] === after[i]) i++
  expect(after.slice(i, i + added.length)).toEqual(added)
  expect(after.slice(i + added.length)).toEqual(before.slice(i))
  return i
}

describe('006: the function text (the diff a reviewer reads)', () => {
  it("st_sync_push is 004's, with the 006 block after the token check and nothing else", () => {
    const p004 = pushText(migrationSql('004'))
    const p006 = pushText(migrationSql('006'))
    const at = insertedAt(p004, p006, PUSH_BLOCK)
    expect(p004.slice(at - 3, at)).toEqual([
      '  IF NOT coalesce(p_force, false) AND v_cur IS DISTINCT FROM p_base THEN',
      `    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);`,
      '  END IF;',
    ])
    // the marker test is 004's own shape-check branch for a moved marker, word for word
    expect(migrationSql('004')).toContain(
      `    OR ((p_payload -> 'expenses') = '"moved"'::jsonb\n        AND pg_catalog.jsonb_typeof(p_payload -> 'x5') = 'object')`,
    )
    // the rollback's is 004's, line for line, and so is its comment
    expect(pushText(migrationSql('006-rollback'))).toEqual(p004)
    const comment = (sql: string) => {
      const lines = sql.split('\n')
      const at = lines.findIndex((l) => l.startsWith('COMMENT ON FUNCTION public.st_sync_push('))
      return lines.slice(at, at + 2)
    }
    expect(comment(migrationSql('006-rollback'))).toEqual(comment(migrationSql('004')))
    expect(comment(migrationSql('006'))[1]).toMatch(/^ {2}'SpendTrack 006: .*';$/)
  })

  it("prune is 003's, with one condition more (a marker: 4 x stale_after)", () => {
    const p003 = pruneText(supabaseFile('migrations/003_harden_prune_search_path.sql'))
    const p006 = pruneText(migrationSql('006'))
    const where = p003.indexOf('   WHERE updated_at < NOW() - stale_after;')
    expect(where).toBeGreaterThan(-1)
    expect(p006).toEqual([
      ...p003.slice(0, where),
      '   WHERE updated_at < NOW() - stale_after',
      '     -- 006: a moved marker stays four times as long (IS NOT TRUE: a row without the keys is not one)',
      `     AND (((payload -> 'expenses') = '"moved"'::jsonb AND jsonb_typeof(payload -> 'x5') = 'object') IS NOT TRUE`,
      '          OR updated_at < NOW() - 4 * stale_after);',
      ...p003.slice(where + 1),
    ])
    expect(pruneText(migrationSql('006-rollback'))).toEqual(p003)
  })

  it('names no table, column, index, policy, grant, owner or publication change', () => {
    for (const m of ['006', '006-rollback'] as const) {
      const executed = migrationSql(m)
        .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
      expect(executed, m).not.toMatch(
        /\b(GRANT|REVOKE|ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE|POLICY|PUBLICATION|OWNER)\b/i,
      )
      const statements = executed
        .split(';')
        .map((s) => s.trim().split(/\s+/).slice(0, 4).join(' '))
        .filter((s) => s !== '')
      expect(statements, m).toEqual([
        'DO',
        'BEGIN',
        'SET LOCAL lock_timeout =',
        'DO',
        'CREATE OR REPLACE FUNCTION',
        'COMMENT ON FUNCTION public.st_sync_push(text,',
        'CREATE OR REPLACE FUNCTION',
        "NOTIFY pgrst, ''",
        'COMMIT',
      ])
    }
  })
})

// ─── The push matrix ────────────────────────────────────────────────────────────────────────

const ROW = throwaway(0xa1)
const TOKEN = '2026-11-03 02:15:09.1234+00'
const STALE = '2026-11-03 02:15:08+00'
const IN_PAYLOAD = {
  plain: JSON.parse(v5Payload('incoming')) as unknown,
  envelope: { st: 5, k: 1, r: 'r2', iv: 'BBBBBBBBBBBBBBBB', z: 0, ct: 'BBBB' },
  marker: movedMarker('rotated', '2026-11-15T05:00:00.000Z'),
} as const
const EXISTING = {
  missing: null,
  plain: JSON.parse(v5Payload('existing')) as unknown,
  envelope: { st: 5, k: 1, r: 'r1', iv: 'AAAAAAAAAAAAAAAA', z: 0, ct: 'AAAA' },
  marker: movedMarker('private', '2026-11-15T04:00:00.000Z'),
} as const
type Existing = keyof typeof EXISTING
type Incoming = keyof typeof IN_PAYLOAD
const MODES = {
  create: { base: null, force: false },
  'cas exact token': { base: TOKEN, force: false },
  'cas stale token': { base: STALE, force: false },
  force: { base: null, force: true },
} as const
type Mode = keyof typeof MODES

interface Outcome {
  readonly answer: string
  readonly token: 'current' | 'new' | 'null'
  readonly row: 'existing' | 'incoming' | 'other' | 'none'
}

async function outcome(relay: PgRelay, ex: Existing, inc: Incoming, mode: Mode): Promise<Outcome> {
  await relay.run(`DELETE FROM public.sync_buckets`)
  const existing = EXISTING[ex]
  if (existing !== null) {
    await relay.seed([{ id: ROW, payload: JSON.stringify(existing), updatedAt: TOKEN }])
  }
  const { base, force } = MODES[mode]
  const res = await relay.as('anon', (tx) =>
    tx.query<{ r: { ok: boolean; reason?: string; updated_at: string | null }; same: boolean }>(
      `SELECT s.r, (s.r ->> 'updated_at')::timestamptz = $5::timestamptz AS same
         FROM (SELECT public.st_sync_push($1, $2::jsonb, $3::timestamptz, $4) AS r) AS s`,
      [ROW, JSON.stringify(IN_PAYLOAD[inc]), base, force, TOKEN],
    ),
  )
  const r = res.rows[0]
  if (r === undefined) throw new Error('no answer')
  // compared in Postgres: jsonb keeps its own key order
  const held = await relay.rows<{ row: Outcome['row'] }>(
    `SELECT CASE WHEN payload = $2::jsonb THEN 'existing' WHEN payload = $3::jsonb THEN 'incoming'
                 ELSE 'other' END AS row
       FROM public.sync_buckets WHERE sync_id = $1`,
    [ROW, JSON.stringify(existing), JSON.stringify(IN_PAYLOAD[inc])],
  )
  return {
    answer: r.r.ok ? 'ok' : (r.r.reason ?? 'no reason'),
    token: r.r.updated_at === null ? 'null' : r.same ? 'current' : 'new',
    row: held[0]?.row ?? 'none',
  }
}

async function matrix(relay: PgRelay): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>()
  for (const ex of Object.keys(EXISTING) as Existing[]) {
    for (const inc of Object.keys(IN_PAYLOAD) as Incoming[]) {
      for (const mode of Object.keys(MODES) as Mode[]) {
        out.set(`${ex} ← ${inc}, ${mode}`, await outcome(relay, ex, inc, mode))
      }
    }
  }
  return out
}

/** What 006 changes: a plain copy or an envelope over a marker, by exact token or forced. */
const CHANGED = new Set(
  (['plain', 'envelope'] as const).flatMap((inc) =>
    (['cas exact token', 'force'] as const).map((mode) => `marker ← ${inc}, ${mode}`),
  ),
)

describe('006: the push matrix against 004 (existing × incoming × create / CAS / stale / force)', () => {
  it(
    'answers exactly as 004 everywhere but a non-marker over a marker, which is a conflict with the current token that writes nothing',
    async () => {
      const only004 = await matrix(await relayAt('004'))
      const with006 = await matrix(await relayAt('004', '006'))
      const with005and006 = await matrix(await relayAt('005', '006'))
      expect(only004.size).toBe(48)
      expect([...with005and006]).toEqual([...with006])
      for (const [key, was] of only004) {
        const now = with006.get(key)
        if (CHANGED.has(key)) {
          expect(was, `004: ${key}`).toEqual({ answer: 'ok', token: 'new', row: 'incoming' })
          expect(now, `006: ${key}`).toEqual({
            answer: 'conflict',
            token: 'current',
            row: 'existing',
          })
        } else {
          expect(now, key).toEqual(was)
        }
      }
      // spot checks of what stays: a marker still replaces a marker, a plain copy, an envelope
      for (const ex of ['marker', 'plain', 'envelope'] as const) {
        for (const mode of ['cas exact token', 'force'] as const) {
          expect(with006.get(`${ex} ← marker, ${mode}`), `${ex} ← marker, ${mode}`).toEqual({
            answer: 'ok',
            token: 'new',
            row: 'incoming',
          })
        }
      }
      expect(with006.get('marker ← plain, cas stale token')).toEqual({
        answer: 'conflict',
        token: 'current',
        row: 'existing',
      })
      expect(with006.get('missing ← plain, force')).toEqual({
        answer: 'missing',
        token: 'null',
        row: 'none',
      })
      expect(with006.get('marker ← plain, create')).toEqual({
        answer: 'conflict',
        token: 'current',
        row: 'existing',
      })
    },
    SLOW,
  )

  it(
    'recognises a marker by 004 shape only: "expenses" the string "moved" and "x5" an object',
    async () => {
      const relay = await relayAt('004', '006')
      const forced = async (existing: unknown): Promise<string> => {
        await relay.run(`DELETE FROM public.sync_buckets`)
        await relay.seed([{ id: ROW, payload: JSON.stringify(existing), updatedAt: TOKEN }])
        const res = await relay.as('anon', (tx) =>
          tx.query<{ r: { ok: boolean; reason?: string } }>(
            `SELECT public.st_sync_push($1, $2::jsonb, NULL, true) AS r`,
            [ROW, v5Payload('incoming')],
          ),
        )
        const r = res.rows[0]?.r
        return r?.ok === true ? 'ok' : (r?.reason ?? 'none')
      }
      // markers as every writer makes them, extra fields or not
      expect(await forced(movedMarker('stopped', '2026-11-15T04:00:00.000Z'))).toBe('conflict')
      expect(await forced({ expenses: 'moved', x5: {} })).toBe('conflict')
      expect(await forced({ expenses: 'moved', x5: { min: 99 }, by: 'dev001' })).toBe('conflict')
      // rows written straight to the table before 004's checks, which no relay function accepts
      // as a marker either, are not kept
      expect(await forced({ expenses: 'moved' })).toBe('ok')
      expect(await forced({ expenses: 'moved', x5: 'text' })).toBe('ok')
      expect(await forced({ expenses: 'Moved', x5: {} })).toBe('ok')
      // a v5 copy that carries x5.moved is a plain copy to the relay (the app never writes one)
      expect(await forced({ expenses: [], x5: { moved: { why: 'private' } } })).toBe('ok')
    },
    SLOW,
  )
})

// ─── Prune ─────────────────────────────────────────────────────────────────────────────────

describe('006: prune keeps a moved marker four times as long', () => {
  it(
    'a marker older than stale_after but younger than 4x stays, one older than 4x goes; plain and junk rows go as before; 004 alone pruned the marker at 1x',
    async () => {
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
      const marker = JSON.stringify(EXISTING.marker)
      const seedOld = async (relay: PgRelay) => {
        await relay.seed([
          { id: throwaway(0xb1), payload: marker, updatedAt: ago(100) }, // over 90, under 360
          { id: throwaway(0xb2), payload: v5Payload('old'), updatedAt: ago(100) },
          { id: throwaway(0xb3), payload: v5Payload('recent') },
          {
            id: throwaway(0xb4),
            payload: JSON.stringify({ expenses: 'moved' }),
            updatedAt: ago(100),
          },
          { id: throwaway(0xb5), payload: marker, updatedAt: ago(359) }, // just under 4 x 90
          { id: throwaway(0xb6), payload: marker, updatedAt: ago(361) }, // just over 4 x 90
        ])
      }
      const left = async (relay: PgRelay, staleAfter = '90 days') => {
        const removed = await relay.rows<{ n: string }>(
          `SELECT public.prune_stale_sync_buckets($1::interval)::text AS n`,
          [staleAfter],
        )
        const rows = await relay.rows<{ id: string }>(
          `SELECT sync_id AS id FROM public.sync_buckets ORDER BY 1`,
        )
        return { removed: removed[0]?.n, left: rows.map((r) => r.id) }
      }
      const kept = [throwaway(0xb1), throwaway(0xb3), throwaway(0xb5)]
      const with006 = await relayAt('004', '006')
      await seedOld(with006)
      expect(await left(with006)).toEqual({ removed: '3', left: kept })
      // the default argument is 90 days too
      await with006.run(`DELETE FROM public.sync_buckets`)
      await seedOld(with006)
      await with006.run(`SELECT public.prune_stale_sync_buckets()`)
      expect(
        (
          await with006.rows<{ id: string }>(
            `SELECT sync_id AS id FROM public.sync_buckets ORDER BY 1`,
          )
        ).map((r) => r.id),
      ).toEqual(kept)
      // another stale_after scales the same way: 30 days keeps a marker up to 120
      await with006.run(`DELETE FROM public.sync_buckets`)
      await seedOld(with006)
      expect((await left(with006, '30 days')).left).toEqual([throwaway(0xb1), throwaway(0xb3)])
      const locked = await relayAt('005', '006')
      await seedOld(locked)
      expect((await left(locked)).left).toEqual(kept)
      const only004 = await relayAt('004')
      await seedOld(only004)
      expect(await left(only004)).toEqual({ removed: '5', left: [throwaway(0xb3)] })
      // still nobody but the owner may run it
      const f = await failureOf(() =>
        with006.as('anon', (tx) => tx.query(`SELECT public.prune_stale_sync_buckets()`)),
      )
      expect(f.code).toBe('42501')
    },
    SLOW,
  )
})

// ─── Apply order, idempotence, refusals, rollback ──────────────────────────────────────────

/** Rows a relay may hold: a plain copy, an envelope, a marker, junk, an old row. */
async function seedRows(relay: PgRelay): Promise<void> {
  // fixed times, so two relays seeded alike hold the same data; ids no check uses
  const at = (updatedAt: string) => ({ updatedAt, createdAt: '2025-01-01 00:00:00+00' })
  await relay.seed([
    { id: throwaway(0x9c1), payload: v5Payload('plain'), ...at('2026-11-14 00:00:00+00') },
    {
      id: throwaway(0x9c2),
      payload: JSON.stringify(EXISTING.envelope),
      ...at('2026-11-14 00:00:00+00'),
    },
    {
      id: throwaway(0x9c3),
      payload: JSON.stringify(EXISTING.marker),
      ...at('2026-11-14 00:00:00+00'),
    },
    { id: throwaway(0x9c4), payload: v5Payload('old'), ...at('2025-01-01 00:00:00+00') },
  ])
}

const FUNCTION_REFUSAL =
  'SpendTrack 006: the sync functions from 004 are missing or not as 004 made them. Apply 004 and run 004_verify.sql first. Nothing was changed.'

describe('006: apply order with 005, twice, and no row touched', () => {
  it(
    'applies over 004 alone and over 004 + 005; before or after 005 gives the same catalog; a second run changes nothing',
    async () => {
      const a = await relayAt('004')
      await seedRows(a)
      const data = await a.dataSnapshot()
      const post004 = await a.catalogSnapshot()
      await a.apply('006')
      const after006 = await a.catalogSnapshot()
      expect(after006).not.toBe(post004)
      await a.apply('006')
      expect(await a.catalogSnapshot()).toBe(after006)
      expect(await a.dataSnapshot()).toBe(data)
      await a.apply('005') // 005 accepts 006's functions: they are still as 004 made them
      const sixThenFive = await a.catalogSnapshot()
      expect(await a.dataSnapshot()).toBe(data)

      const b = await relayAt('005')
      await seedRows(b)
      await b.apply('006')
      await b.apply('006')
      expect(await b.catalogSnapshot()).toBe(sixThenFive)
      expect(await b.dataSnapshot()).toBe(data)

      // only the two function bodies and the push comment differ from 004
      const diff = (x: string, y: string) => {
        const fx = (JSON.parse(x) as { functions: Record<string, unknown>[] }).functions
        const fy = (JSON.parse(y) as { functions: Record<string, unknown>[] }).functions
        const rest = (o: string) => {
          const { functions: _f, ...others } = JSON.parse(o) as Record<string, unknown>
          return JSON.stringify(others)
        }
        expect(rest(y)).toBe(rest(x))
        return fx.flatMap((f, i) =>
          Object.keys(f)
            .filter((k) => JSON.stringify(f[k]) !== JSON.stringify(fy[i]?.[k]))
            .map((k) => `${String(f.sig)} ${k}`),
        )
      }
      expect(diff(post004, after006)).toEqual([
        'prune_stale_sync_buckets(interval) source_md5',
        'st_sync_push(text,jsonb,timestamp with time zone,boolean) comment',
        'st_sync_push(text,jsonb,timestamp with time zone,boolean) source_md5',
      ])
    },
    SLOW,
  )

  it(
    'refuses (55000), changing nothing, before 004, as someone else, with an altered function, or without prune',
    async () => {
      const early = await relayAt('001-003')
      const before = await early.catalogSnapshot()
      const missing = await failureOf(() => early.apply('006'))
      expect([missing.code, missing.message]).toEqual(['55000', FUNCTION_REFUSAL])
      expect(await early.catalogSnapshot()).toBe(before)

      const relay = await relayAt('004')
      const post004 = await relay.catalogSnapshot()
      await relay.login(STRANGER)
      const stranger = await failureOf(() => relay.apply('006'))
      expect([stranger.code, stranger.message]).toEqual([
        '55000',
        `SpendTrack 006: run this as the table owner (${OWNER}); you are ${STRANGER}. Nothing was changed.`,
      ])
      await relay.login(OWNER)
      for (const [mutate, restore] of [
        [
          `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) SECURITY INVOKER`,
          `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) SECURITY DEFINER`,
        ],
        [
          `REVOKE EXECUTE ON FUNCTION public.st_sync_pull(text) FROM anon`,
          `GRANT EXECUTE ON FUNCTION public.st_sync_pull(text) TO anon`,
        ],
      ] as const) {
        await relay.run(mutate)
        const altered = await relay.catalogSnapshot()
        const f = await failureOf(() => relay.apply('006'))
        expect([f.code, f.message], mutate).toEqual(['55000', FUNCTION_REFUSAL])
        expect(await relay.catalogSnapshot(), mutate).toBe(altered)
        await relay.run(restore)
      }
      expect(await relay.catalogSnapshot()).toBe(post004)
      await relay.run(`DROP FUNCTION public.prune_stale_sync_buckets(interval)`)
      const noPrune = await relay.catalogSnapshot()
      const p = await failureOf(() => relay.apply('006'))
      expect([p.code, p.message]).toEqual([
        '55000',
        `SpendTrack 006: public.prune_stale_sync_buckets(interval) is missing or not owned by the table owner (${OWNER}). Tell the lead. Nothing was changed.`,
      ])
      expect(await relay.catalogSnapshot()).toBe(noPrune)
    },
    SLOW,
  )

  it(
    'never creates a function with default grants, even for a client that runs on after the first error',
    async () => {
      const withoutPre = (sql: string): string => {
        const out = sql.replace(/DO \$pre\$[\s\S]*?\$pre\$;\n/, '')
        expect(out).not.toBe(sql)
        return out
      }
      for (const m of ['006', '006-rollback'] as const) {
        const early = await relayAt('001-003')
        const before = await early.catalogSnapshot()
        const g = await failureOf(() => early.run(withoutPre(migrationSql(m))))
        expect(g.code, m).toBe('55000')
        expect(g.message, m).toMatch(/^SpendTrack 006( rollback)?: the preconditions failed/)
        expect(await early.catalogSnapshot(), m).toBe(before)
      }
    },
    SLOW,
  )

  it(
    'is all or nothing: a failure before COMMIT leaves the catalog as it was',
    async () => {
      const relay = await relayAt('004')
      const before = await relay.catalogSnapshot()
      const broken = migrationSql('006').replace(/^COMMIT;$/m, 'SELECT 1 / 0;\nCOMMIT;')
      expect(broken).not.toBe(migrationSql('006'))
      expect((await failureOf(() => relay.run(broken))).code).toBe('22012')
      expect(await relay.catalogSnapshot()).toBe(before)
    },
    SLOW,
  )

  it(
    "running 004 again puts back 004's push (and keeps 006's prune); running 006 again restores it",
    async () => {
      const relay = await relayAt('004', '006')
      const after006 = await relay.catalogSnapshot()
      /** [prune, push] source digests. */
      const sources = async (r: PgRelay) =>
        (
          await r.rows<{ m: string }>(
            `SELECT md5(prosrc) AS m FROM pg_proc
              WHERE proname IN ('prune_stale_sync_buckets', 'st_sync_push') ORDER BY proname`,
          )
        ).map((x) => x.m)
      const with006 = await sources(relay)
      const only004 = await sources(await relayAt('004'))
      await relay.apply('004')
      expect(await sources(relay)).toEqual([with006[0], only004[1]])
      await relay.apply('006')
      expect(await relay.catalogSnapshot()).toBe(after006)
    },
    SLOW,
  )
})

describe('006 rollback', () => {
  it(
    'gives back the exact post-004 and post-005 catalogs, twice is once, no row is touched, and it is harmless without 006',
    async () => {
      for (const stage of ['004', '005'] as const) {
        const relay = await relayAt(stage)
        await seedRows(relay)
        const data = await relay.dataSnapshot()
        const before = await relay.catalogSnapshot()
        await relay.apply('006-rollback') // never applied: nothing changes
        expect(await relay.catalogSnapshot(), stage).toBe(before)
        await relay.apply('006')
        await relay.apply('006-rollback')
        expect(await relay.catalogSnapshot(), stage).toBe(before)
        await relay.apply('006-rollback')
        expect(await relay.catalogSnapshot(), stage).toBe(before)
        expect(await relay.dataSnapshot(), stage).toBe(data)
      }
    },
    SLOW,
  )

  it(
    'with 005: 006, 005 rollback, 006 rollback, 005 again reproduces each earlier snapshot; the 004 rollback still works after the 006 rollback',
    async () => {
      const relay = await relayAt('004')
      const post004 = await relay.catalogSnapshot()
      await relay.apply('005')
      const post005 = await relay.catalogSnapshot()
      await relay.apply('006')
      await relay.apply('005-rollback')
      await relay.apply('006-rollback')
      expect(await relay.catalogSnapshot()).toBe(post004)
      await relay.apply('005')
      expect(await relay.catalogSnapshot()).toBe(post005)
      await relay.apply('005-rollback')
      await relay.apply('006')
      await relay.apply('006-rollback')
      await relay.apply('004-rollback')
      expect(await relay.rows(`SELECT 1 FROM pg_proc WHERE proname LIKE 'st\\_sync\\_%'`)).toEqual(
        [],
      )
    },
    SLOW,
  )

  it(
    'is refused (55000) once the 004 functions are gone (run it before the 004 rollback)',
    async () => {
      const relay = await relayAt('004', '006', '004-rollback')
      const before = await relay.catalogSnapshot()
      const f = await failureOf(() => relay.apply('006-rollback'))
      expect([f.code, f.message]).toEqual([
        '55000',
        'SpendTrack 006 rollback: the sync functions from 004 are missing or not as 004 made them. Tell the lead. Nothing was changed.',
      ])
      expect(await relay.catalogSnapshot()).toBe(before)
    },
    SLOW,
  )
})

// ─── The owner's checks ────────────────────────────────────────────────────────────────────

interface Verdict {
  readonly n: number
  readonly check: string
  readonly actual: string
  readonly pass: boolean
}

const VERIFY_006 = [
  'functions_intact',
  'prune_intact',
  'throwaway_ids_free',
  'acting_as_anon',
  'marker_kept_on_cas',
  'marker_kept_on_force',
  'marker_kept_on_forced_envelope',
  'marker_replaces_marker',
  'plain_still_written',
  'marker_replaces_plain',
  'prune_keeps_moved',
  'nothing_left_behind',
]
/** What 006_verify reports where 006 is not applied (004's push and 003's prune). */
const WITHOUT_006 = [
  'marker_kept_on_cas',
  'marker_kept_on_force',
  'marker_kept_on_forced_envelope',
  'prune_keeps_moved',
]

/** A check file's table; it must leave no catalog change, no row, no id in any cell. */
async function verify(relay: PgRelay, c: CheckFile): Promise<Verdict[]> {
  const catalog = await relay.catalogSnapshot()
  const data = await relay.dataSnapshot()
  const raw = await relay.check(c)
  expect(await relay.catalogSnapshot(), `${c} left a catalog change`).toBe(catalog)
  expect(await relay.dataSnapshot(), `${c} left a row`).toBe(data)
  for (const v of raw.flatMap((r) => Object.values(r))) expect(String(v)).not.toMatch(UUID_RE)
  expect(await relay.rows<{ u: string }>(`SELECT current_user AS u`)).toEqual([{ u: OWNER }])
  return raw.map((r) => ({
    n: Number(r.n),
    check: String(r.check ?? r.item),
    actual: String(r.actual ?? r.value),
    pass: r.pass === true || r.stop === false,
  }))
}
const result = (rows: readonly Verdict[]): Verdict => {
  const r = rows[0]
  if (r === undefined || (r.check !== 'RESULT' && r.check !== 'verdict')) throw new Error('row 0')
  return r
}
const failed = (rows: readonly Verdict[]): string[] =>
  rows.filter((r) => r.n > 0 && !r.pass).map((r) => r.check)

describe('the checks with 006 (004_verify, 005_verify, 006_verify, preflight)', () => {
  it(
    '004 + 006: 004_verify and 006_verify PASS; the preflight says GO, 004 applied',
    async () => {
      const relay = await relayAt('004', '006')
      await seedRows(relay)
      expect(result(await verify(relay, '004_verify')).actual).toBe('PASS 34/34')
      const rows = await verify(relay, '006_verify')
      expect(rows.map((r) => r.check)).toEqual(['RESULT', ...VERIFY_006])
      expect(result(rows).actual).toBe('PASS 12/12')
      expect(rows.find((r) => r.check === 'acting_as_anon')?.actual).toBe('anon')
      const pre = await verify(relay, 'preflight')
      expect(pre.slice(0, 2).map((r) => r.actual)).toEqual(['GO', '004 applied'])
    },
    SLOW,
  )

  it(
    '004 + 005 + 006 (either order): 005_verify and 006_verify PASS; at the caps too; the preflight says GO, 005 applied',
    async () => {
      for (const order of [
        ['005', '006'],
        ['006', '005'],
      ] as const) {
        const relay = await relayAt('004', ...order)
        await seedRows(relay)
        expect(result(await verify(relay, '005_verify')).actual, order.join()).toBe('PASS 20/20')
        expect(result(await verify(relay, '006_verify')).actual, order.join()).toBe('PASS 12/12')
        const pre = await verify(relay, 'preflight')
        expect(pre.slice(0, 2).map((r) => r.actual)).toEqual(['GO', '005 applied'])
      }
      const full = await relayAt('005', '006')
      await full.fill({ count: 500, createdAgo: '5 minutes' })
      expect(failed(await verify(full, '006_verify'))).toEqual([])
    },
    SLOW,
  )

  it(
    'without 006 (004, or 004 + 005), and after the 006 rollback: the gate checks still PASS; 006_verify FAILs by name',
    async () => {
      const at004 = await relayAt('004')
      expect(result(await verify(at004, '004_verify')).actual).toBe('PASS 34/34')
      expect(failed(await verify(at004, '006_verify'))).toEqual(WITHOUT_006)
      const at005 = await relayAt('005')
      expect(result(await verify(at005, '005_verify')).actual).toBe('PASS 20/20')
      const six = await verify(at005, '006_verify')
      expect(failed(six)).toEqual(WITHOUT_006)
      expect(result(six).actual).toBe(`FAIL 4/12: ${WITHOUT_006.join(', ')}`)
      for (const stage of ['004', '005'] as const) {
        const relay = await relayAt(stage, '006', '006-rollback')
        const gate = stage === '004' ? '004_verify' : '005_verify'
        expect(failed(await verify(relay, gate)), stage).toEqual([])
        expect(failed(await verify(relay, '006_verify')), stage).toEqual(WITHOUT_006)
      }
    },
    SLOW,
  )

  it(
    'FAILs when a function was altered, and when 004 was run again over 006',
    async () => {
      const relay = await relayAt('005', '006')
      const cases: readonly (readonly [string, string, readonly string[], CheckFile | null])[] = [
        [
          `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) SECURITY INVOKER`,
          `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) SECURITY DEFINER`,
          // as invoker under the lockdown, anon cannot reach the table at all
          [
            'functions_intact',
            'marker_kept_on_cas',
            'marker_kept_on_force',
            'marker_kept_on_forced_envelope',
            'marker_replaces_marker',
            'plain_still_written',
            'marker_replaces_plain',
          ],
          '005_verify',
        ],
        [
          `ALTER FUNCTION public.st_sync_head(text) RESET search_path`,
          `ALTER FUNCTION public.st_sync_head(text) SET search_path = ''`,
          ['functions_intact'],
          '005_verify',
        ],
        [
          `GRANT EXECUTE ON FUNCTION public.st_sync_pull(text) TO PUBLIC`,
          `REVOKE EXECUTE ON FUNCTION public.st_sync_pull(text) FROM PUBLIC`,
          ['functions_intact'],
          null,
        ],
        [
          `ALTER FUNCTION public.prune_stale_sync_buckets(interval) RESET search_path`,
          `ALTER FUNCTION public.prune_stale_sync_buckets(interval) SET search_path = ''`,
          ['prune_intact'],
          null,
        ],
        [
          `GRANT EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) TO anon`,
          `REVOKE EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) FROM anon`,
          ['prune_intact'],
          '005_verify',
        ],
      ]
      for (const [mutate, restore, expected, alsoFails] of cases) {
        await relay.run(mutate)
        expect(failed(await verify(relay, '006_verify')), mutate).toEqual(expected)
        if (alsoFails !== null) {
          expect(result(await verify(relay, alsoFails)).pass, `${alsoFails}: ${mutate}`).toBe(false)
        }
        await relay.run(restore)
        expect(failed(await verify(relay, '006_verify')), `${mutate} restored`).toEqual([])
      }
      // 004's text again (its functions' settings unchanged): the gate checks cannot see it,
      // 006_verify can
      await relay.apply('004')
      expect(result(await verify(relay, '005_verify')).pass).toBe(true)
      expect(failed(await verify(relay, '006_verify'))).toEqual([
        'marker_kept_on_cas',
        'marker_kept_on_force',
        'marker_kept_on_forced_envelope',
      ])
    },
    SLOW,
  )

  it(
    'still PASSes when the editor cannot act as anon (the calls run as the editor), and refuses its own ids in use',
    async () => {
      const relay = await relayAt('005', '006')
      await relay.superuser(`REVOKE anon FROM ${OWNER}`)
      const rows = await verify(relay, '006_verify')
      expect(rows.find((r) => r.check === 'acting_as_anon')?.actual).toBe(
        `SKIPPED: could not act as anon here; the calls below ran as ${OWNER}`,
      )
      expect(result(rows).pass).toBe(true)
      await relay.superuser(`GRANT anon TO ${OWNER}`)
      await relay.seed([{ id: '00000000-0000-4000-8000-0000000000f3', payload: v5Payload() }])
      const busy = await verify(relay, '006_verify')
      // as in 004_verify: the row it would not touch is still there at the end
      expect(failed(busy)).toEqual(['throwaway_ids_free', 'nothing_left_behind'])
      expect(busy.map((r) => r.check)).not.toContain('marker_kept_on_cas')
    },
    SLOW,
  )

  it(
    "004_verify needed its marker check moved: in 004's old order it FAILs on 006 (a plain write over its own marker)",
    async () => {
      const sql = checkSql('004_verify')
      const block =
        /\n {6}-- after the plain writes above[^\n]*\n( {6}BEGIN\n[\s\S]*?'moved_marker_accepted'[^\n]*\n[^\n]*\n)/.exec(
          sql,
        )
      if (block?.[1] === undefined) throw new Error('marker block not found')
      const old = sql
        .replace(block[0], '\n')
        .replace(
          "      v_a := '';\n      FOREACH v_id IN",
          `${block[1]}\n      v_a := '';\n      FOREACH v_id IN`,
        )
      expect(old).not.toBe(sql)
      const relay = await relayAt('004', '006')
      await relay.run(old.replace(/SELECT \* FROM pg_temp\.st_verify_004\(\);\n$/, ''))
      const rows = await relay.rows<{ check: string; pass: boolean }>(
        `SELECT "check", pass FROM pg_temp.st_verify_004()`,
      )
      expect(rows.filter((r) => !r.pass).map((r) => r.check)).toEqual([
        'RESULT',
        'size_limit_exact',
      ])
    },
    SLOW,
  )
})

// ─── 0.21.0's RPC transport ────────────────────────────────────────────────────────────────

type Service = typeof import('../../services/syncService')

describe('006 and the released RPC transport (src/services/syncService.ts, unmodified)', () => {
  it(
    'a forced or exact-etag plain write over a marker is a conflict and the row keeps the marker; a marker still replaces it; 004 alone let the forced write land',
    async () => {
      const run = async (with006: boolean) => {
        const relay = await relayAt('004', ...(with006 ? (['006'] as const) : []))
        const rest = pgRest(relay)
        vi.stubGlobal('fetch', rest.fetch)
        vi.stubEnv('VITE_SUPABASE_URL', 'http://relay.test')
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'invented-anon-key')
        vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
        vi.resetModules()
        const svc: Service = await import('../../services/syncService')
        const { transport: t } = await svc.openTransport(
          ROW,
          { mode: null, probedAt: 0 },
          Date.now(),
          false,
        )
        expect(t.mode).toBe('rpc')
        const opts = (base: string | null, force: boolean) => ({ base, force, keepalive: false })
        const created = await t.push(ROW, EXISTING.marker, opts(null, false))
        if (!created.ok) throw new Error('no marker row')
        const forced = await t.push(ROW, IN_PAYLOAD.plain, opts(created.etag, true))
        return { t, rest, created, forced, opts }
      }

      const before = await run(false)
      expect(before.forced).toMatchObject({ ok: true })
      expect((await before.t.pull(ROW))?.payload).toEqual(IN_PAYLOAD.plain)

      const { t, rest, created, forced, opts } = await run(true)
      expect(forced).toEqual({ ok: false, reason: 'conflict' })
      expect(await t.push(ROW, IN_PAYLOAD.plain, opts(created.etag, false))).toEqual({
        ok: false,
        reason: 'conflict',
      })
      expect(await t.push(ROW, IN_PAYLOAD.envelope, opts(created.etag, true))).toEqual({
        ok: false,
        reason: 'conflict',
      })
      expect(await t.pull(ROW)).toEqual({ payload: EXISTING.marker, etag: created.etag })
      expect(await t.head(ROW)).toBe(created.etag)
      const again = await t.push(ROW, IN_PAYLOAD.marker, opts(created.etag, false))
      expect(again).toMatchObject({ ok: true })
      expect((await t.pull(ROW))?.payload).toEqual(IN_PAYLOAD.marker)
      expect(rest.log.every((r) => r.status === 200)).toBe(true)
    },
    SLOW,
  )

  it(
    'guards the functions only: until 005, the released table transport (upsert and CAS PATCH) still replaces a marker; with 005 the table refuses it',
    async () => {
      const tableTransport = async (relay: PgRelay, cas: boolean) => {
        vi.stubGlobal('fetch', pgRest(relay).fetch)
        vi.stubEnv('VITE_SUPABASE_URL', 'http://relay.test')
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'invented-anon-key')
        vi.stubEnv('VITE_SYNC_RELAY', 'table')
        vi.stubEnv('VITE_SYNC_CAS', cas ? 'on' : '')
        vi.resetModules()
        const svc: Service = await import('../../services/syncService')
        const { transport } = await svc.openTransport(
          ROW,
          { mode: null, probedAt: 0 },
          Date.now(),
          false,
        )
        expect(transport.mode).toBe('table')
        return transport
      }
      const opts = (base: string | null) => ({ base, force: false, keepalive: false })
      for (const cas of [false, true]) {
        const relay = await relayAt('004', '006')
        await relay.seed([{ id: ROW, payload: JSON.stringify(EXISTING.marker), updatedAt: TOKEN }])
        const t = await tableTransport(relay, cas)
        const pulled = await t.pull(ROW)
        expect(pulled?.payload, `cas ${String(cas)}`).toEqual(EXISTING.marker)
        const res = await t.push(ROW, IN_PAYLOAD.plain, opts(pulled?.etag ?? null))
        expect(res, `cas ${String(cas)}`).toMatchObject({ ok: true })
        expect((await t.pull(ROW))?.payload, `cas ${String(cas)}`).toEqual(IN_PAYLOAD.plain)

        const locked = await relayAt('005', '006')
        await locked.seed([{ id: ROW, payload: JSON.stringify(EXISTING.marker), updatedAt: TOKEN }])
        const l = await tableTransport(locked, cas)
        await expect(
          l.push(ROW, IN_PAYLOAD.plain, opts(null)),
          `cas ${String(cas)}`,
        ).rejects.toMatchObject({
          name: 'SyncTransportError',
          kind: 'permission',
        })
        const held = await locked.rows<{ moved: boolean }>(
          `SELECT payload = $2::jsonb AS moved FROM public.sync_buckets WHERE sync_id = $1`,
          [ROW, JSON.stringify(EXISTING.marker)],
        )
        expect(held).toEqual([{ moved: true }])
      }
    },
    SLOW,
  )
})

describe("the runbook's recovery of a moved note written by mistake", () => {
  it(
    'the look and the delete touch only the one moved row of that code, as the owner, after 005 too',
    async () => {
      const runbook =
        import.meta.glob<string>('/docs/brain/sync-runbook.md', {
          query: '?raw',
          import: 'default',
          eager: true,
        })['/docs/brain/sync-runbook.md'] ?? ''
      const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')
      const mine = blocks.filter((b) => b.includes('YOUR-SYNC-CODE'))
      expect(mine).toHaveLength(2)
      const [look, remove] = mine.map((b) => b.replaceAll('YOUR-SYNC-CODE', ROW))
      expect(look).toMatch(/^SELECT /)
      expect(remove).toMatch(/^DELETE /)
      const relay = await relayAt('005', '006')
      await relay.seed([
        { id: ROW, payload: JSON.stringify(EXISTING.marker) },
        { id: throwaway(0xa2), payload: JSON.stringify(EXISTING.marker) },
        { id: throwaway(0xa3), payload: v5Payload('plain') },
      ])
      expect((await relay.rows<{ sync_id: string }>(look ?? '')).map((r) => r.sync_id)).toEqual([
        ROW,
      ])
      expect((await relay.rows<{ sync_id: string }>(remove ?? '')).map((r) => r.sync_id)).toEqual([
        ROW,
      ])
      const left = await relay.rows<{ id: string }>(
        `SELECT sync_id AS id FROM public.sync_buckets ORDER BY 1`,
      )
      expect(left.map((r) => r.id)).toEqual([throwaway(0xa2), throwaway(0xa3)])
      // a plain row under that code is never removed by it
      await relay.seed([{ id: ROW, payload: v5Payload('plain') }])
      expect(await relay.rows(remove ?? '')).toEqual([])
    },
    SLOW,
  )
})
