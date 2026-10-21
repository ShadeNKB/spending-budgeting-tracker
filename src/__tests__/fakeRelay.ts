// Fake Supabase transport for the sync suites. It mirrors the parts of
// @supabase/supabase-js that SpendTrack uses:
//   from(t).select(c).eq('sync_id', id)[.retry(b)][.abortSignal(s)].maybeSingle() → {data, error, status}
//   from(t).upsert(row)[.retry(b)][.abortSignal(s)]                               → {data, error, status}
//   channel(n).on('postgres_changes', {filter}, cb).subscribe(statusCb), removeChannel(ch)
// Like postgrest-js 2.106, a GET whose fetch fails (status 0) or answers 503/520 is retried
// up to 3 times after 1, 2 and 4 s unless `.retry(false)` was called; each try is a pull.
// Timing runs on (fake) timers: a write lands half-way through the push latency, the
// response arrives at the full latency, and every subscribed channel (the writer's own
// too, unless self-echo is off) receives the change `latency.realtime` after the write.
// State lives on globalThis, so device module graphs loaded with vi.resetModules() share
// one relay. Works against the v0.8.4 code too (it ignores the event argument).
import { vi } from 'vitest'
import type { Expense } from '../types'

export type Failure =
  | { status: number; code?: string; message?: string }
  | { hang: true }
  | { abortable: true }

export interface RelayResponse {
  data: unknown
  error: { message: string; code: string; details: string; hint: string } | null
  status: number
}

interface ChangeEvent {
  eventType: 'INSERT' | 'UPDATE'
  schema: string
  table: string
  new: Record<string, unknown>
  old: Record<string, unknown>
}

interface RelayRow {
  payload: unknown
  updated_at: string
}

export interface PushRecord {
  client: number
  syncId: string
  payload: unknown
  at: number
}

interface RelayState {
  rows: Map<string, RelayRow>
  channels: Set<FakeChannel>
  created: FakeChannel[]
  removed: FakeChannel[]
  latency: { pull: number; push: number; realtime: number }
  subscribeDelay: number
  selfEcho: boolean
  omitPayload: boolean
  closeSync: boolean
  failures: { pull: Failure[]; push: Failure[] }
  importFailures: number
  /** SDK downloads that never finish (a stalled chunk fetch). */
  importStalls: number
  pulls: number
  upserts: number
  pushes: PushRecord[]
  legacyWrites: number
  nextClient: number
}

declare global {
  var __spendtrackFakeRelay: RelayState | undefined
}

function freshRelay(): RelayState {
  return {
    rows: new Map(),
    channels: new Set(),
    created: [],
    removed: [],
    latency: { pull: 0, push: 0, realtime: 0 },
    subscribeDelay: 10,
    selfEcho: true,
    omitPayload: false,
    closeSync: false,
    failures: { pull: [], push: [] },
    importFailures: 0,
    importStalls: 0,
    pulls: 0,
    upserts: 0,
    pushes: [],
    legacyWrites: 0,
    nextClient: 1,
  }
}

/** The shared relay state. */
export function relay(): RelayState {
  globalThis.__spendtrackFakeRelay ??= freshRelay()
  return globalThis.__spendtrackFakeRelay
}

export function resetRelay(): RelayState {
  globalThis.__spendtrackFakeRelay = freshRelay()
  return globalThis.__spendtrackFakeRelay
}

const clone = (value: unknown): unknown =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown)

const errorResponse = (status: number, message: string, code = ''): RelayResponse => ({
  data: null,
  error: { message, code, details: '', hint: '' },
  status,
})

/** The row as it is on the relay right now (a copy). */
export function rowPayload(syncId: string): unknown {
  return clone(relay().rows.get(syncId)?.payload)
}

/** Seeds the relay without any event (the row already existed before the test). */
export function seedRow(syncId: string, payload: unknown): void {
  relay().rows.set(syncId, { payload: clone(payload), updated_at: new Date().toISOString() })
}

/** Queues failures for the next pull/push requests, in order. */
export function failNext(op: 'pull' | 'push', ...failures: Failure[]): void {
  relay().failures[op].push(...failures)
}

