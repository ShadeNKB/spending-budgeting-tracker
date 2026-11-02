// Fake Supabase transport for the sync suites. It mirrors the parts of
// @supabase/supabase-js that SpendTrack uses (0.8.4, 0.9.2, 0.10.0 and this build):
//   from(t).select(c).eq('sync_id', id)[.retry(b)][.abortSignal(s)].maybeSingle()   → {data, error, status}
//   from(t).upsert(row)[.select(c)][.retry(b)][.abortSignal(s)]                     → {data, error, status}
//   from(t).insert(row).select(c)[.single()]  (23505 / 409 when the row exists)
//   from(t).update(patch).eq('sync_id', id)[.eq('updated_at', base)].select(c)      (0 rows = no match)
//   rpc('st_sync_head' | 'st_sync_pull' | 'st_sync_push', args)                      (migration 004)
//   channel(n, opts).on('postgres_changes', {filter}, cb).on('broadcast', {event}, cb).subscribe(statusCb)
//   channel.send({type: 'broadcast', event, payload}), channel.httpSend(event, payload), removeChannel(ch)
//   (like realtime-js, `channel(name)` hands out the client's open channel of that name again)
// Like postgrest-js 2.106, a GET whose fetch fails (status 0) or answers 503/520 is retried
// up to 3 times after 1, 2 and 4 s unless `.retry(false)` was called; each try is a pull.
// Timing runs on (fake) timers: a write lands half-way through the push latency, the
// response arrives at the full latency, and every subscribed channel (the writer's own
// too, unless self-echo is off) receives the change `latency.realtime` after the write.
// `updated_at` is stored and returned in PostgREST's form (microseconds, trailing zeros trimmed,
// `+00:00`), unique per write of a row like Postgres's clock. A table write stores the client's
// token; an RPC write gets the server's (`GREATEST(clock, base + 1 µs)`).
// State lives on globalThis, so device module graphs loaded with vi.resetModules() share
// one relay; every device boots on its own storage (MemoryStorage). Works against the v0.8.4
// code too (it ignores the event argument).
import { vi } from 'vitest'
import type { Expense } from '../types'

export type Failure =
  | { status: number; code?: string; message?: string }
  | { hang: true }
  | { abortable: true }
  /**
   * A push the server commits `ghost` ms after the request although it never answers: the
   * client gives up at its deadline, and the write still lands later (over anything newer).
   */
  | { ghost: number }

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

export interface BroadcastMessage {
  type: 'broadcast'
  event: string
  payload: unknown
}

interface RelayRow {
  payload: unknown
  updated_at: string
}

export interface PushRecord {
  client: number
  syncId: string
  payload: unknown
  /** When the write landed. */
  at: number
  /** When the request was made (the client built the payload just before). */
  requestedAt: number
  /** How it was written. */
  via: 'upsert' | 'insert' | 'update' | 'rpc'
}

/** A pull that was answered with a row: what the client got, and when. */
export interface PullRecord {
  client: number
  payload: unknown
  at: number
}

export type RequestKind = 'head' | 'pull' | 'upsert' | 'insert' | 'update' | 'rpc'

/** Every request a client made, as the relay saw it. */
export interface RequestRecord {
  readonly client: number
  readonly kind: RequestKind
  /** The RPC function, for kind 'rpc'. */
  readonly fn?: string
  /** The RPC arguments, for kind 'rpc'. */
  readonly args?: Readonly<Record<string, unknown>>
  /** `column=eq.value` filters, in order (postgrest-js URL form, before encoding). */
  readonly filters: readonly string[]
  /** The columns a write asked back (`select=`), or null. */
  readonly returning: string | null
  /** The row or patch a table write sent. */
  readonly body?: Readonly<Record<string, unknown>>
  readonly at: number
}

