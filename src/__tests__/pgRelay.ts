// The relay database on real Postgres (PR-5 track spec §3.9, U1): PGlite (Postgres 18 compiled to
// WASM, a dev dependency that never ships) with Supabase's roles, default privileges and Realtime
// publication emulated, so the migrations and checks in supabase/ run exactly as the owner will
// run them in the SQL editor: as a non-superuser table owner, one file at a time, through the
// simple-query protocol (several statements in one message, an error leaving an explicit
// transaction aborted until ROLLBACK).
//
// Supabase stand-ins: `anon` and `authenticated` (NOLOGIN NOINHERIT), `service_role` (BYPASSRLS),
// and `st_owner` for Supabase's `postgres` (NOSUPERUSER NOBYPASSRLS, a member of anon,
// authenticated and service_role, owner of the publication). `ALTER DEFAULT PRIVILEGES … GRANT ALL` reproduces
// what Supabase grants on every new table and function, which is how F-068 came about.
//
// Booting Postgres takes about 2 s, so one template per test file is set up once and each relay
// is a clone of it (about 0.5 s). Close every relay: an instance holds about 200 MB.
import { messages, PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite'

/** The editor's role in the emulation (Supabase's `postgres`): owns everything it creates. */
export const OWNER = 'st_owner'
/** PGlite's bootstrap superuser (RESET SESSION AUTHORIZATION does not return to it in PGlite). */
const SUPERUSER = 'postgres'
/** A second, unprivileged login role: someone who is not the table owner. */
export const STRANGER = 'st_stranger'
export type Role = 'anon' | 'authenticated' | 'service_role' | typeof OWNER

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const SUPABASE = `
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE ${OWNER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE ${STRANGER} LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT anon, authenticated, service_role TO ${OWNER};
GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER};
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, ${STRANGER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime OWNER TO ${OWNER};
`

export type Migration = '001' | '002' | '003' | '004' | '004-rollback' | '005' | '005-rollback'
export type CheckFile = 'preflight' | '004_verify' | '005_verify'

const MIGRATION_FILES: Readonly<Record<Migration, string>> = {
  '001': 'migrations/001_sync.sql',
  '002': 'migrations/002_sync_indexes.sql',
  '003': 'migrations/003_harden_prune_search_path.sql',
  '004': 'migrations/004_sync_rpc.sql',
  '004-rollback': 'migrations/004_sync_rpc.rollback.sql',
  '005': 'migrations/005_sync_lockdown.sql',
  '005-rollback': 'migrations/005_sync_lockdown.rollback.sql',
}

const CHECK_FILES: Readonly<Record<CheckFile, string>> = {
  preflight: 'checks/000_preflight_readonly.sql',
  '004_verify': 'checks/004_verify.sql',
  '005_verify': 'checks/005_verify.sql',
}

/** Every SQL file under supabase/, as text (through Vite, like the source scans in this folder). */
const SUPABASE_FILES = import.meta.glob<string>('/supabase/**/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Every SQL file under supabase/, as [path from the repository root, text]. */
export const supabaseFiles = (): readonly (readonly [string, string])[] =>
  Object.entries(SUPABASE_FILES)

/** A file under supabase/, exactly as the owner will paste it. */
export function supabaseFile(rel: string): string {
  const text = SUPABASE_FILES[`/supabase/${rel}`]
  if (text === undefined) throw new Error(`supabase/${rel} not found`)
  return text
}

export const migrationSql = (m: Migration): string => supabaseFile(MIGRATION_FILES[m])
export const checkSql = (c: CheckFile): string => supabaseFile(CHECK_FILES[c])

/** A Postgres error as the server raised it (SQLSTATE and message), or null for anything else. */
export interface PgFailure {
  readonly code: string
  readonly message: string
  readonly detail: string | undefined
}

export function pgFailure(err: unknown): PgFailure | null {
  if (!(err instanceof messages.DatabaseError)) return null
  return { code: err.code ?? '', message: err.message, detail: err.detail }
}

/** Runs `run` and returns the Postgres error it raised (fails the test when it raised none). */
export async function failureOf(run: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await run()
  } catch (err) {
    const failure = pgFailure(err)
    if (failure !== null) return failure
    throw err
  }
  throw new Error('expected a Postgres error, but the statement succeeded')
}

/** One row of an invented relay table. Times are SQL literals; payload is JSON text. */
export interface SeedRow {
  readonly id: string
  readonly payload: string
  readonly updatedAt?: string
  readonly createdAt?: string
}

export interface FillOptions {
  /** Rows to add with generated, valid ids (prefix `10000000-…`, never a check's own id). */
  readonly count: number
  /** How long ago they were created, as an interval literal ('0 seconds' by default). */
  readonly createdAgo?: string
  /** The first generated number (to add more later without a clash). */
  readonly from?: number
}

export type Stage = 'none' | '001-003' | '004' | '005'

export interface PgRelay {
  readonly db: PGliteInterface
  /** Runs SQL text as the editor (simple-query protocol); on an error, ROLLBACK, then rethrow. */
  run(sql: string): Promise<void>
  apply(m: Migration): Promise<void>
  /** Applies 001 to 003, then 004 and 005 as the stage asks. */
  migrate(stage: Stage): Promise<void>
  /** The rows of a check file's last statement, run as the editor (as in the SQL editor). */
  check(c: CheckFile): Promise<Record<string, unknown>[]>
  /** One parameterised query as the editor. */
  rows<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** `fn` inside one transaction as `role` (SET LOCAL ROLE); committed unless it throws. */
  as<T>(role: Role, fn: (tx: Transaction) => Promise<T>): Promise<T>
  /** SQL as the bootstrap superuser (to mutate what the owner may not, like ownership). */
  superuser(sql: string): Promise<void>
  /** Runs the rest of the session as another login role (STRANGER), or back as OWNER. */
  login(role: typeof OWNER | typeof STRANGER): Promise<void>
  seed(rows: readonly SeedRow[]): Promise<void>
  fill(opts: FillOptions): Promise<void>
  /** Row count and an md5 over every column of every row (sorted, times in UTC). */
  dataSnapshot(): Promise<string>
  /** Everything a migration may change, canonically ordered (no OIDs). */
  catalogSnapshot(): Promise<string>
  close(): Promise<void>
}

let template: Promise<PGlite> | null = null

function baseTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const db = await PGlite.create()
    await db.exec(SUPABASE)
    return db
  })()
  return template
}

