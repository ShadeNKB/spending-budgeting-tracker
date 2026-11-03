// A PostgREST-shaped `fetch` over the real-Postgres relay (PR-5 track spec §3.9, U1), so
// supabase-js, and 0.11.0's unmodified sync transport on top of it, talk to the real SQL.
//
// The HTTP handling mirrors e2e/data-engine/support/relayServer.ts (the requests 0.8.x to 0.11.0
// send: `select`, `eq.` filters, `limit`, `Prefer: resolution=merge-duplicates` and
// `return=representation`, `Accept: application/vnd.pgrst.object+json`, `/rpc/<fn>` with named
// JSON arguments), but every request runs in Postgres, in one transaction as the request's role
// (`set_config('role', …, true)`, as PostgREST does), and the statements are shaped like
// PostgREST's own (json_populate_recordset, json_to_record, json_agg): Postgres itself produces
// every JSON value (so every etag) and every error. Errors map to HTTP as PostgREST maps them.
//
// What it cannot show (stays a runbook check): PostgREST's schema cache and its reload, whether a
// function without EXECUTE answers 401 or 404, and anything about Realtime.
import { pgFailure, type PgRelay } from './pgRelay'
import type { Transaction } from '@electric-sql/pglite'

const TABLE_PATH = '/rest/v1/sync_buckets'
const RPC_PATH = '/rest/v1/rpc/'
const COLUMNS: ReadonlySet<string> = new Set(['sync_id', 'payload', 'updated_at', 'created_at'])
const OBJECT_ACCEPT = 'application/vnd.pgrst.object+json'

export type RestKind = 'head' | 'pull' | 'upsert' | 'insert' | 'update' | 'rpc' | 'other'

export interface RestRecord {
  readonly method: string
  readonly path: string
  readonly kind: RestKind
  readonly fn: string | null
  readonly status: number
  readonly code: string | null
}

export interface RestOptions {
  /** The role the API key stands for (PostgREST's anon role by default). */
  readonly role?: 'anon' | 'authenticated'
  /** The session time zone of every request (Supabase's default: UTC). */
  readonly timeZone?: string
}

export interface PgRest {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Every request, in order (method, path, kind, status, SQLSTATE). */
  readonly log: RestRecord[]
  setTimeZone(tz: string): void
  /** While offline, every request fails before it reaches the relay (a network error). */
  setOffline(offline: boolean): void
}

interface Answer {
  readonly status: number
  readonly body: string | null
  readonly code: string | null
}

