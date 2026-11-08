// Cross-device sync transport: the relay row and realtime, nothing else (PR-3 track spec §3.2,
// §3.3; DATA-ENGINE-SPEC §11.1, §11.2).
// - Local-first: the device's own storage is the source of truth, Supabase is a stateless relay.
// - What a payload means, how it merges and whether to push it is the sync engine's business
//   (src/stores/syncEngine.ts, on the v5 core codec): this module never reads a payload.
// - Two ways to the row: the table (today's grants) and, after migration 004, the relay's sync
//   functions. Both are off by default behind build flags (P3-2): without them every push is the
//   plain upsert 0.10.0 sends, plus the stored `updated_at` it now asks back (the etag).
// - Every request has a 15 s deadline and no SDK retry, so the engine's classified backoff is
//   the only retry policy and a hung request can never wedge the single-flight loop.
// - Only the lazy sync engine imports this module, and the Supabase JS SDK is loaded lazily
//   again from here, so users who never sync pay for neither.

import type {
  REALTIME_SUBSCRIBE_STATES,
  RealtimeChannel,
  SupabaseClient,
} from '@supabase/supabase-js'
import { isRecord } from '../lib/backup'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './syncConfig'

const TABLE = 'sync_buckets'
const PAYLOAD_WARN_BYTES = 800 * 1024 // 800 KB — below Supabase free-tier 1 MB row limit
// The last line of defence: the engine pauses at its own, lower push limit before sending.
const PAYLOAD_MAX_CHARS = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
/** Browsers cap the bodies of keepalive requests in flight at 64 KiB (bytes, not characters). */
const KEEPALIVE_MAX_BYTES = 60_000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60_000
/** Two failed joins in a row with row events armed: the project refuses them (diagnostic). */
const ROW_EVENT_FAILURES = 2
const PLAIN_TOPIC_LABEL = 'spendtrack/topic/v1|'
const TOPIC_PREFIX = 'st:'
const BROADCAST_EVENT = 'rev'
// Channel states that mean the realtime subscription dropped and must be re-armed.
// Typed against the SDK enum's values so the check stays type-only (no eager SDK import).
const RECONNECT_STATES: ReadonlySet<`${REALTIME_SUBSCRIBE_STATES}`> = new Set([
  'CLOSED',
  'CHANNEL_ERROR',
  'TIMED_OUT',
])
const JOINED_STATES: ReadonlySet<`${REALTIME_SUBSCRIBE_STATES}`> = new Set(['SUBSCRIBED'])
const ERROR_STATES: ReadonlySet<`${REALTIME_SUBSCRIBE_STATES}`> = new Set(['CHANNEL_ERROR'])
const CHANNEL = { config: { broadcast: { self: false, ack: false } } }

// ---------------------------------------------------------------------------
// Build flags (P3-2): read here only, so they cost nothing outside the lazy chunk
// ---------------------------------------------------------------------------

// Compared in place (never copied into a variable first), so a build without the flags folds
// them to constants and drops the compare-and-set and RPC code it can never run.
/** Compare-and-set table writes (after the §18.1 check). Off: the plain upsert 0.10.0 sends. */
export const CAS_ON: boolean = import.meta.env.VITE_SYNC_CAS === 'on'
/** How to reach the row: the table only (default), detected, or the sync functions only. */
export const RELAY_PIN: 'table' | 'auto' | 'rpc' =
  import.meta.env.VITE_SYNC_RELAY === 'auto'
    ? 'auto'
    : import.meta.env.VITE_SYNC_RELAY === 'rpc'
      ? 'rpc'
      : 'table'

export type RelayMode = 'table' | 'rpc'