/** Frees the template of this test file (call from afterAll). */
export async function closeTemplate(): Promise<void> {
  const t = template
  template = null
  if (t !== null) await (await t).close()
}

const DATA_SNAPSHOT = `
SELECT count(*)::text || ':' || coalesce(md5(string_agg(
         b.sync_id || '|' || b.payload::text || '|' || b.updated_at::text || '|' || b.created_at::text,
         E'\\n' ORDER BY b.sync_id)), '-') AS snap
  FROM public.sync_buckets AS b`

const ACL_ITEMS = (acl: string, kind: string, owner: string) => `
  (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM (
     SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            || ':' || a.privilege_type || ':' || a.is_grantable::text AS x
       FROM aclexplode(coalesce(${acl}, acldefault('${kind}', ${owner}))) AS a) AS s)`

const CATALOG_SNAPSHOT = `
SELECT jsonb_build_object(
  'table', (SELECT jsonb_build_object(
      'owner', c.relowner::regrole::text,
      'rls', c.relrowsecurity,
      'forced', c.relforcerowsecurity,
      'replica_identity', c.relreplident::text,
      'comment', obj_description(c.oid, 'pg_class'),
      'acl', ${ACL_ITEMS('c.relacl', 'r', 'c.relowner')},
      'column_acl', (SELECT coalesce(jsonb_agg(att.attname || '=' || att.attacl::text ORDER BY att.attname), '[]'::jsonb)
                       FROM pg_attribute AS att WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL),
      'columns', (SELECT jsonb_agg(att.attname || ' ' || format_type(att.atttypid, att.atttypmod)
                                   || ' ' || att.attnotnull::text ORDER BY att.attnum)
                    FROM pg_attribute AS att
                   WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped))
    FROM pg_class AS c WHERE c.oid = to_regclass('public.sync_buckets')),
  'privileges', (SELECT jsonb_object_agg(r.rolname, (
      SELECT coalesce(jsonb_agg(p ORDER BY p), '[]'::jsonb)
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p
       WHERE to_regclass('public.sync_buckets') IS NOT NULL
         AND has_table_privilege(r.oid, to_regclass('public.sync_buckets'), p)))
    FROM pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role', '${OWNER}')),
  'constraints', (SELECT coalesce(jsonb_agg(k.conname || ' ' || k.contype::text || ' valid=' || k.convalidated::text
                                            || ' ' || pg_get_constraintdef(k.oid) ORDER BY k.conname), '[]'::jsonb)
                    FROM pg_constraint AS k WHERE k.conrelid = to_regclass('public.sync_buckets')),
  'constraint_comments', (SELECT coalesce(jsonb_agg(k.conname || '=' || coalesce(obj_description(k.oid, 'pg_constraint'), '')
                                                    ORDER BY k.conname), '[]'::jsonb)
                            FROM pg_constraint AS k WHERE k.conrelid = to_regclass('public.sync_buckets')),
  'indexes', (SELECT coalesce(jsonb_agg(i.indexdef ORDER BY i.indexname), '[]'::jsonb)
                FROM pg_indexes AS i WHERE i.schemaname = 'public' AND i.tablename = 'sync_buckets'),
  'triggers', (SELECT coalesce(jsonb_agg(t.tgname ORDER BY t.tgname), '[]'::jsonb)
                 FROM pg_trigger AS t WHERE t.tgrelid = to_regclass('public.sync_buckets')),
  'functions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'sig', p.oid::regprocedure::text,
        'owner', p.proowner::regrole::text,
        'definer', p.prosecdef,
        'config', p.proconfig,
        'volatility', p.provolatile::text,
        'returns', format_type(p.prorettype, NULL),
        'source_md5', md5(p.prosrc),
        'comment', obj_description(p.oid, 'pg_proc'),
        'acl', ${ACL_ITEMS('p.proacl', 'f', 'p.proowner')}) ORDER BY p.oid::regprocedure::text), '[]'::jsonb)
                  FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace),
  'policies', (SELECT coalesce(jsonb_agg(pol.policyname ORDER BY pol.policyname), '[]'::jsonb)
                 FROM pg_policies AS pol WHERE pol.schemaname = 'public' AND pol.tablename = 'sync_buckets'),
  'publication', (SELECT coalesce(jsonb_agg(pt.pubname ORDER BY pt.pubname), '[]'::jsonb)
                    FROM pg_publication_tables AS pt WHERE pt.schemaname = 'public' AND pt.tablename = 'sync_buckets')
)::text AS snap`