/** Ends a request's transaction with ROLLBACK and answers `answer` (a 406 after a write). */
class Refusal extends Error {
  constructor(readonly answer: Answer) {
    super('refused')
  }
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`

function errorBody(
  code: string,
  message: string,
  details: string | null = null,
  hint: string | null = null,
): string {
  return JSON.stringify({ code, details, hint, message })
}

/** PostgREST's SQLSTATE → HTTP status table (the rows this relay can produce, and the rest). */
export function statusOf(code: string, role: 'anon' | 'authenticated'): number {
  if (code === '42501') return role === 'anon' ? 401 : 403
  if (code === '23503' || code === '23505') return 409
  if (code === '25006') return 405
  if (code === '42883' || code === '42P01') return 404
  if (code === 'P0001') return 400
  // 53400 (config limit exceeded: the relay is full) is 500; the rest of class 53 is 503
  if (code === '53400') return 500
  if (code.startsWith('08') || code.startsWith('53')) return 503
  if (/^(0L|0P|28)/.test(code)) return 403
  if (/^(09|25|2D|38|39|3B|40|54|55|57|58|F0|HV|P0|XX)/.test(code)) return 500
  return 400
}

function selectList(url: URL): string {
  const raw = url.searchParams.get('select') ?? '*'
  if (raw === '*') return '*'
  return raw
    .split(',')
    .map((c) => c.trim())
    .map((c) => {
      if (!COLUMNS.has(c)) throw new Refusal(badRequest(`column ${c} does not exist`))
      return ident(c)
    })
    .join(', ')
}

function badRequest(message: string): Answer {
  return { status: 400, body: errorBody('PGRST100', message), code: 'PGRST100' }
}

/** `col=eq.value` filters (decoded by URLSearchParams, as PostgREST decodes them). */
function filtersOf(url: URL, first: number): { readonly where: string; readonly params: string[] } {
  const parts: string[] = []
  const params: string[] = []
  for (const [key, value] of url.searchParams) {
    if (!COLUMNS.has(key)) continue
    if (!value.startsWith('eq.')) throw new Refusal(badRequest(`unsupported filter ${key}`))
    params.push(value.slice(3))
    parts.push(`public.sync_buckets.${ident(key)} = $${String(first + params.length - 1)}`)
  }
  return { where: parts.length === 0 ? 'true' : parts.join(' AND '), params }
}

function limitOf(url: URL): string {
  const raw = url.searchParams.get('limit')
  if (raw === null) return ''
  if (!/^\d+$/.test(raw)) throw new Refusal(badRequest('limit must be a number'))
  return ` LIMIT ${raw}`
}

/** The JSON a request's rows are answered with: `[…]`, or one object for `.single()`. */
const RESULT = (select: string, source: string) => `
  SELECT coalesce(json_agg(pgrst_t), '[]'::json)::text AS body,
         (json_agg(pgrst_t) -> 0)::text AS one,
         count(*)::int AS n
    FROM (SELECT ${select} FROM ${source}) AS pgrst_t`

interface Rows {
  readonly body: string
  readonly one: string | null
  readonly n: number
}

function represent(req: Request, status: number, rows: Rows | undefined, write: boolean): Answer {
  const accept = req.headers.get('accept') ?? ''
  const prefer = req.headers.get('prefer') ?? ''
  const n = rows?.n ?? 0
  if (accept.includes(OBJECT_ACCEPT)) {
    if (n !== 1 || rows?.one == null) {
      const answer: Answer = {
        status: 406,
        body: errorBody(
          'PGRST116',
          'JSON object requested, multiple (or no) rows returned',
          `The result contains ${String(n)} rows`,
        ),
        code: 'PGRST116',
      }
      // PostgREST rolls a write back when its singular answer is refused.
      if (write) throw new Refusal(answer)
      return answer
    }
    return { status, body: rows.one, code: null }
  }
  if (!write || prefer.includes('return=representation')) {
    return { status, body: rows?.body ?? '[]', code: null }
  }
  return { status: status === 200 ? 204 : status, body: null, code: null }
}

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const value: unknown = JSON.parse(text === '' ? '{}' : text)
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

const invalidJson: Answer = {
  status: 400,
  body: errorBody('PGRST102', 'Empty or invalid json'),
  code: 'PGRST102',
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The columns a POST or PATCH writes: `columns=` when sent, else the first object's keys. */
function writeColumns(url: URL, body: unknown): string[] {
  const listed = url.searchParams.get('columns')
  const keys =
    listed !== null
      ? listed.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      : Object.keys((Array.isArray(body) ? body.find(isObject) : isObject(body) ? body : {}) ?? {})
  for (const k of keys) {
    if (!COLUMNS.has(k)) throw new Refusal(badRequest(`column ${k} does not exist`))
  }
  return keys
}

async function onTable(tx: Transaction, req: Request, url: URL, method: string): Promise<Answer> {
  const select = selectList(url)
  if (method === 'GET') {
    const { where, params } = filtersOf(url, 1)
    const source = `(SELECT * FROM public.sync_buckets WHERE ${where}${limitOf(url)}) AS sync_buckets`
    const res = await tx.query<Rows>(RESULT(select, source), params)
    return represent(req, 200, res.rows[0], false)
  }
  const text = await req.text()
  const parsed = parseJson(text)
  if (!parsed.ok) return invalidJson
  const columns = writeColumns(url, parsed.value)
  const cols = columns.map(ident)
  if (method === 'POST') {
    const upsert = (req.headers.get('prefer') ?? '').includes('resolution=merge-duplicates')
    const conflict = upsert
      ? ` ON CONFLICT (sync_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
      : ''
    const sql = `
      WITH pgrst_source AS (
        INSERT INTO public.sync_buckets (${cols.join(', ')})
        SELECT ${cols.map((c) => `pgrst_body.${c}`).join(', ')}
          FROM json_populate_recordset(NULL::public.sync_buckets,
                 CASE WHEN json_typeof($1::json) = 'array' THEN $1::json ELSE json_build_array($1::json) END)
               AS pgrst_body${conflict}
        RETURNING public.sync_buckets.*)
      ${RESULT(select, 'pgrst_source')}`
    const res = await tx.query<Rows>(sql, [text])
    return represent(req, 201, res.rows[0], true)
  }
  if (method === 'PATCH') {
    const { where, params } = filtersOf(url, 2)
    const sql = `
      WITH pgrst_source AS (
        UPDATE public.sync_buckets
           SET ${cols.map((c) => `${c} = pgrst_body.${c}`).join(', ')}
          FROM (SELECT * FROM json_populate_record(NULL::public.sync_buckets, $1::json)) AS pgrst_body
         WHERE ${where}
        RETURNING public.sync_buckets.*)
      ${RESULT(select, 'pgrst_source')}`
    const res = await tx.query<Rows>(sql, [text, ...params])
    return represent(req, 200, res.rows[0], true)
  }
  return {
    status: 405,
    body: errorBody('PGRST117', `Unsupported HTTP method: ${method}`),
    code: 'PGRST117',
  }
}

