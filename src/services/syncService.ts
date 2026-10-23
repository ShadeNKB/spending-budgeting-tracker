// Cross-device sync layer (v4 wire).
// - Local-first: localStorage is the source of truth, Supabase is a stateless relay.
// - Per-expense last-writer-wins by `updatedAt ?? createdAt`, ties broken by content, so
//   every device resolves a merge the same way whatever the order (no ping-pong).
// - Tombstones (`deletedIds`) are unioned across devices and always win.
// - Budgets: per-key last-writer-wins via `budgetUpdatedAt` / `budgetDeletedAt`.
// - Pulled payloads are read leniently: unreadable rows are kept on the relay, never merged.
// - Only the lazy sync engine imports this module, and the Supabase JS SDK is loaded lazily
//   again from here, so users who never sync pay for neither.

import type {
  REALTIME_SUBSCRIBE_STATES,
  RealtimeChannel,
  SupabaseClient,
} from '@supabase/supabase-js'
import { isValid, parseISO } from 'date-fns'
import type { BackupData, Expense } from '../types'
import { DEFAULT_CATEGORIES } from '../constants'
import { isNumber, isRecord, isString, listOf, recordOf } from '../lib/backup'
import { canon, canonRow } from '../lib/canon'
import { LEGACY_STAMP_ISO, stampMs } from '../lib/stamps'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './syncConfig'

const TABLE = 'sync_buckets'
const PAYLOAD_WARN_BYTES = 800 * 1024 // 800 KB — below Supabase free-tier 1 MB row limit
const PAYLOAD_MAX_CHARS = 1024 * 1024
// Tombstones are ~22 B each; a high cap only exists to bound a pathological payload.
const TOMBSTONE_CAP = 20_000
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

/** Who last wrote the relay row: a v5 client (`x5`), v0.8.5 (`wr`), or v0.8.4 and older. */
export type WriterClass = 'v5' | 'v085' | 'legacy'

export interface WriterStamp {
  app: string
  dev: string
  /** This push. */
  rev: string
  at: string
  /**
   * The lineage: the rev of the relay copy this push was built on, then that copy's lineage,
   * newest first, without the writer's own earlier revs. A client that finds one of its pushes
   * here knows this writer had seen it.
   */
  seen: readonly string[]
}

/** How many revs `wr.seen` names at most. */
export const SEEN_MAX = 16
// A rev is 22 characters; anything far longer is not one of ours.
const REV_MAX_LENGTH = 64

/** What a v0.8.5 push sends: the v4 payload plus `wr`. Rows we could not read ride along as-is. */
export type SyncPayload = Omit<BackupData, 'expenses'> & {
  expenses: readonly unknown[]
  wr: WriterStamp
}

export type RemoteRead =
  | { kind: 'empty' }
  | { kind: 'moved' }
  | { kind: 'update-required' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'ok'
      data: BackupData
      passthrough: unknown[]
      writer: WriterClass
      key: string
      /** A v0.8.5 copy's `wr.rev` and `wr.seen` (null and empty for other writers). */
      rev: string | null
      seen: readonly string[]
    }

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
// Reading pulled payloads (lenient, with pass-through)
// ---------------------------------------------------------------------------

const optionalText = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'string'

/**
 * A row v0.8 can merge and render: string id, name and category, a finite amount above zero
 * (what add and import accept) and a parseable date. Unknown extra fields (v5 `day`, `fs`, `h`,
 * …) are allowed and kept.
 */
export function isSyncableExpense(row: unknown): row is Expense {
  if (!isRecord(row)) return false
  const { id, itemName, amount, date, category } = row
  return (
    typeof id === 'string' &&
    id !== '' &&
    typeof itemName === 'string' &&
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    typeof date === 'string' &&
    isValid(parseISO(date)) &&
    typeof category === 'string' &&
    optionalText(row.notes) &&
    (row.createdAt === undefined || typeof row.createdAt === 'string') &&
    (row.updatedAt === undefined || typeof row.updatedAt === 'string')
  )
}

function writerOf(raw: Record<string, unknown>): WriterClass {
  if (isRecord(raw.x5)) return 'v5'
  if (isRecord(raw.wr)) return 'v085'
  return 'legacy'
}

const isRev = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= REV_MAX_LENGTH

