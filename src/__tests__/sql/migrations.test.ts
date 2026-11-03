// @vitest-environment node
// Migrations 004 and 005 and their rollbacks on real Postgres (PR-5 track spec §3.2 to §3.5,
// contract tables B and C; AC-1 to AC-3, AC-8 to AC-12): applied as a non-superuser owner with
// Supabase's roles and default privileges emulated, twice each, over a relay holding junk that
// strangers could have written and an owner-like row. No step may change a row.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ownerDoc } from '../../data/__tests__/support/ownerShape'
import { encodeWire } from '../../data/core/wire'
import {
  bootRelay,
  closeTemplate,
  failureOf,
  checkSql,
  migrationSql,
  OWNER,
  STRANGER,
  supabaseFiles,
  throwaway,
  v5Payload,
  type PgRelay,
  type SeedRow,
} from '../pgRelay'

const SLOW = 60_000
const open: PgRelay[] = []

async function relayAt(stage: Parameters<typeof bootRelay>[0]): Promise<PgRelay> {
  const r = await bootRelay(stage)
  open.push(r)
  return r
}

afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})
afterAll(closeTemplate)

const OWNER_ROW = '5a0c6b8e-3f1d-4e2a-9b7c-1d2e3f4a5b6c'

/** What strangers holding the public key could have written before 004, plus the owner's row. */
function junk(): SeedRow[] {
  const big = 'x'.repeat(2_500_000)
  return [
    { id: 'not-a-uuid', payload: JSON.stringify({ version: '4.0', expenses: [] }) },
    { id: throwaway(0xb01), payload: '[1, 2, 3]' },
    { id: throwaway(0xb02), payload: JSON.stringify({ expenses: [], x5: { pad: big } }) },
    { id: throwaway(0xb03), payload: v5Payload('infinity'), updatedAt: 'infinity' },
    {
      id: throwaway(0xb04),
      payload: JSON.stringify({
        version: '4.0',
        exportDate: '2026-05-29T04:00:00.000Z',
        expenses: [{ id: 'legacy-1', itemName: 'Kopi', amount: 1.4, category: 'Food & Dining' }],
        categories: ['Food & Dining'],
        deletedIds: [],
      }),
      updatedAt: '2026-05-29 04:00:00+00',
      createdAt: '2026-05-29 04:00:00+00',
    },
    {
      id: OWNER_ROW,
      payload: JSON.stringify(encodeWire(ownerDoc(300, 7), { rev: 'r-owner', dev: 'laptop' })),
      updatedAt: '2026-11-02 23:15:09.123456+00',
    },
  ]
}

interface Privs {
  readonly role: string
  readonly sel: boolean
  readonly ins: boolean
  readonly upd: boolean
  readonly del: boolean
  readonly trunc: boolean
  readonly refs: boolean
  readonly trig: boolean
  readonly prune: boolean
}

/** What anon and authenticated may do (has_*_privilege), and what PUBLIC is granted (the ACLs). */
async function privileges(relay: PgRelay): Promise<Privs[]> {
  const roles = await relay.rows<Privs>(`
    SELECT r AS role,
           has_table_privilege(r, 'public.sync_buckets', 'SELECT') AS sel,
           has_table_privilege(r, 'public.sync_buckets', 'INSERT') AS ins,
           has_table_privilege(r, 'public.sync_buckets', 'UPDATE') AS upd,
           has_table_privilege(r, 'public.sync_buckets', 'DELETE') AS del,
           has_table_privilege(r, 'public.sync_buckets', 'TRUNCATE') AS trunc,
           has_table_privilege(r, 'public.sync_buckets', 'REFERENCES') AS refs,
           has_table_privilege(r, 'public.sync_buckets', 'TRIGGER') AS trig,
           has_function_privilege(r, 'public.prune_stale_sync_buckets(interval)', 'EXECUTE') AS prune
      FROM unnest(ARRAY['anon', 'authenticated']) AS r ORDER BY r`)
  const acl = await relay.rows<{ readonly tbl: string[]; readonly fn: string[] }>(`
    SELECT ARRAY(SELECT a.privilege_type FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                  WHERE c.oid = 'public.sync_buckets'::regclass AND a.grantee = 0) AS tbl,
           ARRAY(SELECT a.privilege_type FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = 'public.prune_stale_sync_buckets(interval)'::regprocedure AND a.grantee = 0) AS fn`)
  const tbl = acl[0]?.tbl ?? []
  const fn = acl[0]?.fn ?? []
  return [
    ...roles,
    {
      role: 'PUBLIC',
      sel: tbl.includes('SELECT'),
      ins: tbl.includes('INSERT'),
      upd: tbl.includes('UPDATE'),
      del: tbl.includes('DELETE'),
      trunc: tbl.includes('TRUNCATE'),
      refs: tbl.includes('REFERENCES'),
      trig: tbl.includes('TRIGGER'),
      prune: fn.includes('EXECUTE'),
    },
  ]
}

