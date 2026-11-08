// @vitest-environment node
// The owner's read-only checks on real Postgres (PR-5 track spec §3.6, §3.7; AC-13 to AC-15):
// the preflight is one read-only SELECT whose stage and STOP rules are right in every state;
// 004_verify and 005_verify PASS on a correctly migrated relay, FAIL by name after each
// mutation, adapt at the creation caps, degrade to SKIPPED when the editor cannot act as anon,
// and leave no trace. No output cell ever holds a sync code or payload text.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  bootRelay,
  checkSql,
  closeTemplate,
  OWNER,
  STRANGER,
  throwaway,
  UUID_RE,
  v5Payload,
  type CheckFile,
  type PgRelay,
  type SeedRow,
  type Stage,
} from '../pgRelay'

const SLOW = 60_000
const open: PgRelay[] = []

async function relayAt(stage: Stage): Promise<PgRelay> {
  const r = await bootRelay(stage)
  open.push(r)
  return r
}

afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})
afterAll(closeTemplate)

interface Item {
  readonly n: number
  readonly item: string
  readonly value: string
  readonly stop: boolean
  readonly note: string
}

interface Verdict {
  readonly n: number
  readonly check: string
  readonly expected: string
  readonly actual: string
  readonly pass: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v))

async function preflight(relay: PgRelay): Promise<Item[]> {
  const rows = await relay.check('preflight')
  return rows.map((r) => ({
    n: Number(r.n),
    item: str(r.item),
    value: str(r.value),
    stop: r.stop === true,
    note: str(r.note),
  }))
}

async function verify(
  relay: PgRelay,
  c: Extract<CheckFile, '004_verify' | '005_verify'>,
): Promise<Verdict[]> {
  const rows = await relay.check(c)
  return rows.map((r) => ({
    n: Number(r.n),
    check: str(r.check),
    expected: str(r.expected),
    actual: str(r.actual),
    pass: r.pass === true,
  }))
}

const itemOf = (items: readonly Item[], name: string): Item => {
  const it = items.find((i) => i.item === name)
  if (it === undefined) throw new Error(`no preflight item ${name}`)
  return it
}
const verdictOf = (rows: readonly Verdict[]): Verdict => {
  const r = rows[0]
  if (r?.check !== 'RESULT') throw new Error('row 0 is not RESULT')
  return r
}
const failed = (rows: readonly Verdict[]): string[] =>
  rows.filter((r) => r.n > 0 && !r.pass).map((r) => r.check)

