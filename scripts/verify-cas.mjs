#!/usr/bin/env node
// The CAS check (DATA-ENGINE-SPEC §18.1, PR-5 track spec §3.8). The owner runs it himself, from
// his laptop, against his own project: once at gate C before he sets VITE_SYNC_CAS=on, and with
// --lockdown at gate E after 005. Nobody else runs it against a real project.
//
//   node scripts/verify-cas.mjs --row 00000000-0000-4000-8000-<12 hex>
//     a. an insert of a throwaway row returns its etag (`updated_at` as PostgREST prints it)
//     b. a write conditional on that exact etag changes 1 row
//     c. a write conditional on the old etag changes 0 rows (a conflict)
//     d. the new etag is later than the old one
//     then, once 004 is applied (the sync functions answer; else `SKIP e–j`):
//     e. st_sync_head returns the current etag        f. st_sync_push on it lands
//     g. st_sync_push on an old etag is a conflict    h. st_sync_pull returns payload and etag
//     i. st_sync_push refuses a payload without x5    j. a forced push to a missing row creates
//        nothing (on a second throwaway id)
//   node scripts/verify-cas.mjs --lockdown [--row <throwaway id>]       (read-only)
//     l. listing the table is refused (401/403, 42501)  m. st_sync_head still answers
//
// Safety: it reads ST_VERIFY_URL and ST_VERIFY_ANON_KEY and nothing else (no .env, no VITE_*);
// it refuses (exit 2, before any write) without an https project URL, with a secret or
// service_role key, or without a lower-case throwaway id in 00000000-0000-4000-8000-<12 hex>,
// which no real code ever is; it reads first and refuses a row that already exists; it inserts
// (never upserts) and filters every write by the throwaway id; it stops at the first unexpected
// answer; it never prints the key, and prints the URL's host only. The requests are the ones
// 0.11.0 sends, through the same SDK. Exit 0 pass, 1 fail (also a network failure), 2 refused.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const TABLE = 'sync_buckets'
const TIMEOUT_MS = 15_000
const THROWAWAY = /^00000000-0000-4000-8000-[0-9a-f]{12}$/
const THROWAWAY_PREFIX = '00000000-0000-4000-8000-'
/** The id --lockdown asks st_sync_head about when none is given (it only reads). */
export const LOCKDOWN_ROW = '00000000-0000-4000-8000-000000000000'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** What every write of the check stores: a v5-shaped object that says what it is. */
export const PAYLOAD = Object.freeze({
  spendtrack: 'verify-cas',
  note: 'Throwaway row from scripts/verify-cas.mjs. Safe to delete.',
  version: '4.0',
  expenses: Object.freeze([]),
  x5: Object.freeze({ schema: 5, verifyCas: true }),
})

/** A 0.8.x–0.10.0 payload (no x5): fine on the table, refused by st_sync_push (check i). */
export const OLD_FORMAT = Object.freeze({
  spendtrack: 'verify-cas',
  note: PAYLOAD.note,
  version: '4.0',
  expenses: Object.freeze([]),
})

const USAGE = `Usage:
  node scripts/verify-cas.mjs --row 00000000-0000-4000-8000-<12 hex digits>
      The CAS check (gate C). Writes one throwaway row, and nothing else.
  node scripts/verify-cas.mjs --lockdown [--row 00000000-0000-4000-8000-<12 hex digits>]
      The lockdown check (gate E). Read-only.
It reads only ST_VERIFY_URL (https://<project-ref>.supabase.co) and ST_VERIFY_ANON_KEY (the anon
or publishable key, never the service_role or secret key) from the environment.
Exit 0: PASS. Exit 1: FAIL (paste the output to the lead). Exit 2: refused, nothing was written.
`

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// ─── Inputs ─────────────────────────────────────────────────────────────────────────────────

/** `{ mode: 'cas' | 'lockdown' | 'help', row }`, or `{ refused }`. */
export function parseArgs(argv) {
  let mode = 'cas'
  let row = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { mode: 'help', row: null }
    if (arg === '--lockdown') mode = 'lockdown'
    else if (arg === '--row') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return { refused: '--row needs an id' }
      row = next
      i++
    } else if (arg.startsWith('--row=')) row = arg.slice('--row='.length)
    else return { refused: `unknown option ${arg}` }
  }
  return { mode, row }
}