function fanOut(writer: FakeClient | null, syncId: string, row: RelayRow, insert: boolean): void {
  const r = relay()
  for (const channel of r.channels) {
    if (!channel.matches(syncId)) continue
    if (!r.selfEcho && writer !== null && channel.client === writer) continue
    const event: ChangeEvent = {
      eventType: insert ? 'INSERT' : 'UPDATE',
      schema: 'public',
      table: 'sync_buckets',
      new: r.omitPayload
        ? { sync_id: syncId, updated_at: row.updated_at }
        : { sync_id: syncId, payload: clone(row.payload), updated_at: row.updated_at },
      old: {},
    }
    setTimeout(() => {
      if (relay().channels.has(channel)) channel.deliver(event)
    }, r.latency.realtime)
  }
}

/** Another device (with no channel of its own here) writing the row exactly as given. */
export function writeAsOther(syncId: string, payload: unknown): void {
  const r = relay()
  const insert = !r.rows.has(syncId)
  const row: RelayRow = { payload: clone(payload), updated_at: new Date().toISOString() }
  r.rows.set(syncId, row)
  fanOut(null, syncId, row, insert)
}

/**
 * A v0.8.4-or-earlier device writing the row: no `wr`, no `x5`, a fresh `exportDate`.
 * Fans out to every subscribed device (it has no channel of its own).
 */
export function writeAsLegacy(syncId: string, payload: Record<string, unknown>): void {
  const body: Record<string, unknown> = { ...payload, exportDate: new Date().toISOString() }
  delete body.wr
  delete body.x5
  relay().legacyWrites++
  writeAsOther(syncId, body)
}

type StatusCallback = (status: string) => void
type ChangeCallback = (event: ChangeEvent) => void

export class FakeChannel {
  private filter: string | null = null
  private onChange: ChangeCallback | null = null
  private onStatus: StatusCallback | null = null

  constructor(
    readonly client: FakeClient,
    readonly name: string,
  ) {}

  on(_type: string, opts: { filter?: string }, callback: ChangeCallback): this {
    this.filter = opts.filter ?? null
    this.onChange = callback
    return this
  }

  subscribe(callback?: StatusCallback): this {
    this.onStatus = callback ?? null
    const r = relay()
    r.channels.add(this)
    setTimeout(() => {
      if (relay().channels.has(this)) this.emit('SUBSCRIBED')
    }, r.subscribeDelay)
    return this
  }

  matches(syncId: string): boolean {
    return this.filter === null || this.filter === `sync_id=eq.${syncId}`
  }

  deliver(event: ChangeEvent): void {
    this.onChange?.(event)
  }

  /** Reports a channel status to the subscriber (SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED). */
  emit(status: string): void {
    this.onStatus?.(status)
  }
}

const SDK_RETRIES = 3
const SDK_RETRY_STATUS: ReadonlySet<number> = new Set([0, 503, 520])

class Query implements PromiseLike<RelayResponse> {
  private op: 'select' | 'upsert' = 'select'
  private syncId = ''
  private row: Record<string, unknown> = {}
  private signal: AbortSignal | null = null
  private retries = true

  constructor(private readonly client: FakeClient) {}

  select(_columns?: string): this {
    this.op = 'select'
    return this
  }

  upsert(row: Record<string, unknown>): this {
    this.op = 'upsert'
    this.row = row
    this.syncId = typeof row.sync_id === 'string' ? row.sync_id : ''
    return this
  }

  eq(column: string, value: string): this {
    if (column === 'sync_id') this.syncId = value
    return this
  }

  abortSignal(signal: AbortSignal): this {
    this.signal = signal
    return this
  }

  retry(enabled: boolean): this {
    this.retries = enabled
    return this
  }

  maybeSingle(): this {
    return this
  }

