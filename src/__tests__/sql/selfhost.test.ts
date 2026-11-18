// @vitest-environment node
// docs/SELF_HOST.md on real Postgres: a new user's path from an EMPTY Supabase project. The
// guide's step table is replayed as written (its files, in its order, each check's row 0 and
// each preflight's verdict and stage as its Expect column says), its build settings are the
// ones stubbed, and the app's unmodified RPC transport (src/services/syncService.ts) then makes
// a private-sync round trip with the real codec: create, compare-and-set, a stale write refused,
// pull and open, and a second device that holds only the code. The guide's prune SQL runs as
// the owner and is refused to the public key. Invented data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { b64urlEncode } from '../../data/core/b64url'
import { encodeSt5, parseSt5 } from '../../data/core/codes'
import { deriveKeys, open, seal, type Envelope, type SyncKeys } from '../../data/core/e2e'
import {
  bootRelay,
  closeTemplate,
  failureOf,
  migrationSql,
  type CheckFile,
  type Migration,
  type PgRelay,
} from '../pgRelay'
import { pgRest } from '../pgRest'

const SLOW = 120_000
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW })

const GUIDE =
  import.meta.glob<string>('/docs/SELF_HOST.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  })['/docs/SELF_HOST.md'] ?? ''

const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001_sync.sql': '001',
  '002_sync_indexes.sql': '002',
  '003_harden_prune_search_path.sql': '003',
  '004_sync_rpc.sql': '004',
  '005_sync_lockdown.sql': '005',
  '006_sync_sticky_marker.sql': '006',
}
const CHECKS: Readonly<Record<string, CheckFile>> = {
  '000_preflight_readonly.sql': 'preflight',
  '004_verify.sql': '004_verify',
  '005_verify.sql': '005_verify',
  '006_verify.sql': '006_verify',
}

type Step =
  | { readonly n: number; readonly kind: 'migration'; readonly file: Migration }
  | {
      readonly n: number
      readonly kind: 'preflight'
      readonly verdict: string
      readonly stage: string
    }
  | {
      readonly n: number
      readonly kind: 'verify'
      readonly file: CheckFile
      readonly result: string
    }