export class PayloadTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Sync payload is ${(bytes / 1024).toFixed(0)} KB — too large to safely sync.`)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * `no-rpc`: the sync functions are not there (PGRST202, or 404 from an RPC); `full`: the relay
 * refused to create another row (53400); `invalid`: the server refused the payload (22023 from
 * the functions, 23514 from 004's checks on a table write). The engine pauses an `invalid` as
 * too large when the payload's size explains it, and retries any other with backoff.
 */
export type TransportErrorKind = 'network' | 'server' | 'permission' | 'invalid' | 'no-rpc' | 'full'

export class SyncTransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly code: string | null = null,
    readonly status = 0,
  ) {
    super(message)
    this.name = 'SyncTransportError'
  }
}

// ---------------------------------------------------------------------------
// The etag (P3-3)
// ---------------------------------------------------------------------------

const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/** An ISO time stamp as integer microseconds since the epoch (no zone = UTC), or null. */
function micros(text: string): number | null {
  const m = STAMP.exec(text)
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

/** When the relay took the write an etag names, in epoch ms (null when unreadable). */
export function etagTime(etag: string): number | null {
  const t = micros(etag)
  return t === null ? null : Math.floor(t / 1000)
}

/**
 * The same relay state: both etags name one instant (PostgREST prints `+00:00` and trims zeros;
 * a token is sent with `Z` and 6 digits). Unreadable text compares as text; no etag is never one.
 */
export function sameEtag(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  const x = micros(a)
  const y = micros(b)
  return x === null || y === null ? a === b : x === y
}

/**
 * The `updated_at` a table write sends: strictly after `base` at microsecond precision (so a
 * compare-and-set token always moves forward, whatever this device's clock says), with three
 * random microsecond digits so two writers in one millisecond never send the same token.
 */
export function tok(base: string | null, now: number, rand: () => number): string {
  const floor = base === null ? null : micros(base)
  const t = Math.max(now * 1000 + Math.floor(rand() * 1000), floor === null ? 0 : floor + 1)
  const ms = Math.floor(t / 1000)
  return `${new Date(ms).toISOString().slice(0, 23)}${String(t - ms * 1000).padStart(3, '0')}Z`
}

// ---------------------------------------------------------------------------
// Lazy-loaded Supabase client
// ---------------------------------------------------------------------------

let clientPromise: Promise<SupabaseClient | null> | null = null
/** Set while a push asked for keepalive (a hide push): only it may outlive the page. */
let keepaliveWanted = false

/**
 * The SDK's fetch: a push the page is going away for, small enough for the browser's keepalive
 * quota, is sent with `keepalive` so it completes after the page is frozen or closed. The quota
 * counts UTF-8 bytes: a note in CJK or emoji takes 3 or 4 of them per character, and a body over
 * it would be refused outright, where a plain request may still get through.
 */
export function relayFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = init?.body
  const keep =
    keepaliveWanted &&
    typeof body === 'string' &&
    body.length <= KEEPALIVE_MAX_BYTES &&
    new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES
  return globalThis.fetch(input, keep ? { ...init, keepalive: true } : init)
}

function getClient(): Promise<SupabaseClient | null> {
  const url = SUPABASE_URL
  const key = SUPABASE_ANON_KEY
  if (!url || !key) return Promise.resolve(null)
  if (clientPromise) return clientPromise
  const loading = import('@supabase/supabase-js').then((m) =>
    m.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 2 } },
      global: { fetch: relayFetch },
    }),
  )
  clientPromise = loading
  // A failed chunk load (offline on first use) must not be cached forever.
  loading.catch(() => {
    if (clientPromise === loading) clientPromise = null
  })
  return loading
}

/**
 * The SDK client, within the request deadline. A chunk download that stalls (first visit
 * before the service worker caches it, a captive portal) fails as a network error instead of
 * wedging the sync loop, and is not reused: the next attempt loads again.
 */
async function connect(): Promise<SupabaseClient> {
  const loading = getClient()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (clientPromise === loading) clientPromise = null
      reject(new SyncTransportError('network', 'The sync client did not load in time.'))
    }, REQUEST_TIMEOUT_MS)
  })
  let client: SupabaseClient | null
  try {
    client = await Promise.race([loading, stalled])
  } catch (err) {
    if (err instanceof SyncTransportError) throw err
    throw new SyncTransportError('network', `Could not load the sync client: ${errorText(err)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!client) throw new SyncTransportError('server', 'Sync is not configured in this build.')
  return client
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface PostgrestFailure {
  message: string
  code?: string
}