/** Strips comments, string literals and dollar-quoted bodies, for a scan of what SQL runs. */
function code(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

/** Every cell of every row, as text: none may name a code or show payload text. */
const cells = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.flatMap((r) => Object.values(r).map((v) => str(v)))

const PREFLIGHT_ITEMS = [
  'verdict',
  'stage',
  'table_owner',
  'rows_total',
  'rows_created_last_hour',
  'rows_bad_id',
  'rows_bad_payload',
  'largest_active_payload',
  'newest_write',
  'writer_classes',
  'anon_table_privileges',
  'authenticated_table_privileges',
  'anon_can_prune',
  'row_level_security',
  'policies',
  'realtime_publication',
  'replica_identity',
  'sync_functions',
  'write_guards',
  'server_time_zone',
  'postgres_version',
]

describe('000_preflight_readonly.sql (AC-13)', () => {
  it('is one SELECT, with no DDL, DML, SET, DO or NOTIFY', () => {
    const body = code(checkSql('preflight'))
    const statements = body.split(';').filter((s) => s.trim() !== '')
    expect(statements).toHaveLength(1)
    expect(statements[0]?.trim()).toMatch(/^WITH\b/i)
    const forbidden =
      /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|MERGE|GRANT|REVOKE|SET|RESET|DO|NOTIFY|LISTEN|COMMENT|COPY|VACUUM|ANALYZE|LOCK|BEGIN|COMMIT|ROLLBACK|CALL|EXECUTE|PREPARE|REFRESH|CLUSTER|REINDEX|DISCARD|SECURITY|IMPORT|SAVEPOINT)\b/i
    expect(body).not.toMatch(forbidden)
  })

  it(
    'runs inside BEGIN READ ONLY and changes nothing; the stage is right in all four states',
    async () => {
      const relay = await relayAt('001-003')
      await relay.seed([{ id: throwaway(0xa1), payload: v5Payload() }])
      const stages: string[] = []
      const step = async () => {
        const catalog = await relay.catalogSnapshot()
        const data = await relay.dataSnapshot()
        const rows = await relay.db.transaction(async (tx): Promise<Record<string, unknown>[]> => {
          await tx.exec('SET TRANSACTION READ ONLY')
          const res = await tx.exec(checkSql('preflight'))
          return res.at(-1)?.rows ?? []
        })
        expect(rows.map((r) => r.item)).toEqual(PREFLIGHT_ITEMS)
        expect(await relay.catalogSnapshot()).toBe(catalog)
        expect(await relay.dataSnapshot()).toBe(data)
        stages.push(itemOf(await preflight(relay), 'stage').value)
      }
      await step()
      await relay.apply('004')
      await step()
      await relay.apply('005')
      await step()
      await relay.apply('005-rollback')
      await step()
      await relay.run(`ALTER TABLE public.sync_buckets ENABLE ROW LEVEL SECURITY`) // a half lockdown
      await step()
      await relay.run(`ALTER TABLE public.sync_buckets DISABLE ROW LEVEL SECURITY`)
      await relay.apply('004-rollback')
      await step()
      expect(stages).toEqual([
        'before 004',
        '004 applied',
        '005 applied',
        '004 applied',
        'mixed',
        'before 004',
      ])
    },
    SLOW,
  )

  it(
    'says GO on an empty relay and on a 449-row relay, and reports what 004 is about to change',
    async () => {
      const relay = await relayAt('001-003')
      const empty = await preflight(relay)
      expect(empty[0]).toMatchObject({ item: 'verdict', value: 'GO', stop: false })
      expect(itemOf(empty, 'rows_total').value).toBe('0 of the 500 cap')
      expect(itemOf(empty, 'anon_table_privileges').value).toBe(
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN',
      )
      expect(itemOf(empty, 'anon_can_prune').value).toBe('yes')
      expect(itemOf(empty, 'sync_functions').value).toBe('none')
      expect(itemOf(empty, 'write_guards').value).toBe('none')
      expect(itemOf(empty, 'realtime_publication').value).toBe('table published')
      expect(itemOf(empty, 'replica_identity').value).toBe('full')
      expect(itemOf(empty, 'row_level_security').value).toBe('off')
      expect(itemOf(empty, 'table_owner').value).toBe(`${OWNER} (you)`)
      await relay.fill({ count: 449, createdAgo: '2 days' })
      const full = await preflight(relay)
      expect(full[0]).toMatchObject({ value: 'GO', stop: false })
      expect(itemOf(full, 'rows_total').value).toBe('449 of the 500 cap')
      expect(itemOf(full, 'writer_classes').value).toBe(
        'v5 449 · v0.8.5 0 · v0.8.0-0.8.4 0 · private 0 · moved 0 · check rows 0 · other 0',
      )
      await relay.apply('004')
      const after = await preflight(relay)
      expect(after[0]).toMatchObject({ value: 'GO' })
      expect(itemOf(after, 'anon_table_privileges').value).toBe('SELECT, INSERT, UPDATE')
      expect(itemOf(after, 'anon_can_prune').value).toBe('no')
      expect(itemOf(after, 'sync_functions').value).toBe('3 of 3, as 004 made them')
      expect(itemOf(after, 'write_guards').value).toBe('all 4 (3 checks and the index)')
      await relay.apply('005')
      const locked = await preflight(relay)
      expect(locked[0]).toMatchObject({ value: 'GO' })
      expect(itemOf(locked, 'anon_table_privileges').value).toBe('none')
      expect(itemOf(locked, 'authenticated_table_privileges').value).toBe('none')
      expect(itemOf(locked, 'row_level_security').value).toBe('on')
      expect(itemOf(locked, 'realtime_publication').value).toBe('not published')
      expect(itemOf(locked, 'replica_identity').value).toBe('default')
    },
    SLOW,
  )

  it(
    'each STOP rule fires on its fixture, and the verdict names it',
    async () => {
      // [the item that stops, the stage the fixture starts from, the fixture]
      const cases: readonly (readonly [string, Stage, (r: PgRelay) => Promise<void>])[] = [
        [
          'table_owner',
          '001-003',
          async (r) => {
            await r.run(`GRANT SELECT ON public.sync_buckets TO ${STRANGER}`)
            await r.login(STRANGER)
          },
        ],
        ['rows_total', '001-003', (r) => r.fill({ count: 450, createdAgo: '2 days' })],
        ['rows_bad_id', '001-003', (r) => r.seed([{ id: 'NOT-A-UUID', payload: v5Payload() }])],
        [
          'rows_bad_payload',
          '001-003',
          (r) => r.seed([{ id: throwaway(0xa1), payload: '[1, 2]' }]),
        ],
        [
          'largest_active_payload',
          '001-003',
          (r) =>
            r.seed([
              {
                id: throwaway(0xa1),
                payload: JSON.stringify({ expenses: [], x5: { pad: 'x'.repeat(1_300_000) } }),
              },
            ]),
        ],
        [
          'policies',
          '001-003',
          (r) =>
            r.run(`CREATE POLICY st_test ON public.sync_buckets FOR SELECT TO anon USING (true)`),
        ],
        [
          'row_level_security',
          '001-003',
          (r) =>
            r.run(
              `ALTER TABLE public.sync_buckets ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY`,
            ),
        ],
        [
          'sync_functions',
          '004',
          (r) => r.run(`ALTER FUNCTION public.st_sync_head(text) SECURITY INVOKER`),
        ],
        [
          'write_guards',
          '004',
          (r) => r.run(`ALTER TABLE public.sync_buckets DROP CONSTRAINT sync_buckets_id_uuid`),
        ],
        // the stage is "mixed" whenever neither 004 nor 005 as either file leaves it: half a
        // lockdown, and each grant 004 or 005 took away coming back by hand
        ['stage', '004', (r) => r.run(`ALTER TABLE public.sync_buckets ENABLE ROW LEVEL SECURITY`)],
        [
          'stage',
          '004',
          (r) =>
            r.run(`GRANT EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) TO anon`),
        ],
        ['stage', '004', (r) => r.run(`GRANT DELETE ON public.sync_buckets TO authenticated`)],
        ['stage', '004', (r) => r.run(`GRANT TRUNCATE ON public.sync_buckets TO authenticated`)],
        [
          'stage',
          '005',
          (r) => r.run(`ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_buckets`),
        ],
        [
          'stage',
          '005',
          (r) =>
            r.run(`GRANT EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) TO anon`),
        ],
      ]
      for (const [n, [item, stage, fixture]] of cases.entries()) {
        const label = `case ${String(n)}: ${item} from ${stage}`
        const relay = await bootRelay(stage)
        try {
          await fixture(relay)
          const items = await preflight(relay)
          expect(itemOf(items, item).stop, label).toBe(true)
          if (item === 'stage') expect(itemOf(items, 'stage').value, label).toBe('mixed')
          expect(items[0], label).toMatchObject({ value: 'STOP', stop: true })
          expect(items[0]?.note, label).toContain(item)
        } finally {
          await relay.close()
        }
      }
    },
    SLOW,
  )

  it(
    'a row in use means one written in the last 30 days, however long ago it was created: it stops at 10 days, not at 40',
    async () => {
      const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
      // every row was created 400 days ago and last written `days` ago: the write is what counts
      const rows = (days: number): SeedRow[] =>
        [
          { id: 'legacy-code', payload: v5Payload() },
          { id: throwaway(0xa1), payload: '[1, 2]' },
          {
            id: throwaway(0xa2),
            // valid for the table guard (under 2 MiB), over what st_sync_push takes
            payload: JSON.stringify({ expenses: [], x5: { pad: 'x'.repeat(1_300_000) } }),
          },
        ].map((r) => ({ ...r, updatedAt: ago(days), createdAt: ago(400) }))
      const watched = ['rows_bad_id', 'rows_bad_payload', 'largest_active_payload']

      const recent = await relayAt('001-003')
      await recent.seed(rows(10))
      const r = await preflight(recent)
      expect(r[0]).toMatchObject({ value: 'STOP', stop: true })
      for (const item of watched) {
        expect(itemOf(r, item).stop, item).toBe(true)
        expect(r[0]?.note, item).toContain(item)
      }
      expect(itemOf(r, 'rows_bad_id').value).toBe('1 in total, 1 written in the last 30 days')
      expect(itemOf(r, 'largest_active_payload').value).toBe('1,270 KB of 1,228 KB')

      const old = await relayAt('001-003')
      await old.seed(rows(40))
      const o = await preflight(old)
      expect(o[0]).toMatchObject({ value: 'GO', stop: false })
      for (const item of watched) expect(itemOf(o, item).stop, item).toBe(false)
      expect(itemOf(o, 'rows_bad_id').value).toBe('1 in total, 0 written in the last 30 days')
      expect(itemOf(o, 'rows_bad_payload').value).toBe('1 in total, 0 written in the last 30 days')
      expect(itemOf(o, 'largest_active_payload').value).toBe('no row written in the last 30 days')
    },
    SLOW,
  )

  it(
    'largest_active_payload reads over 1,228 KB exactly when it stops, and warns (without stopping) past 1,000 KB',
    async () => {
      const relay = await relayAt('001-003')
      // `{"x5": {"pad": "…"}, "expenses": []}`: 35 bytes of jsonb text around the pad
      const ofBytes = (bytes: number): string =>
        JSON.stringify({ expenses: [], x5: { pad: 'x'.repeat(bytes - 35) } })
      const at = async (bytes: number): Promise<Item> => {
        await relay.run(`DELETE FROM public.sync_buckets`)
        await relay.seed([{ id: throwaway(0xa1), payload: ofBytes(bytes) }])
        const stored = await relay.rows<{ b: number }>(
          `SELECT octet_length(payload::text) AS b FROM public.sync_buckets`,
        )
        expect(stored).toEqual([{ b: bytes }])
        const items = await preflight(relay)
        const item = itemOf(items, 'largest_active_payload')
        expect(items[0]?.stop, String(bytes)).toBe(item.stop)
        return item
      }
      const plain = /^jsonb text of the largest row/
      const near = /^near the 1,228 KB limit \(not a stop\)/
      const cases: readonly (readonly [number, string, boolean, RegExp])[] = [
        [1_024_000, '1,000 KB of 1,228 KB', false, plain],
        [1_024_001, '1,000 KB of 1,228 KB', false, near],
        [1_257_472, '1,228 KB of 1,228 KB', false, near],
        [1_257_473, '1,228 KB of 1,228 KB', false, near], // 1,228.0009 KB: never shown as 1,229
        [1_258_291, '1,228 KB of 1,228 KB', false, near], // the most st_sync_push takes
        [
          1_258_292,
          '1,229 KB of 1,228 KB',
          true,
          /^a row in use is over what st_sync_push accepts/,
        ],
      ]
      for (const [bytes, value, stop, note] of cases) {
        const item = await at(bytes)
        expect([item.value, item.stop], String(bytes)).toEqual([value, stop])
        expect(item.note, String(bytes)).toMatch(note)
      }
    },
    SLOW,
  )

  it(
    'old junk does not stop it; nothing in its output names a code or shows payload text; fast on 500 rows',
    async () => {
      const relay = await relayAt('001-003')
      await relay.seed([
        {
          id: 'old-junk',
          payload: '{"canary":"CANARY-7f3a"}',
          updatedAt: '2026-05-01 00:00:00+00',
          createdAt: '2026-05-01 00:00:00+00',
        },
        {
          id: throwaway(0xa1),
          payload: JSON.stringify({ spendtrack: 'verify-cas', expenses: [], x5: {} }),
        },
        { id: throwaway(0xa2), payload: '{"st":5,"iv":"CANARY-7f3a","ct":"CANARY-7f3a"}' },
        {
          id: throwaway(0xa3),
          payload: '{"version":"4.0","expenses":"moved","x5":{"canary":"CANARY-7f3a"}}',
        },
        { id: throwaway(0xa4), payload: '{"version":"4.0","expenses":[],"wr":{"v":"0.8.5"}}' },
        {
          id: throwaway(0xa5),
          payload: '{"version":"4.0","expenses":[{"itemName":"CANARY-7f3a"}]}',
        },
      ])
      await relay.fill({ count: 494, createdAgo: '3 days' })
      const started = performance.now()
      const items = await preflight(relay)
      expect(performance.now() - started).toBeLessThan(2000)
      expect(items[0]).toMatchObject({ value: 'STOP' }) // 500 rows ≥ 450
      expect(items[0]?.note).toContain('rows_total')
      expect(items[0]?.note).not.toContain('rows_bad')
      expect(itemOf(items, 'rows_bad_id').value).toBe('1 in total, 0 written in the last 30 days')
      expect(itemOf(items, 'writer_classes').value).toBe(
        'v5 494 · v0.8.5 1 · v0.8.0-0.8.4 1 · private 1 · moved 1 · check rows 1 · other 1',
      )
      const text = cells(await relay.check('preflight'))
      for (const c of text) {
        expect(c).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
        expect(c).not.toContain('CANARY')
        expect(c).not.toContain('old-junk')
      }
    },
    SLOW,
  )

  it(
    'a database without 002 errors on created_at (the runbook maps it to STOP)',
    async () => {
      const relay = await relayAt('none')
      await relay.apply('001')
      await expect(relay.check('preflight')).rejects.toThrow(/column .*created_at.* does not exist/)
    },
    SLOW,
  )
})