export interface BroadcastRecord {
  readonly client: number
  readonly topic: string
  readonly event: string
  readonly payload: unknown
  readonly via: 'ws' | 'http'
  readonly at: number
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
  /** Queued failures; heads (table and RPC) draw from `head`, pulls from `pull`, writes from `push`. */
  failures: { head: Failure[]; pull: Failure[]; push: Failure[] }
  importFailures: number
  /** SDK downloads that never finish (a stalled chunk fetch). */
  importStalls: number
  heads: number
  pulls: number
  upserts: number
  inserts: number
  updates: number
  rpcs: number
  /** Broadcast messages sent (WebSocket and HTTP). */
  broadcasts: number
  pushes: PushRecord[]
  pullLog: PullRecord[]
  requests: RequestRecord[]
  broadcastLog: BroadcastRecord[]
  legacyWrites: number
  nextClient: number
  /** Per-client latency overrides (undefined: the shared latency). */
  pushLatencyFor: ((client: number) => number | undefined) | null
  pullLatencyFor: ((client: number) => number | undefined) | null
  /** When in a push's latency the write lands (0..1). */
  writeFraction: number
  /** When in a pull's latency the row is read (0..1); the answer still comes at the end. */
  pullReadFraction: number
  /** The realtime socket is down: no events, and a (re)subscribe answers CHANNEL_ERROR. */
  realtimeDown: boolean
  /**
   * Clients without a network: their requests fail with status 0, they get no events, and their
   * channels (re)subscribe with CHANNEL_ERROR (see `setClientOffline`).
   */
  offlineClients: Set<number>
  /** Ghost pushes (see `Failure`) that have landed. */
  ghostsLanded: number
  /** Migration 004: the three sync functions exist ('absent' answers 404 PGRST202). */
  rpc: 'absent' | 'present'
  /** Migration 005: every table call answers 401 42501 (the functions keep working). */
  lockdown: boolean
  /** The project refuses public Broadcast: a channel with a Broadcast binding fails to join. */
  broadcast: 'on' | 'rejected'
  /** `postgres_changes` refused (realtime publication dropped): such a channel fails to join. */
  rowEvents: 'on' | 'rejected'
  /** The RPC push refuses a payload whose JSON is longer than this in UTF-8 bytes (22023). */
  rpcMaxBytes: number
  /** The RPC create is over its caps: 53400. */
  rpcFull: boolean
  /** The options every client was created with (the last one last). */
  clientOptions: unknown[]
  /**
   * Runs at the moment a write lands, before it is applied: a test scripts what another device
   * does in between (a crossing write, a row removed) to drive conflicts and missing rows.
   */
  beforeWrite: ((write: { client: number; via: PushRecord['via']; force: boolean }) => void) | null
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
    failures: { head: [], pull: [], push: [] },
    importFailures: 0,
    importStalls: 0,
    heads: 0,
    pulls: 0,
    upserts: 0,
    inserts: 0,
    updates: 0,
    rpcs: 0,
    broadcasts: 0,
    pushes: [],
    pullLog: [],
    requests: [],
    broadcastLog: [],
    legacyWrites: 0,
    nextClient: 1,
    pushLatencyFor: null,
    pullLatencyFor: null,
    writeFraction: 0.5,
    pullReadFraction: 1,
    realtimeDown: false,
    offlineClients: new Set(),
    ghostsLanded: 0,
    rpc: 'absent',
    lockdown: false,
    broadcast: 'on',
    rowEvents: 'on',
    rpcMaxBytes: 1_258_291,
    rpcFull: false,
    clientOptions: [],
    beforeWrite: null,
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

function clone(value: unknown): unknown {
  if (value === undefined) return undefined
  const copy: unknown = JSON.parse(JSON.stringify(value))
  return copy
}

const errorResponse = (status: number, message: string, code = ''): RelayResponse => ({
  data: null,
  error: { message, code, details: '', hint: '' },
  status,
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function cloneRecord(v: Record<string, unknown>): Record<string, unknown> {
  const copy = clone(v)
  return isObject(copy) ? copy : {}
}

/** A stored listener: the overloads of `FakeChannel.on` tie each binding to what it delivers. */
const callable = (f: unknown): f is (arg: unknown) => void => typeof f === 'function'

// ---------------------------------------------------------------------------
// Time stamps as Postgres keeps them (microseconds) and PostgREST prints them
// ---------------------------------------------------------------------------

const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/** An ISO time stamp as integer microseconds since the epoch (UTC without a zone), or null. */
export function micros(text: string): number | null {
  const m = STAMP.exec(text)
  if (m === null) return null
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  let offset = 0
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'))
  }
  return (ms - offset * 60_000) * 1000 + Number(frac.padEnd(6, '0'))
}

/** PostgREST's JSON form of a timestamptz: `2026-11-02T10:00:00.123456+00:00`, zeros trimmed. */
export function pgTime(us: number): string {
  const ms = Math.floor(us / 1000)
  const iso = new Date(ms).toISOString() // …T10:00:00.123Z
  const frac = `${iso.slice(20, 23)}${String(us - ms * 1000).padStart(3, '0')}`.replace(/0+$/, '')
  return `${iso.slice(0, 19)}${frac === '' ? '' : `.${frac}`}+00:00`
}

/** What a write stores: its own token (or now), never equal to the row's current stamp. */
function stampFor(syncId: string, token: unknown): string {
  const prev = relay().rows.get(syncId)
  const prevUs = prev === undefined ? null : micros(prev.updated_at)
  let us = (typeof token === 'string' ? micros(token) : null) ?? Date.now() * 1000
  while (us === prevUs) us++
  return pgTime(us)
}

/** An RPC write's server token: GREATEST(clock_timestamp(), base + 1 µs), past the current one. */
function serverStamp(syncId: string, base: string | null): string {
  const prev = relay().rows.get(syncId)
  const prevUs = prev === undefined ? 0 : (micros(prev.updated_at) ?? 0)
  const baseUs = base === null ? 0 : (micros(base) ?? 0)
  return pgTime(Math.max(Date.now() * 1000, baseUs + 1, prevUs + 1))
}

/** The row as it is on the relay right now (a copy). */
export function rowPayload(syncId: string): unknown {
  return clone(relay().rows.get(syncId)?.payload)
}

/** The row's `updated_at` right now, as PostgREST returns it. */
export function rowStamp(syncId: string): string | undefined {
  return relay().rows.get(syncId)?.updated_at
}

/** Seeds the relay without any event (the row already existed before the test). */
export function seedRow(syncId: string, payload: unknown): void {
  relay().rows.set(syncId, { payload: clone(payload), updated_at: stampFor(syncId, null) })
}

/** Removes the row without any event (pruned on the server, or never there). */
export function dropRow(syncId: string): void {
  relay().rows.delete(syncId)
}

/** Queues failures for the next head/pull/push requests, in order. */
export function failNext(op: 'head' | 'pull' | 'push', ...failures: Failure[]): void {
  relay().failures[op].push(...failures)
}

/** How many writes landed on the relay (any way: upsert, insert, update, RPC). */
export function landedPushes(client?: number): number {
  return relay().pushes.filter((p) => client === undefined || p.client === client).length
}

/** Requests of a kind (by every client, or one). */
export function requestsOf(kind: RequestKind, client?: number): RequestRecord[] {
  return relay().requests.filter(
    (r) => r.kind === kind && (client === undefined || r.client === client),
  )
}

function fanOut(writer: FakeClient | null, syncId: string, row: RelayRow, insert: boolean): void {
  const r = relay()
  if (r.realtimeDown) return
  for (const channel of r.channels) {
    if (!channel.hearsRow(syncId)) continue
    if (r.offlineClients.has(channel.client.id)) continue
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

/** A Broadcast message to every joined channel on `topic` but `except` (self: false). */
function broadcastTo(topic: string, event: string, payload: unknown, except: FakeChannel | null) {
  const r = relay()
  if (r.realtimeDown) return
  for (const channel of r.channels) {
    if (channel === except || channel.name !== topic || !channel.joined) continue
    if (r.offlineClients.has(channel.client.id)) continue
    const message: BroadcastMessage = { type: 'broadcast', event, payload: clone(payload) }
    setTimeout(() => {
      if (relay().channels.has(channel)) channel.hear(message)
    }, r.latency.realtime)
  }
}

/** Another device (with no channel of its own here) writing the row exactly as given. */
export function writeAsOther(syncId: string, payload: unknown): void {
  const r = relay()
  const insert = !r.rows.has(syncId)
  const row: RelayRow = { payload: clone(payload), updated_at: stampFor(syncId, null) }
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
type BroadcastCallback = (message: BroadcastMessage) => void

export interface ChannelOptions {
  config?: { broadcast?: { self?: boolean; ack?: boolean }; private?: boolean }
}

export class FakeChannel {
  private filter: string | null = null
  private onChange: unknown = null
  private broadcasts: { event: string; callback: unknown }[] = []
  private onStatus: StatusCallback | null = null
  /** It answered SUBSCRIBED (and has not dropped since). */
  joined = false

  constructor(
    readonly client: FakeClient,
    readonly name: string,
    readonly options?: ChannelOptions,
  ) {}

  on(type: 'postgres_changes', opts: { filter?: string }, callback: ChangeCallback): this
  on(type: 'broadcast', opts: { event: string }, callback: BroadcastCallback): this
  on(
    type: 'postgres_changes' | 'broadcast',
    opts: { filter?: string; event?: string },
    callback: ChangeCallback | BroadcastCallback,
  ): this {
    if (type === 'broadcast') {
      this.broadcasts.push({ event: opts.event ?? '', callback })
    } else {
      this.filter = opts.filter ?? null
      this.onChange = callback
    }
    return this
  }

  /** The channel has a postgres_changes binding. */
  get rowEvents(): boolean {
    return this.onChange !== null
  }

  /** The channel has a Broadcast binding. */
  get broadcastEvents(): boolean {
    return this.broadcasts.length > 0
  }

  /** The postgres_changes filter it asked for (null without one). */
  get rowFilter(): string | null {
    return this.onChange === null ? null : this.filter
  }

  subscribe(callback?: StatusCallback): this {
    this.onStatus = callback ?? null
    const r = relay()
    r.channels.add(this)
    setTimeout(() => {
      const now = relay()
      if (!now.channels.has(this)) return
      const down =
        now.realtimeDown ||
        now.offlineClients.has(this.client.id) ||
        (this.rowEvents && now.rowEvents === 'rejected') ||
        (this.broadcastEvents && now.broadcast === 'rejected')
      this.emit(down ? 'CHANNEL_ERROR' : 'SUBSCRIBED')
    }, r.subscribeDelay)
    return this
  }

  /** It hears row changes of `syncId` (a postgres_changes binding with no or that filter). */
  hearsRow(syncId: string): boolean {
    return (
      this.onChange !== null && (this.filter === null || this.filter === `sync_id=eq.${syncId}`)
    )
  }

  /** Kept for older suites: true when the channel would hear `syncId`'s row changes. */
  matches(syncId: string): boolean {
    return this.hearsRow(syncId)
  }

  deliver(event: ChangeEvent): void {
    if (callable(this.onChange)) this.onChange(event)
  }

  hear(message: BroadcastMessage): void {
    for (const b of this.broadcasts) {
      if (b.event === message.event && callable(b.callback)) b.callback(message)
    }
  }

  /** Reports a channel status to the subscriber (SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED). */
  emit(status: string): void {
    this.joined = status === 'SUBSCRIBED'
    this.onStatus?.(status)
  }

  /** WebSocket send: only a joined channel delivers it ('ok'); otherwise 'error'. */
  send(args: { type: string; event: string; payload?: unknown }): Promise<'ok' | 'error'> {
    const r = relay()
    if (args.type !== 'broadcast' || !this.joined || r.broadcast === 'rejected') {
      return Promise.resolve('error')
    }
    r.broadcasts++
    r.broadcastLog.push({
      client: this.client.id,
      topic: this.name,
      event: args.event,
      payload: clone(args.payload),
      via: 'ws',
      at: Date.now(),
    })
    const self = this.options?.config?.broadcast?.self === true
    broadcastTo(this.name, args.event, args.payload, self ? null : this)
    return Promise.resolve('ok')
  }

  /** REST broadcast: works unsubscribed; every joined channel on the topic hears it. */
  httpSend(event: string, payload: unknown): Promise<{ success: true }> {
    const r = relay()
    if (r.offlineClients.has(this.client.id))
      return Promise.reject(new TypeError('Failed to fetch'))
    if (r.broadcast === 'rejected') return Promise.reject(new Error('Unauthorized'))
    r.broadcasts++
    r.broadcastLog.push({
      client: this.client.id,
      topic: this.name,
      event,
      payload: clone(payload),
      via: 'http',
      at: Date.now(),
    })
    broadcastTo(this.name, event, payload, null)
    return Promise.resolve({ success: true })
  }
}

const SDK_RETRIES = 3
const SDK_RETRY_STATUS: ReadonlySet<number> = new Set([0, 503, 520])

type Op = 'select' | 'upsert' | 'insert' | 'update' | 'rpc'

const DENIED = (): RelayResponse =>
  errorResponse(401, 'permission denied for table sync_buckets', '42501')
const NO_RPC = (fn: string): RelayResponse =>
  errorResponse(404, `Could not find the function public.${fn} in the schema cache`, 'PGRST202')

class Query implements PromiseLike<RelayResponse> {
  private op: Op = 'select'
  private columns = '*'
  private syncId = ''
  private filters: string[] = []
  private base: string | null = null
  private row: Record<string, unknown> = {}
  private returning: string | null = null
  private one: 'many' | 'single' | 'maybe' = 'many'
  private signal: AbortSignal | null = null
  private retries = true
  private fn = ''
  private args: Record<string, unknown> = {}

  constructor(private readonly client: FakeClient) {}

  /** `rpc(fn, args)`: a POST, never retried by the SDK. */
  static rpc(client: FakeClient, fn: string, args: Record<string, unknown>): Query {
    const q = new Query(client)
    q.op = 'rpc'
    q.fn = fn
    q.args = args
    q.retries = false
    return q
  }

  select(columns = '*'): this {
    if (this.op === 'select') this.columns = columns
    else this.returning = columns
    return this
  }

  upsert(row: Record<string, unknown>): this {
    this.op = 'upsert'
    this.row = row
    this.syncId = typeof row.sync_id === 'string' ? row.sync_id : ''
    return this
  }

  insert(row: Record<string, unknown>): this {
    this.op = 'insert'
    this.row = row
    this.syncId = typeof row.sync_id === 'string' ? row.sync_id : ''
    return this
  }

  update(patch: Record<string, unknown>): this {
    this.op = 'update'
    this.row = patch
    return this
  }

  eq(column: string, value: string): this {
    this.filters.push(`${column}=eq.${value}`)
    if (column === 'sync_id') this.syncId = value
    if (column === 'updated_at') this.base = value
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
    this.one = 'maybe'
    return this
  }

  single(): this {
    this.one = 'single'
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

  private get kind(): RequestKind {
    if (this.op === 'select') return this.columns === 'updated_at' ? 'head' : 'pull'
    return this.op
  }

  /** Which failure queue and latency this request draws from. */
  private get lane(): 'head' | 'pull' | 'push' {
    if (this.op === 'rpc') {
      return this.fn === 'st_sync_push' ? 'push' : this.fn === 'st_sync_head' ? 'head' : 'pull'
    }
    return this.op === 'select' ? (this.kind === 'head' ? 'head' : 'pull') : 'push'
  }

  private count(r: RelayState): void {
    const kind = this.kind
    r.requests.push({
      client: this.client.id,
      kind,
      ...(kind === 'rpc' ? { fn: this.fn, args: cloneRecord(this.args) } : {}),
      filters: [...this.filters],
      returning: this.returning,
      ...(this.op === 'select' || this.op === 'rpc' ? {} : { body: cloneRecord(this.row) }),
      at: Date.now(),
    })
    if (kind === 'head') {
      r.heads++
      this.client.heads++
    } else if (kind === 'pull') {
      r.pulls++
      this.client.pulls++
    } else if (kind === 'upsert') {
      r.upserts++
      this.client.upserts++
    } else if (kind === 'insert') r.inserts++
    else if (kind === 'update') r.updates++
    else r.rpcs++
  }

  private execute(): Promise<RelayResponse> {
    const r = relay()
    const requestedAt = Date.now()
    const failure: Failure | undefined = r.offlineClients.has(this.client.id)
      ? { status: 0 }
      : r.failures[this.lane].shift()
    this.count(r)
    if (failure && 'hang' in failure) return new Promise<RelayResponse>(() => undefined)
    if (failure && 'ghost' in failure) {
      // It lands whatever the client does; the client only ever sees its own abort.
      if (this.lane === 'push') {
        setTimeout(() => {
          relay().ghostsLanded++
          this.write(requestedAt)
        }, failure.ghost)
      }
      return new Promise<RelayResponse>((resolve) => {
        const onAbort = () => {
          resolve(errorResponse(0, 'AbortError: This operation was aborted'))
        }
        if (this.signal?.aborted) onAbort()
        else this.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }

    return new Promise<RelayResponse>((resolve) => {
      const latency =
        this.lane === 'push'
          ? (r.pushLatencyFor?.(this.client.id) ?? r.latency.push)
          : (r.pullLatencyFor?.(this.client.id) ?? r.latency.pull)
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

      // Refusals are decided when the request arrives (a lockdown, a missing function).
      const refused = this.refusal()
      let answer: RelayResponse | null = refused
      if (this.lane === 'push' && !failure && refused === null) {
        timers.push(
          setTimeout(
            () => {
              answer = this.write(requestedAt)
            },
            Math.floor(latency * r.writeFraction),
          ),
        )
      }
      // A slow download (or a page frozen between the read and its continuation) answers with
      // the row as it was when it was read.
      let read: RelayRow | undefined
      const readEarly = this.lane !== 'push' && !failure && r.pullReadFraction < 1
      if (readEarly) {
        timers.push(
          setTimeout(
            () => {
              const row = relay().rows.get(this.target)
              read = row ? { ...row, payload: clone(row.payload) } : undefined
            },
            Math.floor(latency * r.pullReadFraction),
          ),
        )
      }
      timers.push(
        setTimeout(() => {
          this.signal?.removeEventListener('abort', onAbort)
          if (failure && 'status' in failure) {
            const message =
              failure.message ?? (failure.status === 0 ? 'TypeError: Failed to fetch' : 'Error')
            resolve(errorResponse(failure.status, message, failure.code))
            return
          }
          if (answer !== null) {
            resolve(answer)
            return
          }
          const row = readEarly ? read : relay().rows.get(this.target)
          resolve(this.readAnswer(row))
        }, latency),
      )
    })
  }

  /** The row this request is about. */
  private get target(): string {
    if (this.op !== 'rpc') return this.syncId
    const row = this.args.p_row
    return typeof row === 'string' ? row : ''
  }

  private refusal(): RelayResponse | null {
    const r = relay()
    if (this.op === 'rpc') {
      if (r.rpc !== 'present') return NO_RPC(this.fn)
      if (this.fn === 'st_sync_push') {
        const payload = this.args.p_payload
        const bytes = new TextEncoder().encode(JSON.stringify(payload)).length
        if (!isObject(payload) || bytes > r.rpcMaxBytes) {
          return errorResponse(400, 'invalid payload', '22023')
        }
        if (this.args.p_base === null && this.args.p_force !== true && r.rpcFull) {
          if (!r.rows.has(this.target)) return errorResponse(503, 'relay is full', '53400')
        }
      }
      return null
    }
    return r.lockdown ? DENIED() : null
  }

  /** A head or pull answer: the row, or nothing. */
  private readAnswer(row: RelayRow | undefined): RelayResponse {
    if (row && this.lane === 'pull') {
      relay().pullLog.push({ client: this.client.id, payload: clone(row.payload), at: Date.now() })
    }
    if (this.op === 'rpc') {
      if (row === undefined) return { data: null, error: null, status: 200 }
      if (this.fn === 'st_sync_head') return { data: row.updated_at, error: null, status: 200 }
      return {
        data: {
          payload: clone(row.payload),
          updated_at: row.updated_at,
          now: pgTime(Date.now() * 1000),
        },
        error: null,
        status: 200,
      }
    }
    if (row === undefined) return { data: null, error: null, status: 200 }
    const data: Record<string, unknown> = {}
    for (const col of this.columns.split(',')) {
      const c = col.trim()
      if (c === 'payload' || c === '*') data.payload = clone(row.payload)
      if (c === 'updated_at' || c === '*') data.updated_at = row.updated_at
    }
    return { data, error: null, status: 200 }
  }

  private ok(updatedAt: string | null): RelayResponse {
    if (this.returning === null) return { data: null, error: null, status: 201 }
    const rows = updatedAt === null ? [] : [{ updated_at: updatedAt }]
    if (this.one === 'single') {
      return rows[0] === undefined
        ? errorResponse(406, 'JSON object requested, multiple (or no) rows returned', 'PGRST116')
        : { data: rows[0], error: null, status: 201 }
    }
    return { data: rows, error: null, status: this.op === 'update' ? 200 : 201 }
  }

  /** Applies a write at the moment it lands; returns the answer the client will get. */
  private write(requestedAt: number): RelayResponse {
    const r = relay()
    const syncId = this.target
    const via: PushRecord['via'] =
      this.op === 'rpc' ? 'rpc' : this.op === 'insert' || this.op === 'update' ? this.op : 'upsert'
    const force =
      this.op === 'rpc' ? this.args.p_force === true : this.op === 'update' && this.base === null
    r.beforeWrite?.({ client: this.client.id, via, force })
    const current = r.rows.get(syncId)
    if (this.op === 'rpc') return this.rpcWrite(requestedAt, current)
    if (this.op === 'insert' && current !== undefined) {
      return errorResponse(409, 'duplicate key value violates unique constraint', '23505')
    }
    if (this.op === 'update') {
      if (current === undefined) return this.ok(null)
      if (this.base !== null && micros(current.updated_at) !== micros(this.base))
        return this.ok(null)
    }
    const payload =
      this.op === 'update' && !('payload' in this.row) ? current?.payload : this.row.payload
    const row: RelayRow = {
      payload: clone(payload),
      updated_at: stampFor(syncId, this.row.updated_at),
    }
    this.land(
      syncId,
      row,
      current === undefined,
      requestedAt,
      this.op === 'insert' || this.op === 'update' ? this.op : 'upsert',
    )
    return this.ok(row.updated_at)
  }

  /** st_sync_push as migration 004 runs it: create-only, CAS, or force-on-existing. */
  private rpcWrite(requestedAt: number, current: RelayRow | undefined): RelayResponse {
    const syncId = this.target
    const base = typeof this.args.p_base === 'string' ? this.args.p_base : null
    const force = this.args.p_force === true
    const missing = { ok: false, reason: 'missing', updated_at: null }
    const conflict = { ok: false, reason: 'conflict', updated_at: current?.updated_at ?? null }
    if (force) {
      if (current === undefined) return { data: missing, error: null, status: 200 }
    } else if (base === null) {
      if (current !== undefined) return { data: conflict, error: null, status: 200 }
    } else if (current === undefined) {
      return { data: missing, error: null, status: 200 }
    } else if (micros(current.updated_at) !== micros(base)) {
      return { data: conflict, error: null, status: 200 }
    }
    const row: RelayRow = {
      payload: clone(this.args.p_payload),
      updated_at: serverStamp(syncId, force ? null : base),
    }
    this.land(syncId, row, current === undefined, requestedAt, 'rpc')
    return { data: { ok: true, updated_at: row.updated_at }, error: null, status: 200 }
  }

  private land(
    syncId: string,
    row: RelayRow,
    insert: boolean,
    requestedAt: number,
    via: PushRecord['via'],
  ): void {
    const r = relay()
    r.rows.set(syncId, row)
    r.pushes.push({
      client: this.client.id,
      syncId,
      payload: clone(row.payload),
      at: Date.now(),
      requestedAt,
      via,
    })
    fanOut(this.client, syncId, row, insert)
  }
}

export class FakeClient {
  readonly id: number
  heads = 0
  pulls = 0
  upserts = 0

  constructor() {
    this.id = relay().nextClient++
  }

  from(_table: string): Query {
    return new Query(this)
  }

  rpc(fn: string, args: Record<string, unknown> = {}): Query {
    return Query.rpc(this, fn, args)
  }

  /** Like realtime-js: one channel per topic, handed out again until it is removed. */
  private readonly open = new Map<string, FakeChannel>()

  channel(name: string, options?: ChannelOptions): FakeChannel {
    const exists = this.open.get(name)
    if (exists !== undefined) return exists
    const channel = new FakeChannel(this, name, options)
    this.open.set(name, channel)
    relay().created.push(channel)
    return channel
  }

  async removeChannel(channel: FakeChannel): Promise<'ok'> {
    const r = relay()
    if (this.open.get(channel.name) === channel) this.open.delete(channel.name)
    r.removed.push(channel)
    r.channels.delete(channel)
    if (!r.closeSync) await Promise.resolve()
    channel.emit('CLOSED')
    return 'ok'
  }
}

/** What `vi.mock('@supabase/supabase-js', …)` returns in the sync suites. */
export const supabaseModule = {
  createClient: (_url?: string, _key?: string, options?: unknown): FakeClient | Promise<never> => {
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
    r.clientOptions.push(options)
    return new FakeClient()
  },
}

// ---------------------------------------------------------------------------
// Devices: a fresh module graph per device, so two devices can share one relay.
// ---------------------------------------------------------------------------

type ExpenseModule = typeof import('../stores/useExpenseStore')
type SyncModule = typeof import('../stores/useSyncStore')
type UIModule = typeof import('../stores/useUIStore')

/** The parts of `Storage` SpendTrack uses. */
export type StorageArea = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length' | 'clear'
>

/**
 * A device's own localStorage. Two devices in one jsdom must not share one: the local engine
 * reads what another tab wrote (cross-tab safety), which would carry data between "devices"
 * without the relay. The engine keeps the storage it booted on, so a device boots with its own
 * stubbed in as `localStorage`. Values are copied strings, as in a browser.
 */
export class MemoryStorage implements StorageArea {
  private readonly items = new Map<string, string>()
  /**
   * Keys whose writes fail with a quota error: one key, a prefix ending in '*' ('st5:q:relay:*'),
   * or all of them ('*').
   */
  readonly refuse = new Set<string>()
  /** Every key written, in order (what a test may assert about writes). */
  readonly writes: string[] = []
  /** Every key removed, in order. */
  readonly removes: string[] = []

  get length(): number {
    return this.items.size
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    const refused = [...this.refuse].some((r) =>
      r.endsWith('*') ? key.startsWith(r.slice(0, -1)) : r === key,
    )
    if (refused) {
      throw new DOMException(`The quota has been exceeded (${key}).`, 'QuotaExceededError')
    }
    this.items.set(key, value)
    this.writes.push(key)
  }

  removeItem(key: string): void {
    this.items.delete(key)
    this.removes.push(key)
  }

  clear(): void {
    this.items.clear()
  }
}

export interface Device {
  expense: ExpenseModule
  sync: SyncModule
  ui: UIModule
  /** The storage this device's local engine boots on. */
  storage: StorageArea
}

export const SYNC_CODE = '11111111-1111-4111-8111-111111111111'

const loaded: Device[] = []

/** Makes `storage` this jsdom's `localStorage` (what a device boots on and what tests read). */
export function installStorage(storage: StorageArea): void {
  vi.stubGlobal('localStorage', storage)
}

/**
 * SHA-256 in WebCrypto settles on a real thread-pool callback, which fake timers never wait for,
 * so a device's realtime topic (hashed from its code) would subscribe at a random point of a
 * test. The store suites route channels by name only, so a hash that settles in microtasks
 * stands in for it there (syncService.test checks the real topic).
 */
function quickDigest(): void {
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((_alg, data) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    const out = new Uint8Array(32)
    for (let lane = 0; lane < 8; lane++) {
      let h = (0x811c9dc5 ^ lane) >>> 0
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
      out.set([h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255], lane * 4)
    }
    return Promise.resolve(out.buffer)
  })
}

/**
 * Loads a device's stores in their own module graph (call after vi.stubEnv for the relay), on
 * `storage` when given (it becomes `localStorage`), else on the current `localStorage`.
 * With a relay configured it also loads the device's sync engine now, inside the same graph:
 * the engine is a lazy chunk, and a later first load would resolve against whichever device's
 * modules were loaded last (and in real time, which fake timers do not wait for).
 */
export async function loadDevice(storage?: StorageArea): Promise<Device> {
  if (storage !== undefined) installStorage(storage)
  const area: StorageArea = storage ?? localStorage
  quickDigest()
  vi.resetModules()
  const expense = await import('../stores/useExpenseStore')
  const sync = await import('../stores/useSyncStore')
  const ui = await import('../stores/useUIStore')
  const { syncEnabled } = await import('../services/syncConfig')
  if (syncEnabled) await sync.loadSyncEngine()
  const device = { expense, sync, ui, storage: area }
  loaded.push(device)
  return device
}

/** The device's sync engine module (loaded with the device when a relay is configured). */
export function engineOf(device: Device): ReturnType<SyncModule['loadSyncEngine']> {
  return device.sync.loadSyncEngine()
}

/**
 * Stops every device loaded so far. Their listeners stay on the shared jsdom document and
 * window, so a later test's lifecycle events must find them disconnected.
 */
export function retireDevices(): void {
  for (const device of loaded.splice(0)) {
    device.sync.useSyncStore.getState().disconnectSync()
  }
  vi.unstubAllGlobals()
}

/** The relay's expense rows right now (a copy), or [] when the row has none. */
export function relayRows(syncId = SYNC_CODE): unknown[] {
  const payload = rowPayload(syncId)
  if (typeof payload !== 'object' || payload === null || !('expenses' in payload)) return []
  const rows: unknown = payload.expenses
  return Array.isArray(rows) ? rows : []
}

/** The relay's tombstones right now (a copy), or [] when the row has none. */
export function relayDeleted(syncId = SYNC_CODE): unknown[] {
  const payload = rowPayload(syncId)
  if (typeof payload !== 'object' || payload === null || !('deletedIds' in payload)) return []
  const ids: unknown = payload.deletedIds
  return Array.isArray(ids) ? ids : []
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

/**
 * Math.random at its midpoint: the engine's ±20 % backoff jitter is then exactly 0, so a suite
 * can assert 2, 4, 8 … s. Each call is a hair apart, so ids drawn from it (toasts) stay distinct.
 */
export function steadyRandom(): void {
  let calls = 0
  vi.spyOn(Math, 'random').mockImplementation(() => 0.5 + ++calls * 1e-12)
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

/** The realtime socket drops (every live channel reports CHANNEL_ERROR) or comes back. */
export function dropRealtime(down: boolean): void {
  const r = relay()
  r.realtimeDown = down
  if (down) for (const channel of [...r.channels]) channel.emit('CHANNEL_ERROR')
}

/**
 * One client loses (or gets back) its network, as a phone does in a lift: its requests fail,
 * and its realtime socket drops (CHANNEL_ERROR), so it re-subscribes once it is back.
 */
export function setClientOffline(clientId: number, offline: boolean): void {
  const r = relay()
  if (offline) r.offlineClients.add(clientId)
  else r.offlineClients.delete(clientId)
  if (!offline) return
  for (const channel of [...r.channels]) {
    if (channel.client.id === clientId) channel.emit('CHANNEL_ERROR')
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

/** The local v4 keys a 0.9.x device leaves behind (what the first v5 boot migrates). */
export interface V4Seed {
  expenses?: readonly unknown[]
  categories?: readonly string[]
  categoryMappings?: Readonly<Record<string, string>>
  categoryMappingUpdatedAt?: Readonly<Record<string, string>>
  categoryBudgets?: Readonly<Record<string, number>>
  categoryBudgetUpdatedAt?: Readonly<Record<string, string>>
  categoryBudgetDeletedAt?: Readonly<Record<string, string>>
  deletedExpenseIds?: readonly string[]
}

/**
 * Writes `seed` as a 0.9.2 device stores it (P2-14: the public format, migrated on hydrate):
 * every v4 key, `spendtrack:app = '0.8.5'` (so its writes rank as stamped), its device id.
 */
export function seedV4(storage: StorageArea, seed: V4Seed = {}, dev = 'dev001'): void {
  const keys: Required<V4Seed> = {
    expenses: [],
    categories: ['Other', 'Meals'],
    categoryMappings: {},
    categoryMappingUpdatedAt: {},
    categoryBudgets: {},
    categoryBudgetUpdatedAt: {},
    categoryBudgetDeletedAt: {},
    deletedExpenseIds: [],
    ...seed,
  }
  for (const [key, value] of Object.entries(keys)) storage.setItem(key, JSON.stringify(value))
  storage.setItem('spendtrack:app', '0.8.5')
  storage.setItem('spendtrack:dev', dev)
}

export interface BootOptions {
  expenses?: readonly Expense[]
  /** Raw rows in storage before hydrate (overrides `expenses`; may hold unreadable rows). */
  storedRows?: readonly unknown[]
  /** Any other v4 key the device had before this version (categories, mappings, budgets…). */
  v4?: Omit<V4Seed, 'expenses'>
  /** A sync code saved by an earlier session (initSync connects with it on boot). */
  savedCode?: string
  /** Install the lifecycle and storage listeners, as AppShell does. */
  persist?: boolean
  /** The storage to boot on (a fresh one by default: every device has its own). */
  storage?: StorageArea
  /** Its device id (6 base36 chars). */
  dev?: string
}

let devices = 0

/**
 * A device booted the way the app boots it (P2-14): its storage holds what 0.9.2 left (v4 keys),
 * the local engine hydrates (migrating them), then sync is wired.
 */
export async function bootDevice(opts: BootOptions = {}): Promise<Device> {
  const storage = opts.storage ?? new MemoryStorage()
  devices++
  seedV4(
    storage,
    { ...opts.v4, expenses: opts.storedRows ?? opts.expenses ?? [] },
    opts.dev ?? `dev${String(devices).padStart(3, '0')}`,
  )
  if (opts.savedCode !== undefined) storage.setItem('syncId', opts.savedCode)
  const device = await loadDevice(storage)
  await device.expense.useExpenseStore.getState().hydrate()
  if (opts.persist) device.expense.installPersistence()
  device.sync.installSync()
  return device
}

/** Makes `device`'s storage `localStorage` again (before re-hydrating it, or reading it). */
export function onDevice(device: Device): void {
  installStorage(device.storage)
}

/** Connects a device to the shared code and lets the first cycles run out. */
export async function connect(device: Device, ms = 5000): Promise<unknown> {
  return settle(device.sync.useSyncStore.getState().setupSync(SYNC_CODE), ms)
}

/** A device's live entries, by id. */
export function liveIds(device: Device): string[] {
  return device.expense.useExpenseStore
    .getState()
    .expenses.map((e) => e.id)
    .sort()
}