/** `{ origin, host }` of the project URL, or `{ refused }`. */
export function checkUrl(text) {
  if (typeof text !== 'string' || text.trim() === '') return { refused: 'ST_VERIFY_URL is not set' }
  let url
  try {
    url = new URL(text.trim())
  } catch {
    return { refused: 'ST_VERIFY_URL is not a URL' }
  }
  if (url.username !== '' || url.password !== '') {
    return { refused: 'ST_VERIFY_URL must not carry a user name or password' }
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    return { refused: 'ST_VERIFY_URL must start with https:// (http:// only for localhost)' }
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return {
      refused:
        'ST_VERIFY_URL must be the project URL alone, like https://<project-ref>.supabase.co',
    }
  }
  return { origin: url.origin, host: url.host }
}

function jwtRole(key) {
  const parts = key.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    return isRecord(claims) && typeof claims.role === 'string' ? claims.role : null
  } catch {
    return null
  }
}

/** Null for an anon JWT or a publishable key, else why the key is refused (never the key). */
export function checkKey(key) {
  if (typeof key !== 'string' || key.trim() === '') return 'ST_VERIFY_ANON_KEY is not set'
  const k = key.trim()
  if (k.startsWith('sb_secret_')) {
    return 'ST_VERIFY_ANON_KEY is a secret key; use the anon (public) key'
  }
  if (k.startsWith('sb_publishable_')) return null
  const role = jwtRole(k)
  if (role === 'anon') return null
  if (role !== null && /^[a-z_]{1,32}$/.test(role)) {
    return `ST_VERIFY_ANON_KEY is the ${role} key; use the anon (public) key`
  }
  return 'ST_VERIFY_ANON_KEY is not an anon key (expected the anon JWT or an sb_publishable_ key)'
}

/** Null for a lower-case throwaway id, else why it is refused. */
export function checkRow(row) {
  if (typeof row !== 'string' || row === '') {
    return '--row is missing: give a throwaway id, e.g. --row 00000000-0000-4000-8000-202611030001'
  }
  if (THROWAWAY.test(row)) return null
  if (THROWAWAY.test(row.toLowerCase())) return '--row must be in lower case'
  return '--row must be a throwaway id: 00000000-0000-4000-8000- and 12 hex digits'
}

/** The second throwaway id check j forces at: the bitwise complement of the id's last 12 digits. */
export function secondRow(row) {
  const tail = BigInt(`0x${row.slice(THROWAWAY_PREFIX.length)}`)
  return THROWAWAY_PREFIX + (tail ^ 0xffffffffffffn).toString(16).padStart(12, '0')
}

// ─── Etags, as 0.11.0 reads and writes them (src/services/syncService.ts) ────────────────────

const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/** An ISO time stamp as integer microseconds since the epoch (no zone = UTC), or null. */
function micros(text) {
  const m = typeof text === 'string' ? STAMP.exec(text) : null
  if (m === null) return null
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m
  let offset = 0
  if (zone !== 'Z') {
    const hm = zone.slice(1).replace(':', '')
    offset =
      (zone.startsWith('-') ? -1 : 1) * (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2) || 0))
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return (ms - offset * 60_000) * 1000 + Number(frac.padEnd(6, '0'))
}

/** Both etags name one instant (PostgREST prints `+00:00` and trims zeros). */
export function sameInstant(a, b) {
  const x = micros(a)
  return x !== null && x === micros(b)
}

const later = (a, b) => {
  const x = micros(a)
  const y = micros(b)
  return x !== null && y !== null && x > y
}

/** 0.11.0's write token: strictly after `base`, 6 digits and `Z`. */
function tok(base) {
  const floor = base === null ? null : micros(base)
  const t = Math.max(Date.now() * 1000 + Math.floor(Math.random() * 1000), (floor ?? -1) + 1)
  const ms = Math.floor(t / 1000)
  return `${new Date(ms).toISOString().slice(0, 23)}${String(t - ms * 1000).padStart(3, '0')}Z`
}

/** The same JSON whatever the key order (jsonb sorts keys). */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (!isRecord(v)) return v
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canonical(v[k])]),
  )
}
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

// ─── Answers ─────────────────────────────────────────────────────────────────────────────────

const unreachable = (res) => res.error !== null && res.status === 0
const locked = (res) =>
  res.error !== null && (res.status === 401 || res.status === 403 || res.error.code === '42501')