const VERIFY_004 = [
  'functions_present',
  'functions_security_definer',
  'functions_search_path_pinned',
  'functions_owned_by_table_owner',
  'functions_execute_anon_authenticated',
  'functions_no_public_execute',
  'anon_cannot_delete_or_truncate',
  'prune_locked',
  'old_clients_still_work',
  'write_guards_present',
  'not_locked_yet',
  'throwaway_ids_free',
  'acting_as_anon',
  'head_missing_is_null',
  'pull_missing_is_null',
  'create_ok',
  'create_again_is_conflict',
  'cas_exact_token_ok',
  'cas_token_increases',
  'cas_old_token_is_conflict',
  'cas_newer_token_is_conflict',
  'force_existing_ok',
  'force_missing_is_missing',
  'cas_missing_is_missing',
  'pull_matches_head',
  'private_envelope_accepted',
  'moved_marker_accepted',
  'bad_row_id_refused',
  'bad_payload_refused',
  'size_limit_exact',
  'hourly_create_cap',
  'table_guard_refuses_bad_row',
  'anon_cannot_delete',
  'nothing_left_behind',
]

const VERIFY_005 = [
  'anon_no_table_access',
  'authenticated_no_table_access',
  'rls_on_not_forced',
  'no_policies',
  'realtime_unpublished',
  'replica_identity_default',
  'functions_intact',
  'prune_locked',
  'throwaway_ids_free',
  'acting_as_anon',
  'anon_select_refused',
  'anon_insert_refused',
  'anon_update_refused',
  'rpc_create_ok',
  'rpc_cas_ok',
  'rpc_old_token_is_conflict',
  'rpc_newer_token_is_conflict',
  'rpc_pull_ok',
  'rpc_head_ok',
  'nothing_left_behind',
]