interface Answer {
  readonly data: unknown
  readonly error: PostgrestFailure | null
  readonly status: number
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One class per failure, so the engine knows whether to retry, re-probe or pause. */
function transportError(error: PostgrestFailure, status: number, rpc: boolean): SyncTransportError {
  const code = error.code ?? ''
  const kind: TransportErrorKind =
    status === 0
      ? 'network'
      : status === 401 || status === 403 || code === '42501'
        ? 'permission'
        : code === 'PGRST202' || (rpc && status === 404)
          ? 'no-rpc'
          : code === '53400'
            ? 'full'
            : code === '22023' || code === '23514'
              ? 'invalid'
              : 'server'
  return new SyncTransportError(
    kind,
    error.message || `HTTP ${String(status)}`,
    code || null,
    status,
  )
}

/**
 * Runs one request with a 15 s deadline. The signal aborts the fetch, and the racing timer
 * settles the call even if the request ignores the abort, so a hung request can never wedge
 * the single-flight sync loop. A failure becomes a classified SyncTransportError.
 */
async function call(
  rpc: boolean,
  request: (client: SupabaseClient, signal: AbortSignal) => PromiseLike<Answer>,
): Promise<unknown> {
  const client = await connect()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SyncTransportError('network', 'The sync server did not answer in time.'))
    }, REQUEST_TIMEOUT_MS)
  })
  let answer: Answer
  try {
    answer = await Promise.race([request(client, controller.signal), deadline])
  } catch (err) {
    if (err instanceof SyncTransportError) throw err
    throw new SyncTransportError('network', errorText(err))
  } finally {
    clearTimeout(timer)
  }
  if (answer.error) throw transportError(answer.error, answer.status, rpc)
  return answer.data
}

/** The `updated_at` of a write's returned row(s), or null when it touched none. */
function returnedStamp(data: unknown): string | null {
  const row: unknown = Array.isArray(data) ? data[0] : data
  return isRecord(row) && typeof row.updated_at === 'string' ? row.updated_at : null
}

/** The pre-flight size check: a payload this large never leaves the device. */
function sized(payload: unknown): void {
  const chars = JSON.stringify(payload).length
  if (chars <= PAYLOAD_WARN_BYTES) return
  if (import.meta.env.DEV) {
    console.warn(`[sync] payload is ${(chars / 1024).toFixed(0)} KB — approaching row limit`)
  }
  if (chars > PAYLOAD_MAX_CHARS) throw new PayloadTooLargeError(chars)
}

export interface Pulled {
  readonly payload: unknown
  /** The row's `updated_at` exactly as the relay returned it. */
  readonly etag: string
}

export type PushOutcome =
  | { readonly ok: true; readonly etag: string }
  | { readonly ok: false; readonly reason: 'conflict' | 'missing' }

export interface PushOptions {
  /** The etag the payload was merged from (null: the row was missing). */
  readonly base: string | null
  /** Write over whatever is there now (never creates). */
  readonly force: boolean
  /** The page is going away: the request should outlive it. */
  readonly keepalive: boolean
}

export interface Transport {
  readonly mode: RelayMode
  /** The row's etag; null = no row. */
  head(row: string): Promise<string | null>
  pull(row: string): Promise<Pulled | null>
  push(row: string, payload: unknown, opts: PushOptions): Promise<PushOutcome>
}

const CONFLICT: PushOutcome = { ok: false, reason: 'conflict' }
const MISSING: PushOutcome = { ok: false, reason: 'missing' }