  then<A = RelayResponse, B = never>(
    onFulfilled?: ((value: RelayResponse) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.withSdkRetry(0).then(onFulfilled, onRejected)
  }

  /** The SDK's own GET retry (on unless `.retry(false)`): 1 s, 2 s, 4 s between tries. */
  private async withSdkRetry(attempt: number): Promise<RelayResponse> {
    const response = await this.execute()
    const retryable =
      this.op === 'select' &&
      this.retries &&
      attempt < SDK_RETRIES &&
      response.error !== null &&
      SDK_RETRY_STATUS.has(response.status) &&
      !this.signal?.aborted
    if (!retryable) return response
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    return this.withSdkRetry(attempt + 1)
  }

  private execute(): Promise<RelayResponse> {
    const r = relay()
    const failure = r.failures[this.op === 'select' ? 'pull' : 'push'].shift()
    if (this.op === 'select') {
      r.pulls++
      this.client.pulls++
    } else {
      r.upserts++
      this.client.upserts++
    }
    if (failure && 'hang' in failure) return new Promise<RelayResponse>(() => undefined)

    return new Promise<RelayResponse>((resolve) => {
      const latency = this.op === 'select' ? r.latency.pull : r.latency.push
      const timers: ReturnType<typeof setTimeout>[] = []
      const onAbort = () => {
        timers.forEach(clearTimeout)
        resolve(errorResponse(0, 'AbortError: This operation was aborted'))
      }
      if (this.signal?.aborted) {
        onAbort()
        return
      }
      this.signal?.addEventListener('abort', onAbort, { once: true })
      if (failure && 'abortable' in failure) return // settles only through the abort signal

      if (this.op === 'upsert' && !failure) {
        timers.push(setTimeout(() => this.write(), Math.floor(latency / 2)))
      }
      timers.push(
        setTimeout(() => {
          this.signal?.removeEventListener('abort', onAbort)
          if (failure) {
            const message =
              failure.message ?? (failure.status === 0 ? 'TypeError: Failed to fetch' : 'Error')
            resolve(errorResponse(failure.status, message, failure.code))
            return
          }
          if (this.op === 'upsert') {
            resolve({ data: null, error: null, status: 201 })
            return
          }
          const row = relay().rows.get(this.syncId)
          resolve({
            data: row ? { payload: clone(row.payload), updated_at: row.updated_at } : null,
            error: null,
            status: 200,
          })
        }, latency),
      )
    })
  }

  private write(): void {
    const r = relay()
    const insert = !r.rows.has(this.syncId)
    const updatedAt =
      typeof this.row.updated_at === 'string' ? this.row.updated_at : new Date().toISOString()
    const row: RelayRow = { payload: clone(this.row.payload), updated_at: updatedAt }
    r.rows.set(this.syncId, row)
    r.pushes.push({
      client: this.client.id,
      syncId: this.syncId,
      payload: clone(this.row.payload),
      at: Date.now(),
    })
    fanOut(this.client, this.syncId, row, insert)
  }
}

export class FakeClient {
  readonly id: number
  pulls = 0
  upserts = 0

  constructor() {
    this.id = relay().nextClient++
  }

  from(_table: string): Query {
    return new Query(this)
  }

  channel(name: string): FakeChannel {
    const channel = new FakeChannel(this, name)
    relay().created.push(channel)
    return channel
  }