/** Runs a verify file and asserts it left no row and no catalog change behind. */
async function verifyClean(relay: PgRelay, c: '004_verify' | '005_verify'): Promise<Verdict[]> {
  const catalog = await relay.catalogSnapshot()
  const data = await relay.dataSnapshot()
  const raw = await relay.check(c)
  expect(await relay.catalogSnapshot(), `${c} left a catalog change`).toBe(catalog)
  expect(await relay.dataSnapshot(), `${c} left a row`).toBe(data)
  for (const cell of cells(raw)) expect(cell).not.toMatch(UUID_RE)
  const who = await relay.rows<{ u: string }>(`SELECT current_user AS u`)
  expect(who).toEqual([{ u: OWNER }])
  return verify(relay, c)
}

describe('004_verify.sql (AC-14)', () => {
  it(
    'PASSes on a correctly migrated relay, as the non-superuser owner, with row 0 the result; twice is the same',
    async () => {
      const relay = await relayAt('004')
      await relay.seed([{ id: throwaway(0x900), payload: v5Payload('owner-like row') }])
      const rows = await verifyClean(relay, '004_verify')
      expect(rows.map((r) => r.check)).toEqual(['RESULT', ...VERIFY_004])
      expect(failed(rows)).toEqual([])
      expect(verdictOf(rows)).toMatchObject({
        expected: 'all pass',
        actual: `PASS ${String(VERIFY_004.length)}/${String(VERIFY_004.length)}`,
        pass: true,
      })
      expect(rows.find((r) => r.check === 'acting_as_anon')?.actual).toBe('anon')
      const again = await verifyClean(relay, '004_verify')
      expect(verdictOf(again).pass).toBe(true)
    },
    SLOW,
  )

  it(
    'FAILs by name before 004 and after 005',
    async () => {
      const before = await relayAt('001-003')
      const b = await verifyClean(before, '004_verify')
      expect(verdictOf(b).pass).toBe(false)
      expect(failed(b)).toEqual(
        expect.arrayContaining([
          'functions_present',
          'anon_cannot_delete_or_truncate',
          'prune_locked',
          'write_guards_present',
          'create_ok',
          'table_guard_refuses_bad_row',
          'anon_cannot_delete',
        ]),
      )
      expect(failed(b)).not.toContain('nothing_left_behind')
      expect(verdictOf(b).actual).toMatch(/^FAIL \d+\/\d+: functions_present, /)
      const locked = await relayAt('005')
      const l = await verifyClean(locked, '004_verify')
      expect(failed(l)).toEqual([
        'old_clients_still_work',
        'not_locked_yet',
        'table_guard_refuses_bad_row',
      ])
    },
    SLOW,
  )

  it(
    'not_locked_yet passes when the table was never in the Realtime publication (as on the live project at gate C)',
    async () => {
      const relay = await relayAt('004')
      await relay.run(`ALTER PUBLICATION supabase_realtime DROP TABLE public.sync_buckets`)
      const r = await verifyClean(relay, '004_verify')
      expect(failed(r)).toEqual([])
      expect(verdictOf(r).actual).toMatch(/^PASS \d+\/\d+$/)
    },
    SLOW,
  )

  it(
    'FAILs with the right names after each mutation',
    async () => {
      const relay = await relayAt('004')
      const cases: readonly (readonly [string, string, readonly string[]])[] = [
        [
          'search_path removed',
          `ALTER FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) RESET search_path`,
          ['functions_search_path_pinned'],
        ],
        [
          'definer off',
          `ALTER FUNCTION public.st_sync_pull(text) SECURITY INVOKER`,
          ['functions_security_definer'],
        ],
        [
          'anon EXECUTE revoked',
          `REVOKE EXECUTE ON FUNCTION public.st_sync_head(text) FROM anon`,
          [
            'functions_execute_anon_authenticated',
            'head_missing_is_null',
            'force_missing_is_missing',
            'pull_matches_head',
          ],
        ],
        [
          'PUBLIC EXECUTE granted',
          `GRANT EXECUTE ON FUNCTION public.st_sync_head(text) TO PUBLIC`,
          ['functions_no_public_execute'],
        ],
        [
          'prune re-granted',
          `GRANT EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) TO anon`,
          ['prune_locked', 'anon_cannot_delete'],
        ],
        [
          'DELETE re-granted',
          `GRANT DELETE ON public.sync_buckets TO anon`,
          ['anon_cannot_delete_or_truncate', 'anon_cannot_delete'],
        ],
        [
          'id guard dropped',
          `ALTER TABLE public.sync_buckets DROP CONSTRAINT sync_buckets_id_uuid`,
          ['write_guards_present', 'table_guard_refuses_bad_row'],
        ],
        [
          'index dropped',
          `DROP INDEX public.sync_buckets_created_at_idx`,
          ['write_guards_present'],
        ],
      ]
      for (const [label, mutate, expected] of cases) {
        await relay.run(mutate)
        const rows = await verifyClean(relay, '004_verify')
        expect(failed(rows), label).toEqual(expected)
        expect(verdictOf(rows).actual, label).toBe(
          `FAIL ${String(expected.length)}/${String(VERIFY_004.length)}: ${expected.join(', ')}`,
        )
        await relay.apply('004') // re-applying 004 repairs each of them
        expect(verdictOf(await verify(relay, '004_verify')).pass, `${label} repaired`).toBe(true)
      }
    },
    SLOW,
  )

  it(
    'adapts at the creation caps (500 rows, or 20 this hour) and near them',
    async () => {
      for (const [label, fill] of [
        ['500 rows', { count: 500, createdAgo: '2 hours' }],
        ['20 this hour', { count: 20, createdAgo: '5 minutes' }],
        ['19 this hour', { count: 19, createdAgo: '5 minutes' }],
        ['499 rows', { count: 499, createdAgo: '2 hours' }],
      ] as const) {
        const relay = await relayAt('004')
        await relay.fill(fill)
        const rows = await verifyClean(relay, '004_verify')
        expect(failed(rows), label).toEqual([])
        const create = rows.find((r) => r.check === 'create_ok')?.actual ?? ''
        if (label === '500 rows' || label === '20 this hour')
          expect(create, label).toMatch(/^53400/)
        else expect(create, label).toBe('ok')
        await relay.close()
        open.splice(open.indexOf(relay), 1)
      }
    },
    SLOW,
  )

  it(
    'marks the anon check SKIPPED, and still PASSes, when the editor cannot act as anon',
    async () => {
      const relay = await relayAt('004')
      await relay.superuser(`REVOKE anon FROM ${OWNER}`)
      const rows = await verifyClean(relay, '004_verify')
      expect(rows.find((r) => r.check === 'acting_as_anon')).toMatchObject({
        actual:
          'SKIPPED: could not act as anon here; scripts/verify-cas.mjs checks this through the API',
        pass: true,
      })
      expect(rows.find((r) => r.check === 'anon_cannot_delete')?.actual).toMatch(/^SKIPPED/)
      expect(verdictOf(rows).pass).toBe(true)
    },
    SLOW,
  )

  it(
    'refuses to work on a row that already has one of its own ids',
    async () => {
      const relay = await relayAt('004')
      await relay.seed([{ id: '00000000-0000-4000-8000-0000000000a1', payload: v5Payload() }])
      const rows = await verifyClean(relay, '004_verify')
      expect(failed(rows)).toContain('throwaway_ids_free')
      expect(rows.map((r) => r.check)).not.toContain('create_ok')
    },
    SLOW,
  )
})

