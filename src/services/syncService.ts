// Cross-device sync transport: the relay row (pull, upsert, realtime) and nothing else.
// - Local-first: the device's own storage is the source of truth, Supabase is a stateless relay.
// - What a payload means, how it merges and whether to push it is the sync engine's business
//   (src/stores/syncEngine.ts, on the v5 core codec): this module never reads a payload.
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
const REALTIME_RECONNECT_DELAY = 2000
const REQUEST_TIMEOUT_MS = 15_000
// Channel states that mean the realtime subscription dropped and must be re-armed.
// Typed against the SDK enum's values so the check stays type-only (no eager SDK import).
const RECONNECT_STATES: ReadonlySet<`${REALTIME_SUBSCRIBE_STATES}`> = new Set([
  'CLOSED',
  'CHANNEL_ERROR',
  'TIMED_OUT',
])
const JOINED_STATES: ReadonlySet<`${REALTIME_SUBSCRIBE_STATES}`> = new Set(['SUBSCRIBED'])

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`Sync payload is ${(bytes / 1024).toFixed(0)} KB — too large to safely sync.`)
    this.name = 'PayloadTooLargeError'
  }
}

export type TransportErrorKind = 'network' | 'server' | 'permission'

export class SyncTransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'SyncTransportError'
  }
}

// ---------------------------------------------------------------------------
// Lazy-loaded Supabase client
// ---------------------------------------------------------------------------

let clientPromise: Promise<SupabaseClient | null> | null = null

function getClient(): Promise<SupabaseClient | null> {
  const url = SUPABASE_URL
  const key = SUPABASE_ANON_KEY
  if (!url || !key) return Promise.resolve(null)
  if (clientPromise) return clientPromise
  const loading = import('@supabase/supabase-js').then((m) =>
    m.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 2 } },
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
// Remote operations
// ---------------------------------------------------------------------------

interface PostgrestFailure {
  message: string
  code?: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function transportError(error: PostgrestFailure, status: number): SyncTransportError {
  if (status === 0) return new SyncTransportError('network', error.message)
  if (status === 401 || status === 403 || error.code === '42501') {
    return new SyncTransportError('permission', error.message)
  }
  return new SyncTransportError('server', error.message || `HTTP ${status}`)
}

/**
 * Runs one request with a 15 s deadline. The signal aborts the fetch, and the racing timer
 * settles the call even if the request ignores the abort, so a hung request can never wedge
 * the single-flight sync loop.
 */
async function withDeadline<T>(request: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SyncTransportError('network', 'The sync server did not answer in time.'))
    }, REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([request(controller.signal), deadline])
  } catch (err) {
    if (err instanceof SyncTransportError) throw err
    throw new SyncTransportError('network', errorText(err))
  } finally {
    clearTimeout(timer)
  }
}

/** Uploads the payload. Resolves with the `updated_at` sent (the realtime echo carries it). */
export async function pushSync(syncId: string, payload: unknown): Promise<{ updatedAt: string }> {
  // Pre-flight payload size check — Supabase free tier caps rows at ~1 MB.
  const serialized = JSON.stringify(payload)
  if (serialized.length > PAYLOAD_WARN_BYTES) {
    if (import.meta.env.DEV) {
      console.warn(
        `[sync] payload is ${(serialized.length / 1024).toFixed(0)} KB — approaching row limit`,
      )
    }
    if (serialized.length > PAYLOAD_MAX_CHARS) throw new PayloadTooLargeError(serialized.length)
  }

  const client = await connect()
  const updatedAt = new Date().toISOString()
  // `.retry(false)`: the engine's classified backoff is the only retry policy.
  const { error, status } = await withDeadline((signal) =>
    client
      .from(TABLE)
      .upsert({ sync_id: syncId, payload, updated_at: updatedAt })
      .retry(false)
      .abortSignal(signal),
  )
  if (error) throw transportError(error, status)
  return { updatedAt }
}

/** The relay payload, or null when the row does not exist. */
export async function pullSync(syncId: string): Promise<unknown> {
  const client = await connect()
  // postgrest-js retries a failed GET up to 3 times (1 s, 2 s, 4 s) by default, which would
  // turn one attempt into four requests and ~7 s before the engine's own backoff sees it.
  const { data, error, status } = await withDeadline((signal) =>
    client
      .from(TABLE)
      .select('payload')
      .eq('sync_id', syncId)
      .retry(false)
      .abortSignal(signal)
      .maybeSingle(),
  )
  if (error) throw transportError(error, status)
  const row: unknown = data
  return isRecord(row) ? row.payload : null
}

export interface RemoteChange {
  payload: unknown
  updatedAt: string | null
}

export interface SyncHandlers {
  onRemoteChange: (change: RemoteChange) => void
  onSubscribed: () => void
}

function changeOf(event: unknown): RemoteChange {
  const next = isRecord(event) && isRecord(event.new) ? event.new : {}
  return {
    payload: next.payload,
    updatedAt: typeof next.updated_at === 'string' ? next.updated_at : null,
  }
}

/**
 * Subscribe to remote changes. Auto-reconnects if the channel drops, and reports every
 * SUBSCRIBED so the caller can catch up on events missed while disconnected.
 * Returns a Promise<unsub> because the SDK is lazy-loaded.
 */
export async function subscribeSync(syncId: string, handlers: SyncHandlers): Promise<() => void> {
  const client = await connect()

  let active = true
  let channel: RealtimeChannel | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const open = () => {
    if (!active) return
    const current = client.channel(`sync:${syncId}`)
    channel = current
    current
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLE, filter: `sync_id=eq.${syncId}` },
        (event) => {
          if (active && current === channel) handlers.onRemoteChange(changeOf(event))
        },
      )
      .subscribe((status) => {
        // Removing a replaced channel fires CLOSED on it — ignore statuses from
        // any channel that is no longer the live one, or we would tear down its successor.
        if (!active || current !== channel) return
        if (JOINED_STATES.has(status)) {
          handlers.onSubscribed()
          return
        }
        // Realtime sometimes drops silently on flaky networks — re-arm if so.
        if (RECONNECT_STATES.has(status)) {
          if (reconnectTimer) clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => {
            if (!active || current !== channel) return
            channel = null
            // removeChannel resolves with a status string ('ok' | 'timed out' | 'error'); it does not reject.
            void client.removeChannel(current)
            open()
          }, REALTIME_RECONNECT_DELAY)
        }
      })
  }

  open()

  return () => {
    active = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (channel) void client.removeChannel(channel)
    channel = null
  }
}