async function withKeepalive<T>(keepalive: boolean, run: () => Promise<T>): Promise<T> {
  keepaliveWanted = keepalive
  try {
    return await run()
  } finally {
    keepaliveWanted = false
  }
}

const table: Transport = {
  mode: 'table',
  async head(row) {
    const data = await call(false, (c, signal) =>
      c
        .from(TABLE)
        .select('updated_at')
        .eq('sync_id', row)
        .retry(false)
        .abortSignal(signal)
        .maybeSingle(),
    )
    return returnedStamp(data)
  },
  async pull(row) {
    // postgrest-js retries a failed GET up to 3 times (1 s, 2 s, 4 s) by default, which would
    // turn one attempt into four requests and ~7 s before the engine's own backoff sees it.
    const data = await call(false, (c, signal) =>
      c
        .from(TABLE)
        .select('payload,updated_at')
        .eq('sync_id', row)
        .retry(false)
        .abortSignal(signal)
        .maybeSingle(),
    )
    if (!isRecord(data)) return null
    return {
      payload: data.payload,
      etag: typeof data.updated_at === 'string' ? data.updated_at : '',
    }
  },
  async push(row, payload, opts) {
    sized(payload)
    // The flag is read in place: a build without VITE_SYNC_CAS keeps only the upsert.
    if (import.meta.env.VITE_SYNC_CAS === 'on') {
      return withKeepalive(opts.keepalive, () => casPush(row, payload, opts))
    }
    return withKeepalive(opts.keepalive, () => upsertPush(row, payload, opts.base))
  },
}

/** The plain upsert 0.10.0 sends (never conflicts), now asking back the stored `updated_at`. */
async function upsertPush(
  row: string,
  payload: unknown,
  base: string | null,
): Promise<PushOutcome> {
  const updated_at = tok(base, Date.now(), Math.random)
  const data = await call(false, (c, signal) =>
    c
      .from(TABLE)
      .upsert({ sync_id: row, payload, updated_at })
      .select('updated_at')
      .retry(false)
      .abortSignal(signal),
  )
  return { ok: true, etag: returnedStamp(data) ?? updated_at }
}

/**
 * Compare-and-set over the table: create-only when the row was missing (another device creating
 * it first is a conflict, 23505), else an update matching the pulled `updated_at` (no row
 * matched: a conflict), or forced over whatever is there (never creates: no row is `missing`).
 */
async function casPush(row: string, payload: unknown, opts: PushOptions): Promise<PushOutcome> {
  const { base, force } = opts
  const updated_at = tok(force ? null : base, Date.now(), Math.random)
  if (base === null && !force) {
    try {
      const data = await call(false, (c, signal) =>
        c
          .from(TABLE)
          .insert({ sync_id: row, payload, updated_at })
          .select('updated_at')
          .retry(false)
          .abortSignal(signal)
          .single(),
      )
      return { ok: true, etag: returnedStamp(data) ?? updated_at }
    } catch (err) {
      if (err instanceof SyncTransportError && (err.code === '23505' || err.status === 409)) {
        return CONFLICT
      }
      throw err
    }
  }
  const data = await call(false, (c, signal) => {
    const match = c.from(TABLE).update({ payload, updated_at }).eq('sync_id', row)
    const cas = force || base === null ? match : match.eq('updated_at', base)
    return cas.select('updated_at').retry(false).abortSignal(signal)
  })
  const etag = returnedStamp(data)
  return etag === null ? (force ? MISSING : CONFLICT) : { ok: true, etag }
}