/** A v0.8.5 copy's rev and lineage, read leniently (anything else counts as unknown). */
function lineageOf(wr: unknown): { rev: string | null; seen: string[] } {
  if (!isRecord(wr)) return { rev: null, seen: [] }
  const seen: readonly unknown[] = Array.isArray(wr.seen) ? wr.seen : []
  return { rev: isRev(wr.rev) ? wr.rev : null, seen: seen.filter(isRev).slice(0, SEEN_MAX) }
}

/** Classifies and reads a pulled payload. Never throws. */
export function readRemote(raw: unknown): RemoteRead {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'the synced copy is not an object' }
  if (raw.expenses === 'moved') return { kind: 'moved' }
  const x5 = raw.x5
  if (isRecord(x5) && typeof x5.min === 'number' && x5.min > 4) return { kind: 'update-required' }
  const rows = raw.expenses
  if (!Array.isArray(rows))
    return { kind: 'invalid', reason: 'the synced copy has no expense list' }

  const items: readonly unknown[] = rows
  const writer = writerOf(raw)
  const expenses: Expense[] = []
  const passthrough: unknown[] = []
  for (const item of items) {
    if (isSyncableExpense(item)) expenses.push(item)
    else passthrough.push(item)
  }
  return {
    kind: 'ok',
    data: {
      expenses,
      categories: listOf(raw.categories, isString),
      categoryMappings: recordOf(raw.categoryMappings, isString),
      budgets: recordOf(raw.budgets, isNumber),
      budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
      budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
      deletedIds: listOf(raw.deletedIds, isString),
      exportDate: typeof raw.exportDate === 'string' ? raw.exportDate : '',
      version: '4.0',
    },
    passthrough,
    writer,
    key: contentKey(raw),
    ...(writer === 'v085' ? lineageOf(raw.wr) : { rev: null, seen: [] }),
  }
}

// ---------------------------------------------------------------------------
// Content key: equal keys mean "the relay already holds this".
// ---------------------------------------------------------------------------

function sortedList(value: unknown, item: (x: unknown) => string): unknown {
  if (!Array.isArray(value)) return value
  const items: readonly unknown[] = value
  return items.map(item).sort()
}

function sortedSet(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const items: readonly unknown[] = value
  return [...new Set(items.map(canon))].sort()
}

/**
 * Canonical content of a payload. Ignores `exportDate`, `version`, `wr`, `x5`, key order and
 * the order of expenses, categories and tombstones. Non-array collections are kept raw, so a
 * damaged relay copy never equals a clean one (our next push repairs it).
 */
export function contentKey(payload: unknown): string {
  const p = isRecord(payload) ? payload : {}
  return canon({
    expenses: sortedList(p.expenses, canonRow),
    categories: sortedSet(p.categories),
    categoryMappings: p.categoryMappings,
    budgets: p.budgets,
    budgetUpdatedAt: p.budgetUpdatedAt,
    budgetDeletedAt: p.budgetDeletedAt ?? {},
    deletedIds: sortedSet(p.deletedIds),
  })
}

// ---------------------------------------------------------------------------
// Merge (a join: commutative, associative and idempotent by content)
// ---------------------------------------------------------------------------

const ownEntries = <T>(record: Record<string, T> | undefined): [string, T][] =>
  record ? Object.entries(record) : []

const expenseStamp = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

/** The newer copy; on equal stamps the larger canonical JSON (the local copy when identical). */
function pickExpense(l: Expense, r: Expense): Expense {
  const lt = expenseStamp(l)
  const rt = expenseStamp(r)
  if (lt !== rt) return lt > rt ? l : r
  return canonRow(l) >= canonRow(r) ? l : r
}

const larger = (a: string, b: string): string => (a >= b ? a : b)

function mergeMappings(
  local: Record<string, string>,
  remote: Record<string, string>,
): Record<string, string> {
  const out = new Map<string, string>(ownEntries(remote))
  for (const [key, value] of ownEntries(local)) {
    const other = out.get(key)
    out.set(key, other === undefined ? value : larger(value, other))
  }
  return Object.fromEntries(out)
}

interface BudgetSide {
  value: number | undefined
  set: number
  setAt: string | undefined
  del: number
  delAt: string | undefined
}