/** The step table of "Step 2 · Run the SQL files", row by row. */
function guideSteps(): Step[] {
  const steps: Step[] = []
  for (const line of GUIDE.split('\n')) {
    const m =
      /^\|\s*(\d+)\s*\|.*\]\(\.\.\/supabase\/(migrations|checks)\/([\w.]+)\)\s*\|(.*)\|\s*$/.exec(
        line,
      )
    if (m === null) continue
    const [, num = '', dir = '', file = '', expect = ''] = m
    const n = Number(num)
    const ticks = [...expect.matchAll(/`([^`]+)`/g)].map((t) => t[1] ?? '')
    if (dir === 'migrations') {
      const mig = MIGRATIONS[file]
      if (mig === undefined) throw new Error(`step ${num}: unknown migration ${file}`)
      if (expect.trim() !== 'Success. No rows returned') throw new Error(`step ${num}: ${expect}`)
      steps.push({ n, kind: 'migration', file: mig })
      continue
    }
    const check = CHECKS[file]
    if (check === undefined) throw new Error(`step ${num}: unknown check ${file}`)
    if (check === 'preflight') {
      const pairs = new Map<string, string>()
      for (let i = 0; i + 1 < ticks.length; i += 2) pairs.set(ticks[i] ?? '', ticks[i + 1] ?? '')
      steps.push({
        n,
        kind: 'preflight',
        verdict: pairs.get('verdict') ?? '',
        stage: pairs.get('stage') ?? '',
      })
    } else {
      steps.push({ n, kind: 'verify', file: check, result: ticks[0] ?? '' })
    }
  }
  return steps
}

/** The `VITE_*` lines of the guide's build-settings block (step 4). */
function guideEnv(): Record<string, string> {
  const block = /```dotenv\n([\s\S]*?)```/.exec(GUIDE)?.[1] ?? ''
  const env: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = /^(VITE_[A-Z_]+)=(.*)$/.exec(line.trim())
    if (m !== null) env[m[1] ?? ''] = m[2] ?? ''
  }
  return env
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v))

async function preflight(relay: PgRelay): Promise<Map<string, string>> {
  const rows = await relay.check('preflight')
  return new Map(rows.map((r) => [str(r.item), str(r.value)]))
}

async function verifyRow0(relay: PgRelay, c: CheckFile) {
  const rows = await relay.check(c)
  const head = rows[0] ?? {}
  return {
    check: str(head.check),
    actual: str(head.actual),
    pass: head.pass === true,
    failed: rows.filter((r) => r.pass !== true).map((r) => str(r.check)),
  }
}

let relay: PgRelay

beforeAll(async () => {
  relay = await bootRelay('none')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await relay.close()
  await closeTemplate()
})

describe('docs/SELF_HOST.md, step 2 on an empty project', () => {
  it('the guide lists 001 to 006 in order, with a check after each stage', () => {
    const steps = guideSteps()
    expect(steps.map((s) => s.n)).toEqual(steps.map((_, i) => i + 1))
    expect(steps.filter((s) => s.kind === 'migration').map((s) => s.file)).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
    ])
    expect(steps.map((s) => (s.kind === 'migration' ? s.file : s.kind))).toEqual([
      '001',
      '002',
      '003',
      'preflight',
      '004',
      'verify',
      'preflight',
      '005',
      'verify',
      '006',
      'verify',
      'verify',
      'preflight',
    ])
  })

  it('the preflight before 001 is the error the guide names', async () => {
    const r = await bootRelay('none')
    try {
      const failure = await failureOf(() => r.check('preflight'))
      expect(failure.message).toBe('relation "public.sync_buckets" does not exist')
    } finally {
      await r.close()
    }
  })

  it('every step does what its Expect column says, in the order given', async () => {
    const log: string[] = []
    for (const step of guideSteps()) {
      if (step.kind === 'migration') {
        await relay.run(migrationSql(step.file))
        log.push(`${String(step.n)} ${step.file}: applied`)
      } else if (step.kind === 'preflight') {
        const p = await preflight(relay)
        log.push(`${String(step.n)} preflight: ${p.get('verdict') ?? ''} ${p.get('stage') ?? ''}`)
        expect(p.get('verdict'), `step ${String(step.n)}: ${JSON.stringify([...p])}`).toBe(
          step.verdict,
        )
        expect(p.get('stage'), `step ${String(step.n)}`).toBe(step.stage)
        expect(p.get('rows_total'), `step ${String(step.n)}`).toBe('0 of the 500 cap')
      } else {
        const v = await verifyRow0(relay, step.file)
        log.push(`${String(step.n)} ${step.file}: ${v.actual}`)
        expect(v.check, `step ${String(step.n)}`).toBe('RESULT')
        expect(v.actual, `step ${String(step.n)}: failed ${v.failed.join(', ')}`).toBe(step.result)
        expect(v.pass).toBe(true)
        expect(v.failed).toEqual([])
      }
    }
    console.info(`[SELF_HOST] step table on an empty project\n  ${log.join('\n  ')}`)
    // the checks leave nothing behind
    expect(await relay.rows('SELECT sync_id FROM public.sync_buckets')).toEqual([])
  })

  it('004_verify FAILs after 005, as the guide warns (so it belongs right after 004)', async () => {
    const v = await verifyRow0(relay, '004_verify')
    expect(v.actual).toMatch(/^FAIL /)
    expect(v.pass).toBe(false)
  })
})

// ─── step 4 and step 5: the build settings and a private sync through the functions ─────────

type Service = typeof import('../../services/syncService')
type Config = typeof import('../../services/syncConfig')

const BASE = 'http://relay.test'
const KEY = 'invented-anon-key'
const CREATE = { base: null, force: false, keepalive: false }
const casOn = (base: string) => ({ base, force: false, keepalive: false })

async function loadApp(): Promise<{ svc: Service; cfg: Config }> {
  const env = guideEnv()
  expect(Object.keys(env).sort()).toEqual([
    'VITE_SUPABASE_ANON_KEY',
    'VITE_SUPABASE_URL',
    'VITE_SYNC_RELAY',
  ])
  vi.stubGlobal('fetch', pgRest(relay).fetch)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.stubEnv('VITE_SUPABASE_URL', BASE)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', KEY)
  vi.resetModules()
  return {
    svc: await import('../../services/syncService'),
    cfg: await import('../../services/syncConfig'),
  }
}

/** An invented inner payload, revision `r` (the inner x5.rev and the envelope's r agree). */
const inner = (r: string, note: string) => ({
  version: '4.0',
  exportDate: '2026-10-01T04:00:00.000Z',
  expenses: [
    { id: 'e1', itemName: note, amount: 4.5, category: 'Other', date: '2026-10-01T12:00:00' },
  ],
  categories: ['Other'],
  deletedIds: [],
  x5: { schema: 5, minor: 0, min: 4, rev: r, dig: 'abc' },
})

const randomRev = (): string => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))

async function sealed(keys: SyncKeys, r: string, note: string): Promise<Envelope> {
  const out = await seal(JSON.stringify(inner(r, note)), keys, {
    r,
    iv: crypto.getRandomValues(new Uint8Array(12)),
    z: 0,
  })
  if (!out.ok) throw new Error('could not seal')
  return out.envelope
}

function etagOf(outcome: { readonly ok: boolean; readonly etag?: string }): string {
  if (!outcome.ok || outcome.etag === undefined) throw new Error('the push did not land')
  return outcome.etag
}

function keysOf(code: string): Promise<SyncKeys> {
  const parsed = parseSt5(code)
  if (!parsed.ok) throw new Error(`not a private code: ${parsed.reason}`)
  return deriveKeys(parsed.secret)
}

describe('docs/SELF_HOST.md, steps 4 and 5 after the step table', () => {
  it("the guide's settings make a private-ready build on the sync functions only", async () => {
    const { svc, cfg } = await loadApp()
    expect(svc.RELAY_PIN).toBe('rpc')
    expect(svc.CAS_ON).toBe(false)
    expect(cfg.syncEnabled).toBe(true)
    expect(cfg.privateSyncReady).toBe(true)
  })

  it('a private sync round trip through the real transport: create, compare-and-set, a stale write refused, pull, and a second device with only the code', async () => {
    const code = encodeSt5(crypto.getRandomValues(new Uint8Array(16)))
    expect(code).toMatch(/^ST5-/)

    // Device A generates and pushes its first copy.
    const a = await loadApp()
    const keysA = await keysOf(code)
    const { transport: tA } = await a.svc.openTransport(
      keysA.rowId,
      { mode: null, probedAt: 0 },
      Date.now(),
      false,
    )
    expect(tA.mode).toBe('rpc')
    expect(await tA.head(keysA.rowId)).toBeNull()
    expect(await tA.pull(keysA.rowId)).toBeNull()
    const r1 = randomRev()
    const e1 = etagOf(await tA.push(keysA.rowId, await sealed(keysA, r1, 'coffee'), CREATE))
    const r2 = randomRev()
    const env2 = await sealed(keysA, r2, 'coffee and cake')
    const e2 = etagOf(await tA.push(keysA.rowId, env2, casOn(e1)))
    expect(e2).not.toBe(e1)
    expect(await tA.head(keysA.rowId)).toBe(e2)
    // a write on the old token is a conflict and lands nothing
    expect(
      await tA.push(keysA.rowId, await sealed(keysA, randomRev(), 'stale'), casOn(e1)),
    ).toEqual({ ok: false, reason: 'conflict' })

    // Device B has only the code: it derives the same row and key, pulls and opens the copy.
    const b = await loadApp()
    const keysB = await keysOf(code.toLowerCase().replaceAll('-', ' '))
    expect(keysB.rowId).toBe(keysA.rowId)
    const { transport: tB } = await b.svc.openTransport(
      keysB.rowId,
      { mode: null, probedAt: 0 },
      Date.now(),
      false,
    )
    expect(tB.mode).toBe('rpc')
    const pulled = await tB.pull(keysB.rowId)
    expect(pulled).toEqual({ payload: env2, etag: e2 })
    expect(await open(pulled?.payload, keysB)).toEqual({
      ok: true,
      inner: inner(r2, 'coffee and cake'),
    })
    // B writes back on the token it pulled; A sees B's copy
    const r3 = randomRev()
    const e3 = etagOf(await tB.push(keysB.rowId, await sealed(keysB, r3, 'tea'), casOn(e2)))
    const back = await tA.pull(keysA.rowId)
    expect(back?.etag).toBe(e3)
    expect(await open(back?.payload, keysA)).toEqual({ ok: true, inner: inner(r3, 'tea') })

    // What the database holds: one row, under the derived id, ciphertext only.
    const stored = await relay.rows<{ sync_id: string; payload: string }>(
      'SELECT sync_id, payload::text AS payload FROM public.sync_buckets',
    )
    expect(stored.map((s) => s.sync_id)).toEqual([keysA.rowId])
    expect(keysA.rowId).not.toContain(code)
    const text = stored[0]?.payload ?? ''
    expect(text).toContain('"st": 5')
    for (const secret of ['tea', 'coffee', 'Other', code]) expect(text).not.toContain(secret)

    // The lockdown: the public key cannot read the table directly.
    const denied = await failureOf(() =>
      relay.as('anon', (tx) => tx.query('SELECT sync_id FROM public.sync_buckets')),
    )
    expect(denied.code).toBe('42501')

    // The preflight still says GO and counts the private row.
    const p = await preflight(relay)
    expect(p.get('verdict')).toBe('GO')
    expect(p.get('stage')).toBe('005 applied')
    expect(p.get('writer_classes')).toContain('private 1')
  })
})

describe('docs/SELF_HOST.md, section 4: the prune', () => {
  it("the guide's prune runs as the owner (the scheduled statement too) and is refused to the public key", async () => {
    const blocks = [...GUIDE.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').trim())
    const byHand = blocks.find((b) => b.startsWith('SELECT public.prune_stale_sync_buckets'))
    const scheduled = blocks.find((b) => b.includes('cron.schedule'))
    const inCron = /\$\$(.*)\$\$/.exec(scheduled ?? '')?.[1]
    expect(byHand).toBeDefined()
    expect(inCron).toBeDefined()
    for (const sql of [byHand ?? '', inCron ?? '']) {
      const rows = await relay.rows<{ prune_stale_sync_buckets: number | string }>(sql)
      expect(Number(rows[0]?.prune_stale_sync_buckets)).toBe(0)
    }
    // the private row from the round trip is fresh, so it stays
    expect(await relay.rows('SELECT 1 FROM public.sync_buckets')).toHaveLength(1)
    const refused = await failureOf(() => relay.as('anon', (tx) => tx.query(byHand ?? '')))
    expect(refused.code).toBe('42501')
  })
})