interface FnFacts {
  readonly name: string
  readonly definer: boolean
  readonly config: string[] | null
  readonly owner: string
  readonly anon: boolean
  readonly authenticated: boolean
  readonly service: boolean
  readonly public_exec: boolean
  readonly volatility: string
}

const FUNCTIONS = `
SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
       p.provolatile::text AS volatility
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'st\\_sync\\_%'
 ORDER BY p.proname`

const CHECKS_004 = [
  'sync_buckets_id_uuid',
  'sync_buckets_payload_bounded',
  'sync_buckets_updated_at_finite',
]

async function guards(relay: PgRelay): Promise<string[]> {
  const rows = await relay.rows<{ readonly name: string }>(`
    SELECT conname AS name FROM pg_constraint
     WHERE conrelid = 'public.sync_buckets'::regclass AND contype = 'c'
    UNION ALL
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sync_buckets_created_at_idx'
    ORDER BY 1`)
  return rows.map((r) => r.name)
}

describe('004: applies as the owner, twice (AC-1, AC-3)', () => {
  it(
    'AC-1: 001→002→003→004 apply as a non-superuser owner; a second 004 changes nothing',
    async () => {
      const relay = await relayAt('none')
      const who = await relay.rows<{ readonly u: string; readonly su: boolean }>(
        `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`,
      )
      expect(who).toEqual([{ u: OWNER, su: false }])
      await relay.migrate('001-003')
      await relay.seed(junk())
      await relay.apply('004')
      const catalog = await relay.catalogSnapshot()
      const data = await relay.dataSnapshot()
      await relay.apply('004')
      expect(await relay.catalogSnapshot()).toBe(catalog)
      expect(await relay.dataSnapshot()).toBe(data)
    },
    SLOW,
  )

  it(
    'F-068 reproduced before 004 (table B): anon and authenticated may DELETE, TRUNCATE and prune',
    async () => {
      const relay = await relayAt('001-003')
      const before = await privileges(relay)
      expect(before.find((p) => p.role === 'anon')).toMatchObject({
        del: true,
        trunc: true,
        prune: true,
      })
      expect(before.find((p) => p.role === 'authenticated')).toMatchObject({
        del: true,
        prune: true,
      })
      await relay.seed([{ id: throwaway(0xa1), payload: v5Payload() }])
      const deleted = await relay.as('anon', (tx) =>
        tx.query(`DELETE FROM public.sync_buckets WHERE sync_id = $1`, [throwaway(0xa1)]),
      )
      expect(deleted.affectedRows).toBe(1)
    },
    SLOW,
  )

  it(
    'AC-3: after 004 nobody but the owner and service_role may DELETE, TRUNCATE, REFERENCES, TRIGGER or prune; SELECT/INSERT/UPDATE stay',
    async () => {
      const relay = await relayAt('004')
      for (const p of await privileges(relay)) {
        expect(p, p.role).toMatchObject({
          del: false,
          trunc: false,
          refs: false,
          trig: false,
          prune: false,
        })
        if (p.role !== 'PUBLIC')
          expect(p, p.role).toMatchObject({ sel: true, ins: true, upd: true })
      }
      const service = await relay.rows<{ readonly del: boolean }>(
        `SELECT has_table_privilege('service_role', 'public.sync_buckets', 'DELETE') AS del`,
      )
      expect(service).toEqual([{ del: true }])
      await relay.seed([{ id: throwaway(0xa1), payload: v5Payload() }])
      for (const sql of [
        `DELETE FROM public.sync_buckets WHERE sync_id = '${throwaway(0xa1)}'`,
        `TRUNCATE public.sync_buckets`,
        `SELECT public.prune_stale_sync_buckets(interval '1 second')`,
      ]) {
        for (const role of ['anon', 'authenticated'] as const) {
          const f = await failureOf(() => relay.as(role, (tx) => tx.query(sql)))
          expect(f.code, `${role}: ${sql}`).toBe('42501')
        }
      }
      expect(await relay.rows(`SELECT 1 FROM public.sync_buckets`)).toHaveLength(1)
    },
    SLOW,
  )

  it(
    'AC-3: the three functions are SECURITY DEFINER, search_path pinned, owned by the table owner, EXECUTE for anon/authenticated/service_role but not PUBLIC',
    async () => {
      const relay = await relayAt('004')
      const fns = await relay.rows<FnFacts>(FUNCTIONS)
      expect(fns.map((f) => f.name)).toEqual(['st_sync_head', 'st_sync_pull', 'st_sync_push'])
      for (const f of fns) {
        expect(f, f.name).toMatchObject({
          definer: true,
          config: ['search_path=""'],
          owner: OWNER,
          anon: true,
          authenticated: true,
          service: true,
          public_exec: false,
        })
      }
      expect(fns.map((f) => f.volatility)).toEqual(['s', 's', 'v'])
      const sigs = await relay.rows<{ readonly sig: string }>(
        `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'st\\_sync\\_%' ORDER BY 1`,
      )
      expect(sigs.map((s) => s.sig)).toEqual([
        'st_sync_head(text)',
        'st_sync_pull(text)',
        'st_sync_push(text,jsonb,timestamp with time zone,boolean)',
      ])
      expect(await guards(relay)).toEqual([...CHECKS_004, 'sync_buckets_created_at_idx'].sort())
      const valid = await relay.rows<{ readonly conname: string; readonly convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conrelid = 'public.sync_buckets'::regclass AND contype = 'c' ORDER BY 1`,
      )
      expect(valid.every((v) => !v.convalidated)).toBe(true)
    },
    SLOW,
  )
})

describe('the files as git commits them', () => {
  it('every SQL file under supabase/ has LF line ends only, so the tested bytes are the pasted ones', () => {
    const files = supabaseFiles()
    expect(files.map(([path]) => path).sort()).toEqual(
      [
        'checks/000_preflight_readonly.sql',
        'checks/004_verify.sql',
        'checks/005_verify.sql',
        'migrations/001_sync.sql',
        'migrations/002_sync_indexes.sql',
        'migrations/003_harden_prune_search_path.sql',
        'migrations/004_sync_rpc.rollback.sql',
        'migrations/004_sync_rpc.sql',
        'migrations/005_sync_lockdown.rollback.sql',
        'migrations/005_sync_lockdown.sql',
      ].map((f) => `/supabase/${f}`),
    )
    // .gitattributes normalises to LF on commit, and no formatter reads SQL
    for (const [path, text] of files) expect(text.includes('\r'), path).toBe(false)
  })
})

describe('st_sync_push under concurrency (reasoned, not executed: PGlite has one connection)', () => {
  it(
    'keeps the lines that make a push atomic and a racing create a conflict, in order, as installed',
    async () => {
      const relay = await relayAt('004')
      const rows = await relay.rows<{ readonly src: string }>(
        `SELECT prosrc AS src FROM pg_proc
          WHERE oid = 'public.st_sync_push(text, jsonb, timestamptz, boolean)'::regprocedure`,
      )
      const src = (rows[0]?.src ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ')
      const at = (needle: string): number => {
        const i = src.indexOf(needle)
        expect(i, needle).toBeGreaterThan(-1)
        expect(src.indexOf(needle, i + 1), `${needle} twice`).toBe(-1)
        return i
      }
      // creates: one at a time (a fixed advisory key), so a burst cannot overrun the caps
      const createLock = at('PERFORM pg_catalog.pg_advisory_xact_lock(7300400401);')
      // the hourly cap counts only rows created in the last hour and not dated in the future
      const hourCap = at(
        `interval '1 hour' AND b.created_at <= pg_catalog.clock_timestamp()) >= 20`,
      )
      // at the caps, the row is looked up again under the lock: a create that lost the race to
      // the same row is a conflict, never "full"
      const recheck = at(
        `>= 500 THEN SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row; IF FOUND THEN RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur); END IF; RAISE EXCEPTION 'relay is full' USING ERRCODE = '53400'; END IF;`,
      )
      const insert = at('INSERT INTO public.sync_buckets AS b')
      // a create racing past both looks (another session's commit) is a conflict, not 23505
      const onConflict = at(
        `ON CONFLICT (sync_id) DO NOTHING RETURNING b.updated_at INTO v_new; IF NOT FOUND THEN SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row; RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);`,
      )
      expect(
        createLock < hourCap && hourCap < recheck && recheck < insert && insert < onConflict,
      ).toBe(true)
      // CAS and force: the token is read under a row lock, compared, then matched again
      const rowLock = at(
        'SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row FOR UPDATE;',
      )
      const compare = at('IF NOT coalesce(p_force, false) AND v_cur IS DISTINCT FROM p_base THEN')
      const rematch = at(
        'WHERE b.sync_id = p_row AND b.updated_at IS NOT DISTINCT FROM v_cur RETURNING b.updated_at INTO v_new; IF NOT FOUND THEN',
      )
      expect(insert < rowLock && rowLock < compare && compare < rematch).toBe(true)
    },
    SLOW,
  )
})

describe('004: preconditions and atomicity', () => {
  it(
    'refuses (55000) without the table, without created_at, or as someone who is not the table owner; nothing is left open',
    async () => {
      const relay = await relayAt('none')
      const noTable = await failureOf(() => relay.apply('004'))
      expect(noTable.code).toBe('55000')
      expect(noTable.message).toBe(
        'SpendTrack 004: table public.sync_buckets not found. Run 001_sync.sql first. Nothing was changed.',
      )
      await relay.apply('001')
      const noCreated = await failureOf(() => relay.apply('004'))
      expect(noCreated.code).toBe('55000')
      expect(noCreated.message).toMatch(
        /^SpendTrack 004: .*Run 002_sync_indexes\.sql and 003_harden_prune_search_path\.sql first\. Nothing was changed\.$/,
      )
      await relay.apply('002')
      await relay.apply('003')
      const before = await relay.catalogSnapshot()
      await relay.login(STRANGER)
      const notOwner = await failureOf(() => relay.apply('004'))
      expect(notOwner.code).toBe('55000')
      expect(notOwner.message).toBe(
        `SpendTrack 004: run this as the table owner (${OWNER}); you are ${STRANGER}. Nothing was changed.`,
      )
      await relay.login(OWNER)
      expect(await relay.catalogSnapshot()).toBe(before)
      // the precondition runs before BEGIN: no transaction is left open to ROLLBACK
      await relay.db.exec(migrationSql('004').replace(/^BEGIN;$/m, 'BEGIN; SELECT 1;'))
      expect(await relay.catalogSnapshot()).not.toBe(before)
    },
    SLOW,
  )

  it(
    'refuses (55000) when a sync function exists with another signature or another owner',
    async () => {
      const relay = await relayAt('001-003')
      await relay.run(`CREATE FUNCTION public.st_sync_push(p_row text, p_payload jsonb)
                       RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$`)
      const before = await relay.catalogSnapshot()
      const overload = await failureOf(() => relay.apply('004'))
      expect(overload.code).toBe('55000')
      expect(overload.message).toMatch(
        /^SpendTrack 004: .*st_sync_push\(text, jsonb\) owned by st_owner.*Nothing was changed\.$/,
      )
      expect(await relay.catalogSnapshot()).toBe(before)
    },
    SLOW,
  )

  it(
    'is all or nothing: a failure before COMMIT leaves the catalog and data as they were',
    async () => {
      const relay = await relayAt('001-003')
      await relay.seed(junk())
      const catalog = await relay.catalogSnapshot()
      const data = await relay.dataSnapshot()
      const broken = migrationSql('004').replace(/^COMMIT;$/m, 'SELECT 1 / 0;\nCOMMIT;')
      expect(broken).not.toBe(migrationSql('004'))
      const f = await failureOf(() => relay.run(broken))
      expect(f.code).toBe('22012')
      expect(await relay.catalogSnapshot()).toBe(catalog)
      expect(await relay.dataSnapshot()).toBe(data)
    },
    SLOW,
  )
})

describe('table writes after 004 (AC-8, table B)', () => {
  const upsert = `INSERT INTO public.sync_buckets AS b (sync_id, payload, updated_at)
                  VALUES ($1, $2::jsonb, $3::timestamptz)
                  ON CONFLICT (sync_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
                  RETURNING b.updated_at::text AS t`
  const cas = `UPDATE public.sync_buckets SET payload = $2::jsonb, updated_at = $3::timestamptz
                WHERE sync_id = $1 AND updated_at = $4::timestamptz RETURNING updated_at::text AS t`

  it(
    'AC-8: 0.8.x to 0.11.0 upserts and CAS PATCHes still land as anon and authenticated',
    async () => {
      const relay = await relayAt('004')
      const row = throwaway(0xa1)
      const legacy = JSON.stringify({
        version: '4.0',
        expenses: [],
        categories: ['Other'],
        deletedIds: [],
      })
      for (const role of ['anon', 'authenticated'] as const) {
        const first = await relay.as(role, (tx) =>
          tx.query<{ t: string }>(upsert, [row, legacy, '2026-11-03T04:00:00.000123Z']),
        )
        expect(first.rows).toEqual([{ t: '2026-11-03 04:00:00.000123+00' }])
        const next = await relay.as(role, (tx) =>
          tx.query<{ t: string }>(cas, [
            row,
            v5Payload(),
            '2026-11-03T04:00:01.000456Z',
            '2026-11-03T12:00:00.000123+08:00',
          ]),
        )
        expect(next.rows).toEqual([{ t: '2026-11-03 04:00:01.000456+00' }])
        const stale = await relay.as(role, (tx) =>
          tx.query(cas, [row, v5Payload(), '2026-11-03T04:00:02Z', '2026-11-03T04:00:00.000123Z']),
        )
        expect(stale.rows).toEqual([])
        await relay.run(`DELETE FROM public.sync_buckets`)
      }
    },
    SLOW,
  )

  it(
    'AC-8: a row with a non-UUID id, a non-object payload, > 2 MiB of jsonb text or a non-finite time is refused (23514)',
    async () => {
      const relay = await relayAt('004')
      const row = throwaway(0xa1)
      const pad = (n: number) => JSON.stringify({ expenses: [], x5: { pad: 'x'.repeat(n) } })
      // {"x5": {"pad": "<n>"}, "expenses": []} is n + 35 bytes of jsonb text (asserted below)
      const overhead = await relay.rows<{ n: number }>(
        `SELECT octet_length($1::jsonb::text) AS n`,
        [pad(0)],
      )
      expect(overhead).toEqual([{ n: 35 }])
      const cases: readonly (readonly [string, string, string, string])[] = [
        ['non-UUID id', 'not-a-uuid', v5Payload(), '2026-11-03T04:00:00Z'],
        ['upper-case id', row.toUpperCase(), v5Payload(), '2026-11-03T04:00:00Z'],
        ['array payload', row, '[1, 2, 3]', '2026-11-03T04:00:00Z'],
        ['string payload', row, '"text"', '2026-11-03T04:00:00Z'],
        ['over 2 MiB', row, pad(2_097_152 - 35 + 1), '2026-11-03T04:00:00Z'],
        ['infinity', row, v5Payload(), 'infinity'],
        ['-infinity', row, v5Payload(), '-infinity'],
      ]
      for (const [label, id, payload, at] of cases) {
        const f = await failureOf(() =>
          relay.as('anon', (tx) => tx.query(upsert, [id, payload, at])),
        )
        expect(f.code, label).toBe('23514')
      }
      const exact = await relay.as('anon', (tx) =>
        tx.query<{ t: string }>(upsert, [row, pad(2_097_152 - 35), '2026-11-03T04:00:00Z']),
      )
      expect(exact.rows).toHaveLength(1)
      const size = await relay.rows<{ n: number }>(
        `SELECT octet_length(payload::text) AS n FROM public.sync_buckets WHERE sync_id = $1`,
        [row],
      )
      expect(size).toEqual([{ n: 2_097_152 }])
      // a CAS PATCH that would leave a bad row is refused too
      const patched = await failureOf(() =>
        relay.as('anon', (tx) =>
          tx.query(cas, [row, '[]', '2026-11-03T04:00:05Z', '2026-11-03T04:00:00Z']),
        ),
      )
      expect(patched.code).toBe('23514')
    },
    SLOW,
  )
})

describe('005 and both rollbacks (AC-2, AC-9 to AC-12, table C)', () => {
  it(
    'AC-10: 005 refuses (55000) before 004, and when a function was altered; nothing changes',
    async () => {
      const refusal =
        'SpendTrack 005: the sync functions from 004 are missing or not as 004 made them. Apply 004 and run 004_verify.sql first. Nothing was changed.'
      const relay = await relayAt('001-003')
      const before = await relay.catalogSnapshot()
      const missing = await failureOf(() => relay.apply('005'))
      expect([missing.code, missing.message]).toEqual(['55000', refusal])
      expect(await relay.catalogSnapshot()).toBe(before)

      await relay.apply('004')
      const mutations: readonly (readonly [string, string, string])[] = [
        [
          'definer off',
          `ALTER FUNCTION public.st_sync_head(text) SECURITY INVOKER`,
          `ALTER FUNCTION public.st_sync_head(text) SECURITY DEFINER`,
        ],
        [
          'search_path removed',
          `ALTER FUNCTION public.st_sync_pull(text) RESET search_path`,
          `ALTER FUNCTION public.st_sync_pull(text) SET search_path = ''`,
        ],
        [
          'anon EXECUTE revoked',
          `REVOKE EXECUTE ON FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) FROM anon`,
          `GRANT EXECUTE ON FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) TO anon`,
        ],
        [
          'authenticated EXECUTE revoked',
          `REVOKE EXECUTE ON FUNCTION public.st_sync_head(text) FROM authenticated`,
          `GRANT EXECUTE ON FUNCTION public.st_sync_head(text) TO authenticated`,
        ],
        [
          'a function dropped',
          `DROP FUNCTION public.st_sync_pull(text)`,
          '', // re-applying 004 restores it
        ],
      ]
      const post004 = await relay.catalogSnapshot()
      for (const [label, mutate, restore] of mutations) {
        await relay.run(mutate)
        const altered = await relay.catalogSnapshot()
        const f = await failureOf(() => relay.apply('005'))
        expect([f.code, f.message], label).toEqual(['55000', refusal])
        expect(await relay.catalogSnapshot(), label).toBe(altered)
        if (restore === '') await relay.apply('004')
        else await relay.run(restore)
        expect(await relay.catalogSnapshot(), label).toBe(post004)
      }
      await relay.superuser(
        `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) OWNER TO ${STRANGER}`,
      )
      const owner = await failureOf(() => relay.apply('005'))
      expect([owner.code, owner.message]).toEqual(['55000', refusal])
    },
    SLOW,
  )

  it(
    '005 refuses (55000) when row level security is FORCEd, or the publication cannot be changed; nothing changes',
    async () => {
      const relay = await relayAt('004')
      const post004 = await relay.catalogSnapshot()

      // FORCEd RLS would hide the rows from the functions' owner too: every device locked out.
      await relay.run(`ALTER TABLE public.sync_buckets FORCE ROW LEVEL SECURITY`)
      const forced = await relay.catalogSnapshot()
      const f = await failureOf(() => relay.apply('005'))
      expect([f.code, f.message]).toEqual([
        '55000',
        'SpendTrack 005: row level security on public.sync_buckets is FORCEd, which would lock the sync functions out too. Tell the lead. Nothing was changed.',
      ])
      expect(await relay.catalogSnapshot()).toBe(forced)
      await relay.run(`ALTER TABLE public.sync_buckets NO FORCE ROW LEVEL SECURITY`)
      expect(await relay.catalogSnapshot()).toBe(post004)

      const publication =
        'SpendTrack 005: the supabase_realtime publication lists the table, but this role cannot change it (it is FOR ALL TABLES, or another role owns it). Tell the lead. Nothing was changed.'
      // Another role owns the publication.
      await relay.superuser(`ALTER PUBLICATION supabase_realtime OWNER TO ${STRANGER}`)
      const owned = await failureOf(() => relay.apply('005'))
      expect([owned.code, owned.message]).toEqual(['55000', publication])
      await relay.superuser(`ALTER PUBLICATION supabase_realtime OWNER TO ${OWNER}`)
      expect(await relay.catalogSnapshot()).toBe(post004)

      // The publication is FOR ALL TABLES (a table cannot be dropped from it).
      await relay.superuser(`DROP PUBLICATION supabase_realtime;
        CREATE PUBLICATION supabase_realtime FOR ALL TABLES;`)
      const all = await failureOf(() => relay.apply('005'))
      expect([all.code, all.message]).toEqual(['55000', publication])
      await relay.superuser(`DROP PUBLICATION supabase_realtime;
        CREATE PUBLICATION supabase_realtime FOR TABLE public.sync_buckets;
        ALTER PUBLICATION supabase_realtime OWNER TO ${OWNER};`)
      expect(await relay.catalogSnapshot()).toBe(post004)
      await relay.apply('005')
    },
    SLOW,
  )

  it(
    'the lockout guards hold for a client that runs on after the first error (psql without ON_ERROR_STOP)',
    async () => {
      // Such a client skips nothing but the statement that failed: the pre-BEGIN check prints its
      // refusal and the transaction runs anyway. Dropping the pre-BEGIN block models that.
      const withoutPre = (sql: string): string => {
        const out = sql.replace(/DO \$pre\$[\s\S]*?\$pre\$;\n/, '')
        expect(out).not.toBe(sql)
        return out
      }

      // 005 with no working functions must not close the table.
      const early = await relayAt('001-003')
      const before = await early.catalogSnapshot()
      const g = await failureOf(() => early.run(withoutPre(migrationSql('005'))))
      expect([g.code, g.message]).toEqual([
        '55000',
        'SpendTrack 005: the preconditions failed (see the first error). Nothing was changed.',
      ])
      expect(await early.catalogSnapshot()).toBe(before)

      // 005 on a FORCEd table must not run either.
      const forced = await relayAt('004')
      await forced.run(`ALTER TABLE public.sync_buckets FORCE ROW LEVEL SECURITY`)
      const forcedBefore = await forced.catalogSnapshot()
      const h = await failureOf(() => forced.run(withoutPre(migrationSql('005'))))
      expect(h.code).toBe('55000')
      expect(await forced.catalogSnapshot()).toBe(forcedBefore)

      // The 004 rollback must not drop the functions under a closed table.
      const locked = await relayAt('005')
      const lockedBefore = await locked.catalogSnapshot()
      const r = await failureOf(() => locked.run(withoutPre(migrationSql('004-rollback'))))
      expect([r.code, r.message]).toEqual([
        '55000',
        'SpendTrack 004 rollback: refused (see the first error). Nothing was changed.',
      ])
      expect(await locked.catalogSnapshot()).toBe(lockedBefore)
    },
    SLOW,
  )

  it(
    'AC-10: 005 locks the table (no table or column privilege, RLS on and not forced, no policies, unpublished, replica identity default); RPC still works; twice is once',
    async () => {
      const relay = await relayAt('004')
      await relay.apply('005')
      const once = await relay.catalogSnapshot()
      await relay.apply('005')
      expect(await relay.catalogSnapshot()).toBe(once)
      const facts = await relay.rows<Record<string, unknown>>(`
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, c.relreplident::text AS replica,
               (SELECT count(*)::int FROM pg_policies WHERE tablename = 'sync_buckets') AS policies,
               (SELECT count(*)::int FROM pg_publication_tables WHERE tablename = 'sync_buckets') AS published,
               (SELECT bool_or(has_table_privilege(r, 'public.sync_buckets', p) OR has_any_column_privilege(r, 'public.sync_buckets', q))
                  FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                       unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p,
                       unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS q) AS any_access
          FROM pg_class c WHERE c.oid = 'public.sync_buckets'::regclass`)
      expect(facts).toEqual([
        { rls: true, forced: false, replica: 'd', policies: 0, published: 0, any_access: false },
      ])
      for (const sql of [
        `SELECT 1 FROM public.sync_buckets LIMIT 1`,
        `INSERT INTO public.sync_buckets (sync_id, payload) VALUES ('${throwaway(0xa1)}', '${v5Payload()}')`,
        `UPDATE public.sync_buckets SET payload = payload WHERE sync_id = '${throwaway(0xa1)}'`,
      ]) {
        const f = await failureOf(() => relay.as('anon', (tx) => tx.query(sql)))
        expect(f.code, sql).toBe('42501')
      }
      const pushed = await relay.as('anon', (tx) =>
        tx.query<{ r: { ok: boolean } }>(`SELECT public.st_sync_push($1, $2::jsonb) AS r`, [
          throwaway(0xa1),
          v5Payload(),
        ]),
      )
      expect(pushed.rows[0]?.r.ok).toBe(true)
      const head = await relay.as('anon', (tx) =>
        tx.query<{ t: string | null }>(`SELECT public.st_sync_head($1)::text AS t`, [
          throwaway(0xa1),
        ]),
      )
      expect(head.rows[0]?.t).toMatch(/^\d{4}-/)
      // the owner and service_role still read
      expect(await relay.rows(`SELECT sync_id FROM public.sync_buckets`)).toHaveLength(1)
      const service = await relay.as('service_role', (tx) =>
        tx.query(
          `SELECT has_table_privilege('service_role', 'public.sync_buckets', 'SELECT') AS s`,
        ),
      )
      expect(service.rows).toEqual([{ s: true }])
    },
    SLOW,
  )

  it(
    'AC-9: the 004 rollback is refused (55000) while 005 is applied, or half of it, and changes nothing',
    async () => {
      const refusal =
        'SpendTrack 004 rollback: the lockdown (005) is applied. Roll back 005 first (005_sync_lockdown.rollback.sql), or keep 004. Nothing was changed.'
      const relay = await relayAt('005')
      const catalog = await relay.catalogSnapshot()
      const f = await failureOf(() => relay.apply('004-rollback'))
      expect([f.code, f.message]).toEqual(['55000', refusal])
      expect(await relay.catalogSnapshot()).toBe(catalog)

      // Half a lockdown (each half of 005 by hand) is refused too: with the functions gone, a
      // table whose rows RLS hides, or that anon may not read, would leave no way to sync.
      const half = await relayAt('004')
      const halves: readonly (readonly [string, string, string])[] = [
        [
          'row level security on, anon still granted',
          `ALTER TABLE public.sync_buckets ENABLE ROW LEVEL SECURITY`,
          `ALTER TABLE public.sync_buckets DISABLE ROW LEVEL SECURITY`,
        ],
        [
          'anon SELECT revoked, row level security off',
          `REVOKE SELECT ON public.sync_buckets FROM anon`,
          `GRANT SELECT ON public.sync_buckets TO anon`,
        ],
      ]
      for (const [label, mutate, restore] of halves) {
        await half.run(mutate)
        const altered = await half.catalogSnapshot()
        const r = await failureOf(() => half.apply('004-rollback'))
        expect([r.code, r.message], label).toEqual(['55000', refusal])
        expect(await half.catalogSnapshot(), label).toBe(altered)
        await half.run(restore)
      }
      await half.apply('004-rollback')
      expect(await half.rows(FUNCTIONS)).toEqual([])
    },
    SLOW,
  )

  it(
    'AC-9: otherwise the 004 rollback drops the 3 functions, 3 checks and the index, keeps the revokes, and twice is once',
    async () => {
      const relay = await relayAt('004')
      await relay.apply('004-rollback')
      const once = await relay.catalogSnapshot()
      await relay.apply('004-rollback')
      expect(await relay.catalogSnapshot()).toBe(once)
      expect(await relay.rows(FUNCTIONS)).toEqual([])
      expect(await guards(relay)).toEqual([])
      for (const p of await privileges(relay)) {
        expect(p, p.role).toMatchObject({
          del: false,
          trunc: false,
          refs: false,
          trig: false,
          prune: false,
        })
      }
    },
    SLOW,
  )

  it(
    'AC-11: the 005 rollback restores the post-004 catalog exactly, and twice is once',
    async () => {
      const relay = await relayAt('004')
      const post004 = await relay.catalogSnapshot()
      await relay.apply('005')
      await relay.apply('005-rollback')
      expect(await relay.catalogSnapshot()).toBe(post004)
      await relay.apply('005-rollback')
      expect(await relay.catalogSnapshot()).toBe(post004)
    },
    SLOW,
  )

  it(
    'AC-2 and AC-12: no step changes a row, and the full cycle reproduces the first-pass snapshots',
    async () => {
      const relay = await relayAt('001-003')
      await relay.seed(junk())
      const data = await relay.dataSnapshot()
      const pre = await relay.catalogSnapshot()
      const steps = [
        '004',
        '004',
        '005',
        '005',
        '005-rollback',
        '005-rollback',
        '004-rollback',
        '004-rollback',
      ] as const
      const seen: string[] = []
      for (const step of steps) {
        await relay.apply(step)
        expect(await relay.dataSnapshot(), step).toBe(data)
        seen.push(await relay.catalogSnapshot())
      }
      const [after004, , after005, , after005rb, , after004rb] = seen
      expect(after005rb).toBe(after004)
      expect(after004rb).not.toBe(pre) // the revokes stay
      await relay.apply('004')
      expect(await relay.catalogSnapshot()).toBe(after004)
      await relay.apply('005')
      expect(await relay.catalogSnapshot()).toBe(after005)
      expect(await relay.dataSnapshot()).toBe(data)
      const owner = await relay.rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.sync_buckets WHERE sync_id = $1`,
        [OWNER_ROW],
      )
      expect(owner).toEqual([{ n: 1 }])
    },
    SLOW,
  )
})