  async removeChannel(channel: FakeChannel): Promise<'ok'> {
    const r = relay()
    r.removed.push(channel)
    r.channels.delete(channel)
    if (!r.closeSync) await Promise.resolve()
    channel.emit('CLOSED')
    return 'ok'
  }
}

/** What `vi.mock('@supabase/supabase-js', …)` returns in the sync suites. */
export const supabaseModule = {
  createClient: (): FakeClient | Promise<never> => {
    const r = relay()
    // `import(sdk).then((m) => m.createClient())` adopts this promise, so the load never settles.
    if (r.importStalls > 0) {
      r.importStalls--
      return new Promise<never>(() => undefined)
    }
    if (r.importFailures > 0) {
      r.importFailures--
      throw new TypeError('Failed to fetch dynamically imported module')
    }
    return new FakeClient()
  },
}

// ---------------------------------------------------------------------------
// Devices: a fresh module graph per device, so two devices can share one relay.
// ---------------------------------------------------------------------------

type ExpenseModule = typeof import('../stores/useExpenseStore')
type SyncModule = typeof import('../stores/useSyncStore')
type UIModule = typeof import('../stores/useUIStore')

export interface Device {
  expense: ExpenseModule
  sync: SyncModule
  ui: UIModule
}

export const SYNC_CODE = '11111111-1111-4111-8111-111111111111'

const loaded: Device[] = []

/**
 * Loads a device's stores in their own module graph (call after vi.stubEnv for the relay).
 * With a relay configured it also loads the device's sync engine now, inside the same graph:
 * the engine is a lazy chunk, and a later first load would resolve against whichever device's
 * modules were loaded last (and in real time, which fake timers do not wait for).
 */
export async function loadDevice(): Promise<Device> {
  vi.resetModules()
  const expense = await import('../stores/useExpenseStore')
  const sync = await import('../stores/useSyncStore')
  const ui = await import('../stores/useUIStore')
  const { syncEnabled } = await import('../services/syncConfig')
  if (syncEnabled) await sync.loadSyncEngine()
  const device = { expense, sync, ui }
  loaded.push(device)
  return device
}

/**
 * Stops every device loaded so far. Their listeners stay on the shared jsdom document and
 * window, so a later test's lifecycle events must find them disconnected and unhydrated.
 */
export function retireDevices(): void {
  for (const device of loaded.splice(0)) {
    device.sync.useSyncStore.getState().disconnectSync()
    device.expense.useExpenseStore.setState({ hydrated: false })
  }
}

/** The relay's expense rows right now (a copy), or [] when the row has none. */
export function relayRows(syncId = SYNC_CODE): unknown[] {
  const payload = rowPayload(syncId)
  if (typeof payload !== 'object' || payload === null || !('expenses' in payload)) return []
  const rows: unknown = payload.expenses
  return Array.isArray(rows) ? rows : []
}

/** Sets `document.visibilityState` and fires `visibilitychange`, as a mobile OS does. */
export function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

export function stubRelayEnv(): void {
  vi.stubEnv('VITE_SUPABASE_URL', 'http://relay.test')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
}

/** Lets every timer and promise due within `ms` run (fake timers). */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Runs virtual time forward by `ms`, then hands back the (by now settled) promise. */
export async function settle<T>(promise: Promise<T>, ms = 100): Promise<T> {
  promise.catch(() => undefined) // observed below; avoids an unhandled-rejection report meanwhile
  await vi.advanceTimersByTimeAsync(ms)
  return promise
}

// ---------------------------------------------------------------------------
// Fixtures shared by the store suites
// ---------------------------------------------------------------------------

export const T0 = '2026-10-01T04:00:00.000Z'

/** An invented expense (local-noon date, created at T0). */
export function expense(id: string, over: Partial<Expense> = {}): Expense {
  return {
    id,
    itemName: `item ${id}`,
    amount: 1,
    category: 'Other',
    date: '2026-10-01T12:00:00',
    createdAt: T0,
    ...over,
  }
}

/** A v4 relay payload holding `expenses`. */
export function payloadOf(
  expenses: readonly unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    expenses,
    categories: ['Other', 'Meals'],
    categoryMappings: {},
    budgets: {},
    budgetUpdatedAt: {},
    budgetDeletedAt: {},
    deletedIds: [],
    exportDate: T0,
    version: '4.0',
    ...over,
  }
}

export interface BootOptions {
  expenses?: Expense[]
  /** Hydrate from localStorage and install persistence, as AppShell does. */
  persist?: boolean
  /** Raw rows in localStorage before hydrate (overrides `expenses`; may hold unreadable rows). */
  storedRows?: readonly unknown[]
  /** A sync code saved by an earlier session (initSync connects with it on boot). */
  savedCode?: string
}

/** A device booted the way AppShell boots it: local data, persistence, then sync wiring. */
export async function bootDevice(opts: BootOptions = {}): Promise<Device> {
  const device = await loadDevice()
  const store = device.expense.useExpenseStore
  const expenses = opts.expenses ?? []
  if (opts.persist) {
    localStorage.setItem('expenses', JSON.stringify(opts.storedRows ?? expenses))
    store.getState().hydrate()
    device.expense.installPersistence()
  } else {
    store.setState({
      hydrated: true,
      expenses,
      categories: ['Other', 'Meals'],
      categoryMappings: {},
      budgets: {},
      budgetUpdatedAt: {},
      budgetDeletedAt: {},
      deletedIds: [],
    })
  }
  if (opts.savedCode === undefined) localStorage.removeItem('syncId')
  else localStorage.setItem('syncId', opts.savedCode)
  device.sync.installSync()
  return device
}

/** Connects a device to the shared code and lets the first cycles run out. */
export async function connect(device: Device, ms = 5000): Promise<unknown> {
  return settle(device.sync.useSyncStore.getState().setupSync(SYNC_CODE), ms)
}