const noRpc = (res) => res.error !== null && (res.error.code === 'PGRST202' || res.status === 404)

/** What came back, briefly: status, code and message (never `details`, which can echo a row). */
function describe(res) {
  if (res.error === null) return `HTTP ${res.status}: ${short(res.data)}`
  const code = res.error.code ? `, ${res.error.code}` : ''
  const message = res.error.message ? `: ${res.error.message}` : ''
  return `HTTP ${res.status}${code}${message}`
}

function short(value) {
  const text = JSON.stringify(value) ?? 'nothing'
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/** A fetch that gives up after `ms` (a hung request is a network failure, never a hang). */
const withDeadline =
  (fetchImpl, ms) =>
  (input, init = {}) =>
    fetchImpl(input, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) })

// ─── The checks ──────────────────────────────────────────────────────────────────────────────

/** PASS / FAIL / SKIP lines and their tally. */
function checklist(say) {
  let passed = 0
  let failed = 0
  return {
    pass(id, text) {
      passed++
      say(`PASS ${id}. ${text}`)
    },
    fail(id, text) {
      failed++
      say(`FAIL ${id}. ${text}`)
    },
    skip(ids, text) {
      say(`SKIP ${ids}. ${text}`)
    },
    get passed() {
      return passed
    },
    get failed() {
      return failed
    },
  }
}

const reachFail = (check, id, host, res) =>
  check.fail(id, `could not reach ${host} (${res.error.message || 'no answer'})`)

/** Fails check `id` for an answer that is an error; true when it did. */
function failedOn(check, id, host, res) {
  if (res.error === null) return false
  if (unreachable(res)) reachFail(check, id, host, res)
  else check.fail(id, `unexpected answer (${describe(res)})`)
  return true
}

/**
 * The CAS check. Returns 'refused' when the row already exists (nothing written); otherwise the
 * checklist holds the outcome. Stops at the first failure: nothing more is written after an
 * unexpected answer.
 */