const rpc: Transport = {
  mode: 'rpc',
  async head(row) {
    const data = await call(true, (c, signal) =>
      c.rpc('st_sync_head', { p_row: row }).retry(false).abortSignal(signal),
    )
    return typeof data === 'string' ? data : null
  },
  async pull(row) {
    const data = await call(true, (c, signal) =>
      c.rpc('st_sync_pull', { p_row: row }).retry(false).abortSignal(signal),
    )
    if (!isRecord(data)) return null
    return {
      payload: data.payload,
      etag: typeof data.updated_at === 'string' ? data.updated_at : '',
    }
  },
  async push(row, payload, { base, force, keepalive }) {
    sized(payload)
    return withKeepalive(keepalive, async () => {
      const data = await call(true, (c, signal) =>
        c
          .rpc('st_sync_push', { p_row: row, p_payload: payload, p_base: base, p_force: force })
          .retry(false)
          .abortSignal(signal),
      )
      if (isRecord(data) && data.ok === true && typeof data.updated_at === 'string') {
        return { ok: true, etag: data.updated_at }
      }
      return isRecord(data) && data.reason === 'missing' ? MISSING : CONFLICT
    })
  },
}

/** Which way to the row the engine last found, and when it looked (pin 'auto' only). */
export interface ModeHint {
  readonly mode: RelayMode | null
  readonly probedAt: number
}

const TABLE_HINT_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * The transport for this cycle. With pin 'auto' it asks the relay (`st_sync_head`) when there is
 * no hint, the table hint is a day old, or the engine asks again (a refusal, a missing function):
 * the functions answer → RPC; PGRST202 → table; a failure that says nothing keeps the hint (or
 * table) and its time, so the next cycle asks again.
 */
export async function openTransport(
  row: string,
  hint: ModeHint,
  now: number,
  reprobe: boolean,
): Promise<{ readonly transport: Transport; readonly hint: ModeHint }> {
  await connect() // the SDK, within its deadline, before anything is decided
  if (RELAY_PIN !== 'auto') return { transport: RELAY_PIN === 'rpc' ? rpc : table, hint }
  const due =
    hint.mode === null ||
    reprobe ||
    (hint.mode === 'table' && now - hint.probedAt >= TABLE_HINT_MAX_AGE_MS)
  if (!due) return { transport: hint.mode === 'rpc' ? rpc : table, hint }
  try {
    await rpc.head(row)
    return { transport: rpc, hint: { mode: 'rpc', probedAt: now } }
  } catch (err) {
    if (err instanceof SyncTransportError && err.kind === 'no-rpc') {
      return { transport: table, hint: { mode: 'table', probedAt: now } }
    }
    return { transport: hint.mode === 'rpc' ? rpc : table, hint }
  }
}

// ---------------------------------------------------------------------------
// Realtime (P3-12)
// ---------------------------------------------------------------------------

/**
 * The realtime topic of a plaintext row: `st:` + 32 hex of SHA-256 over a fixed label and the
 * code (DATA-ENGINE-SPEC §11.2; the same value as the core's `plainTopic`, computed here so the
 * hashing ships in the lazy sync chunk). The raw code is never a topic name.
 */
export async function topicOf(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(PLAIN_TOPIC_LABEL + code)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  let hex = ''
  for (const b of digest.subarray(0, 16)) hex += b.toString(16).padStart(2, '0')
  return TOPIC_PREFIX + hex
}

export interface RemoteChange {
  readonly payload: unknown
  readonly updatedAt: string | null
}

export interface RealtimeHandlers {
  onRowChange(change: RemoteChange): void
  onBroadcast(msg: { readonly rev: string; readonly dev: string }): void
  /** `failed`: row events were refused twice in a row; this subscription has stopped. */
  onStatus(status: 'joined' | 'dropped' | 'failed'): void
}

export interface RealtimeOptions {
  readonly topic: string
  readonly row: string
  /** Arm postgres_changes on the row (the only way to hear 0.8.4, 0.9.2 and 0.10.0 writers). */
  readonly rowEvents: boolean
}

function changeOf(event: unknown): RemoteChange {
  const next = isRecord(event) && isRecord(event.new) ? event.new : {}
  return {
    payload: next.payload,
    updatedAt: typeof next.updated_at === 'string' ? next.updated_at : null,
  }
}