interface Candidate {
  readonly names: string[] | null
  readonly types: string[]
  readonly required: number
}

async function onRpc(tx: Transaction, req: Request, fn: string): Promise<Answer> {
  const parsed = parseJson(await req.text())
  if (!parsed.ok || !isObject(parsed.value)) return invalidJson
  const args = parsed.value
  const keys = Object.keys(args)
  // PostgREST's schema cache: the functions of the exposed schema, by name and argument names.
  const found = await tx.query<Candidate>(
    `SELECT p.proargnames AS names,
            ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, i) ORDER BY i) AS types,
            (p.pronargs - p.pronargdefaults)::int AS required
       FROM pg_catalog.pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [fn],
  )
  const match = found.rows.find((c) => {
    const names = c.names ?? []
    return (
      keys.every((k) => names.includes(k)) &&
      names.slice(0, c.required).every((n) => keys.includes(n))
    )
  })
  if (match === undefined) {
    const sorted = [...keys].sort()
    return {
      status: 404,
      body: errorBody(
        'PGRST202',
        `Could not find the function public.${fn}(${sorted.join(', ')}) in the schema cache`,
        `Searched for the function public.${fn} with parameters ${sorted.join(', ')} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
      ),
      code: 'PGRST202',
    }
  }
  const names = match.names ?? []
  const typed = keys.map((k) => `${ident(k)} ${match.types[names.indexOf(k)] ?? 'text'}`)
  const call = `public.${ident(fn)}(${keys.map((k) => `${ident(k)} => pgrst_args.${ident(k)}`).join(', ')})`
  const res = await tx.query<{ body: string | null }>(
    `SELECT to_json(${call})::text AS body FROM json_to_record($1::json) AS pgrst_args(${typed.join(', ')})`,
    [JSON.stringify(args)],
  )
  return { status: 200, body: res.rows[0]?.body ?? 'null', code: null }
}

function kindOf(method: string, url: URL, req: Request): RestKind {
  if (url.pathname.startsWith(RPC_PATH)) return 'rpc'
  if (url.pathname !== TABLE_PATH) return 'other'
  if (method === 'GET') return url.searchParams.get('select') === 'updated_at' ? 'head' : 'pull'
  if (method === 'PATCH') return 'update'
  if (method === 'POST') {
    return (req.headers.get('prefer') ?? '').includes('resolution=merge-duplicates')
      ? 'upsert'
      : 'insert'
  }
  return 'other'
}

export function pgRest(relay: PgRelay, opts: RestOptions = {}): PgRest {
  const role = opts.role ?? 'anon'
  let timeZone = opts.timeZone ?? 'UTC'
  let offline = false
  const log: RestRecord[] = []

  const answer = async (req: Request, url: URL, method: string): Promise<Answer> => {
    if ((req.headers.get('apikey') ?? '') === '') {
      return {
        status: 401,
        body: errorBody('PGRST301', 'No API key found in request'),
        code: 'PGRST301',
      }
    }
    try {
      return await relay.db.transaction(async (tx) => {
        await tx.query(`SELECT set_config('role', $1, true), set_config('TimeZone', $2, true)`, [
          role,
          timeZone,
        ])
        if (url.pathname === TABLE_PATH) return onTable(tx, req, url, method)
        if (url.pathname.startsWith(RPC_PATH) && method === 'POST') {
          return onRpc(tx, req, url.pathname.slice(RPC_PATH.length))
        }
        return {
          status: 404,
          body: errorBody('PGRST125', `Invalid path specified in request URL: ${url.pathname}`),
          code: 'PGRST125',
        }
      })
    } catch (err) {
      if (err instanceof Refusal) return err.answer
      const failure = pgFailure(err)
      if (failure === null) throw err
      return {
        status: statusOf(failure.code, role),
        body: errorBody(failure.code, failure.message, failure.detail ?? null),
        code: failure.code,
      }
    }
  }

  return {
    log,
    setTimeZone(tz) {
      timeZone = tz
    },
    setOffline(on) {
      offline = on
    },
    async fetch(input, init) {
      if (offline) throw new TypeError('fetch failed')
      const req = new Request(input, init)
      const url = new URL(req.url)
      const method = req.method.toUpperCase()
      const kind = kindOf(method, url, req)
      const res = await answer(req, url, method)
      log.push({
        method,
        path: url.pathname,
        kind,
        fn: kind === 'rpc' ? url.pathname.slice(RPC_PATH.length) : null,
        status: res.status,
        code: res.code,
      })
      return new Response(res.body, {
        status: res.status,
        headers: res.body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
      })
    },
  }
}