function budgetSide(
  budgets: Map<string, number>,
  updatedAt: Map<string, string>,
  deletedAt: Map<string, string>,
  key: string,
): BudgetSide {
  const raw = budgets.get(key)
  const value = raw !== undefined && Number.isFinite(raw) ? raw : undefined
  const setAt = updatedAt.get(key)
  const delAt = deletedAt.get(key)
  return {
    value,
    set: value === undefined ? -1 : stampMs(setAt),
    setAt,
    del: delAt === undefined ? -1 : stampMs(delAt),
    delAt,
  }
}

function mergeBudgets(local: BackupData, remote: BackupData) {
  const lb = new Map(ownEntries(local.budgets))
  const rb = new Map(ownEntries(remote.budgets))
  const lu = new Map(ownEntries(local.budgetUpdatedAt))
  const ru = new Map(ownEntries(remote.budgetUpdatedAt))
  const ld = new Map(ownEntries(local.budgetDeletedAt))
  const rd = new Map(ownEntries(remote.budgetDeletedAt))
  const keys = new Set([
    ...lb.keys(),
    ...rb.keys(),
    ...lu.keys(),
    ...ru.keys(),
    ...ld.keys(),
    ...rd.keys(),
  ])

  const budgets: [string, number][] = []
  const updatedAt: [string, string][] = []
  const deletedAt: [string, string][] = []

  for (const key of keys) {
    const l = budgetSide(lb, lu, ld, key)
    const r = budgetSide(rb, ru, rd, key)
    const maxDel = Math.max(l.del, r.del)
    const maxSet = Math.max(l.set, r.set)

    if (maxDel > 0 && maxDel >= maxSet) {
      // Deletion wins: the key is absent from budgets.
      const stamps = [l, r].filter((s) => s.del === maxDel).map((s) => s.delAt ?? '')
      deletedAt.push([key, stamps.reduce(larger)])
      continue
    }
    if (maxSet >= 0) {
      let winner: BudgetSide | null = null
      for (const side of [l, r]) {
        if (side.value === undefined || side.set !== maxSet) continue
        if (
          winner?.value === undefined ||
          side.value > winner.value ||
          (side.value === winner.value && (side.setAt ?? '') > (winner.setAt ?? ''))
        ) {
          winner = side
        }
      }
      if (winner?.value !== undefined) {
        budgets.push([key, winner.value])
        updatedAt.push([
          key,
          maxSet > 0 && winner.setAt !== undefined ? winner.setAt : LEGACY_STAMP_ISO,
        ])
      }
    }
  }

  return {
    budgets: Object.fromEntries(budgets),
    budgetUpdatedAt: Object.fromEntries(updatedAt),
    budgetDeletedAt: Object.fromEntries(deletedAt),
  }
}

export function mergeBackups(local: BackupData, remote: BackupData): BackupData {
  const localMap = new Map<string, Expense>(local.expenses.map((e) => [e.id, e]))
  const remoteMap = new Map<string, Expense>(remote.expenses.map((e) => [e.id, e]))

  // Union tombstones — once an ID is deleted on any device it stays deleted.
  const tombstones = new Set<string>([...(local.deletedIds ?? []), ...(remote.deletedIds ?? [])])

  const merged: Expense[] = []
  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    if (tombstones.has(id)) continue
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (l && r) merged.push(pickExpense(l, r))
    else if (l) merged.push(l)
    else if (r) merged.push(r)
  }

  // Keep the store consistently sorted by date desc.
  const time = new Map(merged.map((e) => [e, new Date(e.date).getTime()]))
  merged.sort((a, b) => (time.get(b) ?? 0) - (time.get(a) ?? 0))

  // Categories: union, deduped, preserving local order first.
  const categories = [...new Set([...local.categories, ...remote.categories])]
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES)

  return {
    expenses: merged,
    categories,
    categoryMappings: mergeMappings(local.categoryMappings, remote.categoryMappings),
    ...mergeBudgets(local, remote),
    deletedIds: [...tombstones].slice(-TOMBSTONE_CAP),
    exportDate: new Date().toISOString(),
    version: '4.0',
  }
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
export async function pushSync(
  syncId: string,
  payload: SyncPayload,
): Promise<{ updatedAt: string }> {
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