describe('005_verify.sql (AC-15)', () => {
  it(
    'PASSes after 005 (and at the caps), FAILs before 005 and after the 005 rollback; no trace',
    async () => {
      const relay = await relayAt('005')
      const rows = await verifyClean(relay, '005_verify')
      expect(rows.map((r) => r.check)).toEqual(['RESULT', ...VERIFY_005])
      expect(failed(rows)).toEqual([])
      expect(verdictOf(rows).actual).toBe(
        `PASS ${String(VERIFY_005.length)}/${String(VERIFY_005.length)}`,
      )
      await relay.fill({ count: 500, createdAgo: '2 hours' })
      const capped = await verifyClean(relay, '005_verify')
      expect(failed(capped)).toEqual([])
      expect(capped.find((r) => r.check === 'rpc_create_ok')?.actual).toMatch(/^53400/)
      await relay.run(`DELETE FROM public.sync_buckets`)

      await relay.apply('005-rollback')
      const rolled = await verifyClean(relay, '005_verify')
      expect(verdictOf(rolled).pass).toBe(false)
      expect(failed(rolled)).toEqual([
        'anon_no_table_access',
        'authenticated_no_table_access',
        'rls_on_not_forced',
        'realtime_unpublished',
        'replica_identity_default',
        'anon_select_refused',
        'anon_insert_refused',
        'anon_update_refused',
      ])
      const before = await relayAt('004')
      expect(verdictOf(await verifyClean(before, '005_verify')).pass).toBe(false)
    },
    SLOW,
  )

  it(
    'SKIPPED when the editor cannot act as anon; FAILs when a function was altered',
    async () => {
      const relay = await relayAt('005')
      await relay.superuser(`REVOKE anon FROM ${OWNER}`)
      const skipped = await verifyClean(relay, '005_verify')
      expect(skipped.find((r) => r.check === 'acting_as_anon')?.actual).toMatch(/^SKIPPED/)
      expect(verdictOf(skipped).pass).toBe(true)
      await relay.run(`ALTER FUNCTION public.st_sync_head(text) SECURITY INVOKER`)
      const altered = await verifyClean(relay, '005_verify')
      expect(failed(altered)).toContain('functions_intact')
      // skipped behaviour still reads the grants: with the table open again, it FAILs
      await relay.run(`ALTER FUNCTION public.st_sync_head(text) SECURITY DEFINER`)
      await relay.apply('005-rollback')
      const reopened = await verifyClean(relay, '005_verify')
      expect(reopened.find((r) => r.check === 'acting_as_anon')?.actual).toMatch(/^SKIPPED/)
      expect(failed(reopened)).toEqual(
        expect.arrayContaining([
          'anon_select_refused',
          'anon_insert_refused',
          'anon_update_refused',
        ]),
      )
    },
    SLOW,
  )
})