/** A fresh relay: a clone of the template, the session logged in as the owner, UTC. */
export async function bootRelay(stage: Stage = 'none'): Promise<PgRelay> {
  const db = await (await baseTemplate()).clone()
  await db.exec(`SET SESSION AUTHORIZATION ${OWNER}; SET TimeZone = 'UTC';`)
  let session: typeof OWNER | typeof STRANGER = OWNER

  const run = async (sql: string): Promise<void> => {
    try {
      await db.exec(sql)
    } catch (err) {
      // As the runbook tells the owner: one ROLLBACK closes what the error left open.
      await db.exec('ROLLBACK')
      throw err
    }
  }

  const snapshot = async (sql: string): Promise<string> => {
    const rows = await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL TimeZone = 'UTC'`)
      return (await tx.query<{ snap: string | null }>(sql)).rows
    })
    return rows[0]?.snap ?? ''
  }

  const relay: PgRelay = {
    db,
    run,
    apply: (m) => run(migrationSql(m)),
    async migrate(stage) {
      if (stage === 'none') return
      for (const m of ['001', '002', '003'] as const) await relay.apply(m)
      if (stage === '004' || stage === '005') await relay.apply('004')
      if (stage === '005') await relay.apply('005')
    },
    async check(c) {
      let results: Awaited<ReturnType<PGliteInterface['exec']>>
      try {
        results = await db.exec(checkSql(c))
      } catch (err) {
        await db.exec('ROLLBACK')
        throw err
      }
      return results.at(-1)?.rows ?? []
    },
    async rows<T>(sql: string, params: readonly unknown[] = []) {
      return (await db.query<T>(sql, [...params])).rows
    },
    as: (role, fn) =>
      db.transaction(async (tx) => {
        await tx.query(`SELECT set_config('role', $1, true)`, [role])
        return fn(tx)
      }),
    async superuser(sql) {
      await db.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}`)
      try {
        await db.exec(sql)
      } finally {
        await db.exec(`SET SESSION AUTHORIZATION ${session}`)
      }
    },
    async login(role) {
      session = role
      await db.exec(`SET SESSION AUTHORIZATION ${SUPERUSER}; SET SESSION AUTHORIZATION ${role}`)
    },
    async seed(rows) {
      for (const r of rows) {
        await db.query(
          `INSERT INTO public.sync_buckets (sync_id, payload, updated_at, created_at)
           VALUES ($1, $2::jsonb, coalesce($3::timestamptz, now()), coalesce($4::timestamptz, now()))`,
          [r.id, r.payload, r.updatedAt ?? null, r.createdAt ?? null],
        )
      }
    },
    async fill({ count, createdAgo = '0 seconds', from = 1 }) {
      await db.query(
        `INSERT INTO public.sync_buckets (sync_id, payload, updated_at, created_at)
         SELECT format('10000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0')),
                jsonb_build_object('version', '4.0', 'expenses', '[]'::jsonb,
                                   'x5', jsonb_build_object('schema', 5, 'n', i)),
                now() - $2::interval, now() - $2::interval
           FROM generate_series($1::int, $1::int + $3::int - 1) AS i`,
        [from, createdAgo, count],
      )
    },
    dataSnapshot: () => snapshot(DATA_SNAPSHOT),
    catalogSnapshot: () => snapshot(CATALOG_SNAPSHOT),
    close: () => db.close(),
  }
  await relay.migrate(stage)
  return relay
}

/** A throwaway id with a fixed, never-generated prefix (`00000000-0000-4000-8000-` + 12 hex). */
export function throwaway(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** An invented v5 plaintext payload (the shape st_sync_push accepts), as JSON text. */
export function v5Payload(note = 'invented'): string {
  return JSON.stringify({
    version: '4.0',
    exportDate: '2026-10-01T04:00:00.000Z',
    expenses: [
      { id: 'e1', itemName: note, amount: 4.5, category: 'Other', date: '2026-10-01T12:00:00' },
    ],
    categories: ['Other'],
    x5: { schema: 5, minor: 0, min: 4, rev: 'r1', dig: 'abc' },
  })
}