/** The joined channel of each topic this device subscribes to: `announce` sends over it. */
const joined = new Map<string, RealtimeChannel>()
/**
 * Every channel a subscription opened and has not removed. The SDK hands out one channel per
 * topic, so `announce` may be given a subscription's channel (joining, or reconnecting): it
 * sends over it, and never removes it.
 */
const subscribed = new Set<RealtimeChannel>()

/**
 * Subscribe to the row's topic. Re-subscribes with backoff when the channel drops, and reports
 * every join so the engine can catch up on events missed meanwhile. Returns a Promise<unsub>
 * because the SDK is lazy-loaded.
 */
export async function subscribeSync(
  opts: RealtimeOptions,
  h: RealtimeHandlers,
): Promise<() => void> {
  const client = await connect()

  let active = true
  let channel: RealtimeChannel | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let drops = 0
  let rowErrors = 0

  const forget = (ch: RealtimeChannel) => {
    if (joined.get(opts.topic) === ch) joined.delete(opts.topic)
  }

  const remove = (ch: RealtimeChannel) => {
    forget(ch)
    subscribed.delete(ch)
    // removeChannel resolves with a status string ('ok' | 'timed out' | 'error'); it does not reject.
    void client.removeChannel(ch)
  }

  const open = () => {
    if (!active) return
    const current = client.channel(opts.topic, CHANNEL)
    subscribed.add(current)
    channel = current
    const live = () => active && current === channel
    current.on('broadcast', { event: BROADCAST_EVENT }, (msg) => {
      const p: unknown = isRecord(msg) ? msg.payload : null
      if (live() && isRecord(p) && typeof p.rev === 'string' && typeof p.dev === 'string') {
        h.onBroadcast({ rev: p.rev, dev: p.dev })
      }
    })
    if (opts.rowEvents) {
      current.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLE, filter: `sync_id=eq.${opts.row}` },
        (event) => {
          if (live()) h.onRowChange(changeOf(event))
        },
      )
    }
    current.subscribe((status) => {
      // Removing a replaced channel fires CLOSED on it — ignore statuses from
      // any channel that is no longer the live one, or we would tear down its successor.
      if (!live()) return
      if (JOINED_STATES.has(status)) {
        drops = 0
        rowErrors = 0
        joined.set(opts.topic, current)
        h.onStatus('joined')
        return
      }
      if (!RECONNECT_STATES.has(status)) return
      forget(current)
      rowErrors = ERROR_STATES.has(status) ? rowErrors + 1 : 0
      if (opts.rowEvents && rowErrors >= ROW_EVENT_FAILURES) {
        // The project refuses the row events (no publication, a lockdown): stop here, and let
        // the engine subscribe again with Broadcast alone.
        active = false
        channel = null
        remove(current)
        h.onStatus('failed')
        return
      }
      h.onStatus('dropped')
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** drops)
      drops++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (!live()) return
        channel = null
        remove(current)
        open()
      }, delay)
    })
  }

  open()

  return () => {
    active = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (channel) remove(channel)
    channel = null
  }
}

/**
 * Tells the other v5 devices on the topic that a push landed: over the joined channel, else by
 * REST (never `send()`'s deprecated REST fallback), on the subscription's channel while it is
 * joining or on one opened just for this. The SDK hands out one channel per topic, so a
 * subscription that opens meanwhile shares that channel: it is removed only while no
 * subscription uses it. Best effort: the row event and polling still carry the news when it is
 * lost. Never throws.
 */
export function announce(topic: string, msg: { readonly rev: string; readonly dev: string }): void {
  const live = joined.get(topic)
  if (live !== undefined) {
    void live
      .send({ type: 'broadcast', event: BROADCAST_EVENT, payload: msg })
      .catch(() => undefined)
    return
  }
  void (async () => {
    const client = await connect()
    const ch = client.channel(topic, CHANNEL)
    try {
      await ch.httpSend(BROADCAST_EVENT, msg)
    } finally {
      if (!subscribed.has(ch)) void client.removeChannel(ch)
    }
  })().catch(() => undefined)
}