async function casCheck(db, row, host, check) {
  // 0. The row must be new: a read first, so an existing row (a rerun, or anything else) is
  //    never written to.
  const seen = await db.from(TABLE).select('sync_id').eq('sync_id', row).retry(false).maybeSingle()
  if (seen.error !== null) {
    if (locked(seen)) check.fail('a', 'the table is locked (005 applied); use --lockdown')
    else if (unreachable(seen)) reachFail(check, 'a', host, seen)
    else check.fail('a', `could not read the table (${describe(seen)})`)
    return 'done'
  }
  if (seen.data !== null) return 'refused'

  // a. insert, as 0.11.0 creates a row with CAS on (never an upsert)
  const a = await db
    .from(TABLE)
    .insert({ sync_id: row, payload: PAYLOAD, updated_at: tok(null) })
    .select('updated_at')
    .single()
  if (a.error !== null) {
    if (locked(a)) check.fail('a', 'the table is locked (005 applied); use --lockdown')
    else if (a.status === 409 || a.error.code === '23505') {
      check.fail('a', `the row was created meanwhile (${describe(a)}); nothing was overwritten`)
    } else failedOn(check, 'a', host, a)
    return 'done'
  }
  const first = isRecord(a.data) ? a.data.updated_at : null
  if (typeof first !== 'string' || micros(first) === null) {
    check.fail('a', `the insert returned no etag (${describe(a)})`)
    return 'done'
  }
  check.pass('a', `insert created the throwaway row; etag ${first}`)

  // b. a write conditional on that exact string, as 0.11.0 sends it (PATCH …&updated_at=eq.<etag>)
  const cas = (base) =>
    db
      .from(TABLE)
      .update({ payload: PAYLOAD, updated_at: tok(base) })
      .eq('sync_id', row)
      .eq('updated_at', base)
      .select('updated_at')
  const b = await cas(first)
  if (failedOn(check, 'b', host, b)) return 'done'
  const second = Array.isArray(b.data) && b.data.length === 1 ? b.data[0]?.updated_at : null
  if (typeof second !== 'string') {
    const n = Array.isArray(b.data) ? b.data.length : 0
    check.fail(
      'b',
      `a write based on that exact etag changed ${n} rows (expected 1: the etag does not round-trip)`,
    )
    return 'done'
  }
  check.pass('b', 'a write based on that exact etag changed 1 row')

  // c. the same write on the old etag
  const c = await cas(first)
  if (failedOn(check, 'c', host, c)) return 'done'
  const changed = Array.isArray(c.data) ? c.data.length : -1
  if (changed !== 0) {
    check.fail(
      'c',
      changed === 1
        ? 'a write based on the old etag changed 1 row (compare-and-set is not enforced)'
        : `a write based on the old etag answered ${describe(c)}`,
    )
    return 'done'
  }
  check.pass('c', 'a write based on the old etag changed 0 rows (a conflict)')

  // d. the token moved forward
  if (!later(second, first)) {
    check.fail('d', `the new etag ${second} is not later than ${first}`)
    return 'done'
  }
  check.pass('d', `the new etag ${second} is later than the old one`)

  // e–j. the sync functions (004), when they exist
  const e = await db.rpc('st_sync_head', { p_row: row })
  if (e.error !== null && noRpc(e)) {
    check.skip('e–j', 'sync functions not found (apply 004 first)')
    return 'done'
  }
  if (failedOn(check, 'e', host, e)) return 'done'
  if (!sameInstant(e.data, second)) {
    check.fail('e', `st_sync_head returned ${short(e.data)}, expected ${second}`)
    return 'done'
  }
  check.pass('e', 'st_sync_head returns the current etag')

  const pushRpc = (args) =>
    db.rpc('st_sync_push', {
      p_row: row,
      p_payload: PAYLOAD,
      p_base: null,
      p_force: false,
      ...args,
    })

  const f = await pushRpc({ p_base: second })
  if (failedOn(check, 'f', host, f)) return 'done'
  const third = isRecord(f.data) && f.data.ok === true ? f.data.updated_at : null
  if (typeof third !== 'string' || !later(third, second)) {
    check.fail('f', `st_sync_push based on the current etag answered ${short(f.data)}`)
    return 'done'
  }
  check.pass('f', `st_sync_push based on the current etag landed; etag ${third}`)

  const g = await pushRpc({ p_base: second })
  if (failedOn(check, 'g', host, g)) return 'done'
  const conflict =
    isRecord(g.data) &&
    g.data.ok === false &&
    g.data.reason === 'conflict' &&
    sameInstant(g.data.updated_at, third)
  if (!conflict) {
    check.fail('g', `st_sync_push based on an old etag answered ${short(g.data)}`)
    return 'done'
  }
  check.pass('g', 'st_sync_push based on an old etag is a conflict')

  const h = await db.rpc('st_sync_pull', { p_row: row })
  if (failedOn(check, 'h', host, h)) return 'done'
  const pulled =
    isRecord(h.data) && sameJson(h.data.payload, PAYLOAD) && sameInstant(h.data.updated_at, third)
  if (!pulled) {
    check.fail('h', 'st_sync_pull did not return the payload and the current etag')
    return 'done'
  }
  check.pass('h', 'st_sync_pull returns the payload and the current etag')

  const i = await pushRpc({ p_payload: OLD_FORMAT, p_base: third })
  if (i.error === null) {
    check.fail('i', `st_sync_push accepted a payload without x5 (${describe(i)})`)
    return 'done'
  }
  if (i.error.code !== '22023') {
    if (unreachable(i)) reachFail(check, 'i', host, i)
    else
      check.fail(
        'i',
        `st_sync_push refused a payload without x5, but not with 22023 (${describe(i)})`,
      )
    return 'done'
  }
  check.pass('i', 'st_sync_push refuses a payload without x5 (22023)')

  // j. force never creates: on a second throwaway id that does not exist
  const other = secondRow(row)
  const before = await db.rpc('st_sync_head', { p_row: other })
  if (failedOn(check, 'j', host, before)) return 'done'
  if (before.data !== null) {
    check.skip('j', `the second throwaway id ${other} exists`)
    return 'done'
  }
  const j = await db.rpc('st_sync_push', {
    p_row: other,
    p_payload: PAYLOAD,
    p_base: third,
    p_force: true,
  })
  if (failedOn(check, 'j', host, j)) return 'done'
  const after = await db.rpc('st_sync_head', { p_row: other })
  if (failedOn(check, 'j', host, after)) return 'done'
  const missing = isRecord(j.data) && j.data.ok === false && j.data.reason === 'missing'
  if (!missing || after.data !== null) {
    check.fail(
      'j',
      `a forced write to a missing row answered ${short(j.data)}; it must create nothing`,
    )
    return 'done'
  }
  check.pass('j', 'a forced write to a missing row returns missing and creates nothing')
  return 'done'
}