describe('Postgres 15 and 16 (no MAINTAIN privilege)', () => {
  const GUARD = "current_setting('server_version_num')::int >= 170000"
  const files = [
    migrationSql('004'),
    migrationSql('005'),
    checkSql('preflight'),
    checkSql('004_verify'),
    checkSql('005_verify'),
  ]

  it('names MAINTAIN only inside text a version guard runs', () => {
    for (const sql of files) {
      const executed = sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/\$([A-Za-z_]*)\$/g, ' ')
      expect(executed).not.toMatch(/\bMAINTAIN\b/)
    }
    expect(
      files.filter((sql) => sql.includes('MAINTAIN')).every((sql) => sql.includes(GUARD)),
    ).toBe(true)
  })

  it(
    'with every version guard off and MAINTAIN unknown, 004 and 005 apply and the checks pass',
    async () => {
      // a server before 17: every guard false, and MAINTAIN an unknown privilege that errors
      // wherever something still evaluates it
      const old = (sql: string) =>
        sql.replaceAll(GUARD, 'false').replaceAll('MAINTAIN', 'NO_SUCH_PRIVILEGE')
      const relay = await relayAt('001-003')
      await relay.run(old(migrationSql('004')))
      const verify004 = (await relay.db.exec(old(checkSql('004_verify')))).at(-1)?.rows[0]
      expect(verify004).toMatchObject({ check: 'RESULT', pass: true })
      await relay.run(old(migrationSql('005')))
      const verify005 = (await relay.db.exec(old(checkSql('005_verify')))).at(-1)?.rows[0]
      expect(verify005).toMatchObject({ check: 'RESULT', pass: true })
      const stage = (await relay.db.exec(old(checkSql('preflight')))).at(-1)?.rows[1]
      expect(stage).toMatchObject({ item: 'stage', value: '005 applied' })
    },
    SLOW,
  )
})