/** The lockdown check: two reads, both run. */
async function lockdownCheck(db, row, host, check) {
  const l = await db.from(TABLE).select('sync_id').limit(1).retry(false)
  if (l.error === null) {
    // never print what it listed
    check.fail('l', `the table still lists rows (HTTP ${l.status}); the lockdown is not applied`)
  } else if (locked(l) || l.error.code === 'PGRST205') {
    check.pass('l', `the table refuses to list rows (${describe(l)})`)
  } else if (unreachable(l)) {
    reachFail(check, 'l', host, l)
  } else {
    check.fail('l', `unexpected answer (${describe(l)})`)
  }

  const m = await db.rpc('st_sync_head', { p_row: row })
  if (m.error === null) check.pass('m', `st_sync_head answers (HTTP ${m.status})`)
  else if (unreachable(m)) reachFail(check, 'm', host, m)
  else if (noRpc(m))
    check.fail('m', `st_sync_head is missing (${describe(m).split(':')[0]}); apply 004 first`)
  else check.fail('m', `unexpected answer (${describe(m)})`)
}

// ─── run ─────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   out?: { write(text: string): unknown },
 *   err?: { write(text: string): unknown },
 *   timeoutMs?: number,
 * }} [io]
 * @returns {Promise<0 | 1 | 2>} exit code
 */
export async function run(io = {}) {
  const {
    argv = [],
    env = {},
    fetch = globalThis.fetch,
    out = process.stdout,
    err = process.stderr,
    timeoutMs = TIMEOUT_MS,
  } = io
  const key = typeof env.ST_VERIFY_ANON_KEY === 'string' ? env.ST_VERIFY_ANON_KEY.trim() : ''
  // the key never reaches the output, whatever a server or the SDK put in a message
  const redact = (text) => (key.length >= 8 ? text.split(key).join('[key]') : text)
  const say = (text) => out.write(`${redact(text)}\n`)
  const refuse = (why) => {
    err.write(`${redact(`REFUSED: ${why}. Nothing was written.`)}\n`)
    return 2
  }

  const args = parseArgs(argv)
  if (args.mode === 'help') {
    out.write(USAGE)
    return 0
  }
  if ('refused' in args) return refuse(args.refused)
  const url = checkUrl(env.ST_VERIFY_URL)
  if ('refused' in url) return refuse(url.refused)
  const keyProblem = checkKey(key)
  if (keyProblem !== null) return refuse(keyProblem)
  const lockdown = args.mode === 'lockdown'
  const rowProblem = lockdown && args.row === null ? null : checkRow(args.row)
  if (rowProblem !== null) return refuse(rowProblem)
  const row = args.row ?? LOCKDOWN_ROW

  const db = createClient(url.origin, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: withDeadline(fetch, timeoutMs) },
  })
  say(`verify-cas: ${url.host}  row ${row}`)
  const check = checklist(say)
  if (lockdown) {
    await lockdownCheck(db, row, url.host, check)
  } else if ((await casCheck(db, row, url.host, check)) === 'refused') {
    return refuse(`row ${row} already exists. Use a new id (the next run number)`)
  }

  const n = check.passed + check.failed
  if (check.failed === 0 && n > 0) {
    say(
      lockdown
        ? `RESULT: PASS (${n}/${n}). The lockdown holds.`
        : `RESULT: PASS (${n}/${n}). Safe to set VITE_SYNC_CAS=on.`,
    )
    return 0
  }
  say(
    lockdown
      ? `RESULT: FAIL (${check.failed} of ${n} failed). The lockdown does not hold. Paste this output to the lead.`
      : `RESULT: FAIL (${check.failed} of ${n} failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.`,
  )
  return 1
}

function isExecutedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(entry)
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked
  } catch {
    return false
  }
}

if (isExecutedDirectly()) {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: {
      ST_VERIFY_URL: process.env.ST_VERIFY_URL,
      ST_VERIFY_ANON_KEY: process.env.ST_VERIFY_ANON_KEY,
    },
    fetch: globalThis.fetch,
    out: process.stdout,
    err: process.stderr,
  })
}
