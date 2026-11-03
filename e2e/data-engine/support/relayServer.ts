// A fake sync relay for the data-engine e2e suite: the Supabase endpoints SpendTrack uses, in one
// node:http process, with no dependency.
//
// - PostgREST, table `sync_buckets` (migrations 001–003):
//   GET ?select=updated_at (head) or ?select=payload,… (pull) with sync_id=eq.<code>; POST with
//   `Prefer: resolution=merge-duplicates` (the plain upsert of 0.8.4–0.10.0, and of 0.11.0 with
//   CAS off), POST without it (insert: 201, or 409 `23505` when the row exists); PATCH with
//   sync_id=eq. and an optional updated_at=eq.<base> (compared as instants, the CAS of
//   VITE_SYNC_CAS=on); `return=representation` and `Accept: application/vnd.pgrst.object+json`
//   (`.single()`: 406 `PGRST116` unless exactly one row). `updated_at` is stored at microsecond
//   precision and returned as PostgREST does (`2026-11-02T10:00:00.123456+00:00`, trailing zeros
//   of the fraction dropped).
// - The RPC functions of 004_sync_rpc.sql (st_sync_head, st_sync_pull, st_sync_push with p_row,
//   p_payload, p_base, p_force), absent by default (404 `PGRST202`, as before 004) until
//   `enableRpc()`; `lockTable()` refuses every table call with 401 `42501` (005). As the SQL
//   does (PR-5 track spec §4, held to it by scripts/verify-cas.test.mjs): st_sync_push measures
//   the payload as jsonb text bytes and validates id, payload, size and shape (22023); its CAS
//   and forced tokens are `GREATEST(now, current + 1 µs)`; head and pull answer null for an id
//   that is not a lower-case UUID; after 004 a table write that would leave a bad row answers
//   400 `23514`; the lockdown is refused without 004, and the 004 rollback under the lockdown
//   (both throw, 55000). A GET with no sync_id filter lists rows, as PostgREST does (F-006).
// - Realtime: /realtime/v1/websocket for supabase-js 2.106 (realtime-js, Phoenix serializer VSN
//   2.0.0: text frames `[join_ref, ref, topic, event, payload]`, binary user broadcasts). It
//   answers heartbeats, replies to phx_join with ids for the channel's postgres_changes bindings
//   (the client checks them in order), fans every write out as a `postgres_changes`
//   UPDATE/INSERT to the channels whose filter is that row's `sync_id=eq.<code>`, and relays
//   Broadcast (binary kind 3 in, kind 4 out; `self: false` keeps it from its sender) and the
//   REST fallback POST /realtime/v1/api/broadcast (202). `disablePostgresChanges()` refuses
//   joins that ask for row events (a table out of the publication); `blockRealtime()` refuses
//   the socket and REST broadcasts (a project that refuses public channels).
//   The RFC 6455 framing is hand-rolled: masked client frames in, unmasked frames out.
// - Static hosting of a build per port with the production CSP plus the relay in connect-src,
//   no caching (one origin can switch builds between page loads: the rollback proof), and the
//   SPA fallback of vercel.json.
//
// Every relay request is logged with its kind, outcome and, for a write, the writer class of
// what was pushed, so specs can bound the traffic each device makes and read what it did.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'

export type WriterClass = 'v5' | 'v085' | 'legacy' | 'other'

export type RequestKind =
  | 'head'
  | 'pull'
  | 'list'
  | 'push'
  | 'insert'
  | 'update'
  | 'rpc'
  | 'broadcast'
  | 'other'

export type RpcName = 'st_sync_head' | 'st_sync_pull' | 'st_sync_push'

export type Outcome =
  | 'ok'
  | 'conflict'
  | 'missing'
  | 'denied'
  | 'no-rpc'
  | 'invalid'
  | 'full'
  | 'refused'

export interface RelayRequest {
  readonly at: number
  readonly method: string
  /**
   * head / pull: a read (`select=updated_at` is a head); list: a read with no sync_id filter;
   * push: an upsert; insert: a create-only POST; update: a PATCH; rpc: a function call (`fn`);
   * broadcast: a `rev` ping (`via`).
   */
  readonly kind: RequestKind
  /** The page origin that made it (one device per origin in this suite). */
  readonly origin: string | null
  readonly syncId: string | null
  /** For a write: who wrote it, read from the payload (`x5` → v5, `wr` → 0.8.5, else legacy). */
  readonly writer: WriterClass | null
  readonly outcome: Outcome
  readonly fn?: RpcName
  /** A PATCH that carried updated_at=eq.<base>, or an RPC push with p_base: the base it sent. */
  readonly base?: string | null
  readonly force?: boolean
  readonly via?: 'ws' | 'http'
  readonly topic?: string
  /** A broadcast's payload (`{rev, dev}`). */
  readonly message?: unknown
}

export interface RelayRow {
  readonly payload: unknown
  /** As PostgREST returns it (µs, `+00:00`). */
  readonly updated_at: string
}

export interface Relay {
  readonly origin: string
  readonly log: readonly RelayRequest[]
  /** The row as the relay holds it, or null. */
  row(syncId: string): RelayRow | null
  /** Writes a row as a client would (seeding or poisoning) and fans it out. */
  put(syncId: string, payload: unknown): void
  /** Deletes a row (pruned, or removed by hand), with no event, as the old prune did. */
  remove(syncId: string): void
  /** Write attempts (upsert, insert, PATCH, st_sync_push) from `origin` (all when omitted). */
  pushes(origin?: string, since?: number): readonly RelayRequest[]
  /** Writes that landed. */
  writes(origin?: string, since?: number): readonly RelayRequest[]
  /** Requests of one kind. */
  requests(kind: RequestKind, origin?: string, since?: number): readonly RelayRequest[]
  /** Open realtime channels listening for row events on this code (0.8.4–0.11.0 all do). */
  channels(syncId: string): number
  /** Open realtime channels on `topic` (without the `realtime:` prefix), any bindings. */
  topicChannels(topic: string): number
  /** The topics of every open channel (the raw code must never be one for 0.11.0). */
  topics(): readonly string[]
  /** 004 applied / rolled back (the rollback throws, 55000, while the table is locked). */
  enableRpc(): void
  disableRpc(): void
  /**
   * 005 applied / rolled back: every table call answers 401 `42501`. The lockdown throws (55000)
   * without 004.
   */
  lockTable(): void
  unlockTable(): void
  /** The table leaves the realtime publication: joins asking for row events are refused. */
  disablePostgresChanges(): void
  enablePostgresChanges(): void
  /**
   * Holds every payload read (table pull, st_sync_pull) until the returned release is called, so
   * two devices can be made to pull the same copy and cross their pushes.
   */
  holdReads(): () => void
  /** Payload reads waiting on a hold. */
  heldReads(): number
  /** Every table and RPC request answers `status` (a failing relay), until `fault(null)`. */
  fault(status: number | null): void
  /** Realtime refused (socket and REST broadcast); open sockets are closed. */
  blockRealtime(): void
  unblockRealtime(): void
  reset(): void
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const TABLE_PATH = '/rest/v1/sync_buckets'
const RPC_PATH = '/rest/v1/rpc/'
const BROADCAST_PATH = '/realtime/v1/api/broadcast'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** st_sync_push: an object payload of at most 1.2 MiB of jsonb text (004). */
const RPC_PAYLOAD_MAX = 1_258_291
/** `sync_buckets_payload_bounded` (004): table writes, at most 2 MiB of jsonb text. */
const TABLE_PAYLOAD_MAX = 2_097_152
/** What Postgres reads as ±infinity (`sync_buckets_updated_at_finite` refuses it). */
const NON_FINITE = /^\s*[+-]?infinity\s*$/i
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':
    'apikey, authorization, content-type, prefer, x-client-info, accept-profile, content-profile, range, x-supabase-api-version, accept',
  'Access-Control-Expose-Headers': 'content-range, x-supabase-api-version',
  'Access-Control-Max-Age': '600',
}

/** PostgREST's answer to anon for a table it may not touch (005). */
const DENIED = {
  code: '42501',
  details: null,
  hint: null,
  message: 'permission denied for table sync_buckets',
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `": "` and `", "` spaces jsonb_out adds to JSON.stringify's compact form. */
function jsonbSpaces(value: unknown): number {
  if (Array.isArray(value)) {
    let n = Math.max(0, value.length - 1)
    for (const item of value) n += jsonbSpaces(item)
    return n
  }
  if (!isRecord(value)) return 0
  const members = Object.values(value).filter(
    (v) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol',
  )
  let n = 2 * members.length - Math.min(1, members.length)
  for (const member of members) n += jsonbSpaces(member)
  return n
}

/**
 * `octet_length(v::jsonb::text)`, what 004 measures: the UTF-8 bytes of JSON.stringify(v) plus
 * one space after every key's colon and after every comma. Outside the model (never in a
 * SpendTrack payload): numbers Postgres prints differently (1e21 and up, small exponents), and
 * `\u0000` or lone surrogates, which jsonb refuses outright.
 */
export function jsonbTextBytes(value: unknown): number {
  const text: string | undefined = JSON.stringify(value)
  if (text === undefined) return 0
  return Buffer.byteLength(text, 'utf8') + jsonbSpaces(value)
}

/** st_sync_push's 22023 message for its arguments, in 004's order, or null when they pass. */
function pushRefusal(row: unknown, payload: unknown): string | null {
  if (typeof row !== 'string' || !UUID.test(row)) return 'invalid row id'
  if (!isRecord(payload)) return 'invalid payload'
  if (jsonbTextBytes(payload) > RPC_PAYLOAD_MAX) return 'payload too large'
  const shaped =
    (Array.isArray(payload.expenses) && isRecord(payload.x5)) ||
    (payload.st === 5 && typeof payload.iv === 'string' && typeof payload.ct === 'string') ||
    (payload.expenses === 'moved' && isRecord(payload.x5))
  return shaped ? null : 'invalid payload shape'
}

/**
 * What a table write leaving this row meets: 001's NOT NULL (23502), then, once 004 is applied,
 * its checks in name order (Postgres tests CHECK constraints alphabetically; 23514).
 */
function rowRefusal(
  syncId: string | null,
  payload: unknown,
  token: unknown,
  checked: boolean,
): { readonly code: string; readonly message: string } | null {
  const column =
    syncId === null ? 'sync_id' : payload === null || payload === undefined ? 'payload' : null
  if (column !== null) {
    return {
      code: '23502',
      message: `null value in column "${column}" of relation "sync_buckets" violates not-null constraint`,
    }
  }
  if (!checked) return null
  const failed = !UUID.test(syncId ?? '')
    ? 'sync_buckets_id_uuid'
    : !isRecord(payload) || jsonbTextBytes(payload) > TABLE_PAYLOAD_MAX
      ? 'sync_buckets_payload_bounded'
      : typeof token === 'string' && NON_FINITE.test(token)
        ? 'sync_buckets_updated_at_finite'
        : null
  if (failed === null) return null
  return {
    code: '23514',
    message: `new row for relation "sync_buckets" violates check constraint "${failed}"`,
  }
}

export function writerOf(payload: unknown): WriterClass {
  if (!isRecord(payload)) return 'other'
  if (isRecord(payload.x5)) return 'v5'
  if (isRecord(payload.wr)) return 'v085'
  return Array.isArray(payload.expenses) ? 'legacy' : 'other'
}

// ─── Timestamps as Postgres keeps them (integer microseconds) ─────────────────────────────────

const TS =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6})\d*)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i

/** A timestamptz literal as µs since the epoch (no zone = UTC), or null. */
export function parseMicros(text: string): number | null {
  const m = TS.exec(text.trim().replace(/ (\d{2}(?::?\d{2})?)$/, '+$1'))
  if (m === null) return null
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (Number.isNaN(ms)) return null
  let offset = 0
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'))
  }
  return (ms - offset * 60_000) * 1000 + Number(frac.padEnd(6, '0'))
}

/** µs as PostgREST prints a timestamptz in JSON: `…T10:00:00.123456+00:00`, zeros trimmed. */
export function formatMicros(us: number): string {
  const ms = Math.floor(us / 1000)
  const base = new Date(ms).toISOString().slice(0, 19)
  const frac = String(us - Math.floor(us / 1_000_000) * 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return `${base}${frac === '' ? '' : `.${frac}`}+00:00`
}

let lastNow = 0
/** The server's clock in µs, strictly increasing (clock_timestamp()). */
function nowMicros(): number {
  const us = Date.now() * 1000 + Math.floor((performance.now() * 1000) % 1000)
  lastNow = Math.max(us, lastNow + 1)
  return lastNow
}

// ─── WebSocket framing (RFC 6455, the subset a browser client needs) ─────────────────────────

interface Frame {
  readonly fin: boolean
  readonly opcode: number
  readonly data: Buffer
}

/** Complete frames at the front of `buf`, and the bytes left for the next chunk. */
function readFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = []
  let at = 0
  for (;;) {
    if (buf.length - at < 2) break
    const b0 = buf.readUInt8(at)
    const b1 = buf.readUInt8(at + 1)
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let head = 2
    if (len === 126) {
      if (buf.length - at < 4) break
      len = buf.readUInt16BE(at + 2)
      head = 4
    } else if (len === 127) {
      if (buf.length - at < 10) break
      len = Number(buf.readBigUInt64BE(at + 2))
      head = 10
    }
    const maskLen = masked ? 4 : 0
    if (buf.length - at < head + maskLen + len) break
    const mask = buf.subarray(at + head, at + head + maskLen)
    const data = Buffer.from(buf.subarray(at + head + maskLen, at + head + maskLen + len))
    if (masked) for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0)
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, data })
    at += head + maskLen + len
  }
  return { frames, rest: buf.subarray(at) }
}

function frame(opcode: number, data: Buffer): Buffer {
  const len = data.length
  let head: Buffer
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head.writeUInt8(0x80 | opcode, 0)
    head.writeUInt8(126, 1)
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head.writeUInt8(0x80 | opcode, 0)
    head.writeUInt8(127, 1)
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, data])
}

// ─── Realtime (Phoenix VSN 2.0.0) ────────────────────────────────────────────────────────────

type PhoenixMessage = [string | null, string | null, string, string, unknown]

interface Binding {
  readonly id: number
  readonly event: string
  readonly schema: string
  readonly table: string
  readonly filter: string | undefined
}

interface Channel {
  readonly socket: Duplex
  readonly topic: string
  readonly joinRef: string | null
  readonly bindings: readonly Binding[]
  /** config.broadcast.self: the sender hears its own broadcasts. */
  readonly self: boolean
}

function send(socket: Duplex, msg: PhoenixMessage): void {
  if (!socket.writable) return
  socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))))
}

const reply = (msg: PhoenixMessage, response: unknown, status = 'ok'): PhoenixMessage => [
  msg[0],
  msg[1],
  msg[2],
  'phx_reply',
  { status, response },
]

/** realtime-js Serializer kind 3 (userBroadcastPush): what `channel.send` writes. */
function decodeBroadcastPush(
  data: Buffer,
): { topic: string; event: string; payload: unknown } | null {
  if (data.length < 7 || data.readUInt8(0) !== 3) return null
  const joinRefLen = data.readUInt8(1)
  const refLen = data.readUInt8(2)
  const topicLen = data.readUInt8(3)
  const eventLen = data.readUInt8(4)
  const metaLen = data.readUInt8(5)
  const encoding = data.readUInt8(6)
  let at = 7 + joinRefLen + refLen
  const topic = data.subarray(at, at + topicLen).toString('utf8')
  at += topicLen
  const event = data.subarray(at, at + eventLen).toString('utf8')
  at += eventLen + metaLen
  const body = data.subarray(at)
  let payload: unknown = body
  if (encoding === 1) {
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return null
    }
  }
  return { topic, event, payload }
}

/** realtime-js Serializer kind 4 (userBroadcast): what a subscriber decodes, JSON payload. */
function encodeBroadcast(topic: string, event: string, payload: unknown): Buffer {
  const t = Buffer.from(topic, 'utf8')
  const e = Buffer.from(event, 'utf8')
  const head = Buffer.from([4, t.length, e.length, 0, 1])
  return Buffer.concat([head, t, e, Buffer.from(JSON.stringify(payload ?? {}), 'utf8')])
}

// ─── The relay ───────────────────────────────────────────────────────────────────────────────

interface StoredRow {
  readonly payload: unknown
  readonly us: number
}

const asRow = (r: StoredRow): RelayRow => ({ payload: r.payload, updated_at: formatMicros(r.us) })

export async function startRelay(port = 4219): Promise<Relay> {
  const rows = new Map<string, StoredRow>()
  const log: RelayRequest[] = []
  let channels: Channel[] = []
  let nextBindingId = 1000
  const sockets = new Set<Duplex>()
  const socketOrigin = new Map<Duplex, string | null>()
  let rpc = false
  let locked = false
  let rowEvents = true
  let realtime = true
  let hold: Promise<void> | null = null
  /** Lets every read waiting on the hold go (a reset or close never leaves one hanging). */
  let releaseHold = (): void => undefined
  let waiting = 0
  let faultStatus: number | null = null
  /** A payload read waits here while a hold is on. */
  const gate = async (): Promise<void> => {
    if (hold === null) return
    waiting++
    try {
      await hold
    } finally {
      waiting--
    }
  }

  const note = (r: Omit<RelayRequest, 'at'>): void => {
    log.push({ at: Date.now(), ...r })
  }

  const fanOut = (syncId: string, row: StoredRow, existed: boolean) => {
    if (!rowEvents) return
    const record = { sync_id: syncId, payload: row.payload, updated_at: formatMicros(row.us) }
    for (const ch of channels) {
      const ids = ch.bindings
        .filter(
          (b) => b.table === 'sync_buckets' && (!b.filter || b.filter === `sync_id=eq.${syncId}`),
        )
        .map((b) => b.id)
      if (ids.length === 0) continue
      send(ch.socket, [
        ch.joinRef,
        null,
        ch.topic,
        'postgres_changes',
        {
          ids,
          data: {
            schema: 'public',
            table: 'sync_buckets',
            commit_timestamp: record.updated_at,
            type: existed ? 'UPDATE' : 'INSERT',
            record,
            old_record: existed ? { sync_id: syncId } : {},
            columns: [],
            errors: null,
          },
        },
      ])
    }
  }

  const write = (syncId: string, payload: unknown, us: number): StoredRow => {
    const existed = rows.has(syncId)
    const row: StoredRow = { payload, us }
    rows.set(syncId, row)
    fanOut(syncId, row, existed)
    return row
  }

  /** A broadcast to every channel on `topic` (`realtime:<name>`), but its sender's unless self. */
  const relayBroadcast = (topic: string, event: string, payload: unknown, from: Duplex | null) => {
    for (const ch of channels) {
      if (ch.topic !== topic) continue
      if (ch.socket === from && !ch.self) continue
      if (ch.socket.writable) ch.socket.write(frame(0x2, encodeBroadcast(topic, event, payload)))
    }
  }

  const onPhoenix = (socket: Duplex, text: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || parsed.length !== 5) return
    const parts: unknown[] = parsed
    const [rawJoinRef, rawRef, rawTopic, rawEvent, payload] = parts
    const orNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const joinRef = orNull(rawJoinRef)
    const ref = orNull(rawRef)
    const topic = orNull(rawTopic) ?? ''
    const event = orNull(rawEvent) ?? ''
    const msg: PhoenixMessage = [joinRef, ref, topic, event, payload]
    if (topic === 'phoenix' && event === 'heartbeat') {
      send(socket, reply(msg, {}))
      return
    }
    if (event === 'phx_join') {
      const config = isRecord(payload) && isRecord(payload.config) ? payload.config : {}
      const wanted = Array.isArray(config.postgres_changes) ? config.postgres_changes : []
      if (!rowEvents && wanted.length > 0) {
        // the table is out of the publication (005): realtime refuses the row events
        send(
          socket,
          reply(msg, { reason: 'Unable to subscribe to changes with given parameters' }, 'error'),
        )
        return
      }
      const bindings: Binding[] = wanted.filter(isRecord).map((b) => ({
        id: nextBindingId++,
        event: typeof b.event === 'string' ? b.event : '*',
        schema: typeof b.schema === 'string' ? b.schema : 'public',
        table: typeof b.table === 'string' ? b.table : '',
        filter: typeof b.filter === 'string' ? b.filter : undefined,
      }))
      const broadcast = isRecord(config.broadcast) ? config.broadcast : {}
      channels = channels.filter((c) => !(c.socket === socket && c.topic === topic))
      channels.push({ socket, topic, joinRef, bindings, self: broadcast.self === true })
      send(socket, reply(msg, { postgres_changes: bindings }))
      if (bindings.length > 0) {
        send(socket, [
          joinRef,
          null,
          topic,
          'system',
          {
            channel: topic.replace(/^realtime:/, ''),
            extension: 'postgres_changes',
            message: 'Subscribed to PostgreSQL',
            status: 'ok',
          },
        ])
      }
      return
    }
    if (event === 'phx_leave') {
      channels = channels.filter((c) => !(c.socket === socket && c.topic === topic))
      send(socket, reply(msg, {}))
      send(socket, [joinRef, ref, topic, 'phx_close', {}])
      return
    }
    if (event === 'broadcast' && isRecord(payload) && typeof payload.event === 'string') {
      // the JSON form (VSN 1.0.0 clients)
      note({
        method: 'WS',
        kind: 'broadcast',
        origin: socketOrigin.get(socket) ?? null,
        syncId: null,
        writer: null,
        outcome: 'ok',
        via: 'ws',
        topic: topic.replace(/^realtime:/, ''),
        message: payload.payload,
      })
      relayBroadcast(topic, payload.event, payload.payload, socket)
    }
    // access_token, presence and the rest: acknowledged, otherwise ignored.
    if (ref !== null) send(socket, reply(msg, {}))
  }

  const onBinary = (socket: Duplex, data: Buffer) => {
    const push = decodeBroadcastPush(data)
    if (push === null) return
    note({
      method: 'WS',
      kind: 'broadcast',
      origin: socketOrigin.get(socket) ?? null,
      syncId: null,
      writer: null,
      outcome: 'ok',
      via: 'ws',
      topic: push.topic.replace(/^realtime:/, ''),
      message: push.payload,
    })
    relayBroadcast(push.topic, push.event, push.payload, socket)
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    const key = req.headers['sec-websocket-key']
    if (!realtime || url.pathname !== '/realtime/v1/websocket' || typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)
    socketOrigin.set(socket, typeof req.headers.origin === 'string' ? req.headers.origin : null)
    let pending: Buffer = Buffer.alloc(0)
    let message: Buffer[] = []
    let binary = false
    const drop = () => {
      sockets.delete(socket)
      socketOrigin.delete(socket)
      channels = channels.filter((c) => c.socket !== socket)
    }
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]))
      pending = rest
      for (const f of frames) {
        if (f.opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)))
          drop()
          return
        }
        if (f.opcode === 0x9) {
          socket.write(frame(0xa, f.data))
          continue
        }
        if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
          if (f.opcode !== 0x0) binary = f.opcode === 0x2
          message.push(f.data)
          if (!f.fin) continue
          const data = Buffer.concat(message)
          message = []
          if (binary) onBinary(socket, data)
          else onPhoenix(socket, data.toString('utf8'))
        }
      }
    })
    socket.on('close', drop)
    socket.on('error', drop)
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', reject)
    })

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  /** The `eq.` value of a PostgREST filter; `+` read back if a client sent it unencoded. */
  const eqOf = (url: URL, column: string): string | null => {
    const raw = url.searchParams.get(column)
    if (raw === null || !raw.startsWith('eq.')) return null
    return raw.slice(3).replace(/ (\d{2}:?\d{2})$/, '+$1')
  }

  const columnsOf = (url: URL): string[] =>
    (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim())

  const pick = (columns: readonly string[], id: string, r: StoredRow): Record<string, unknown> => {
    const full: Record<string, unknown> = {
      sync_id: id,
      payload: r.payload,
      updated_at: formatMicros(r.us),
    }
    if (columns.includes('*')) return full
    return Object.fromEntries(columns.filter((c) => c in full).map((c) => [c, full[c]]))
  }

  /** `return=representation` rows, as an object for `.single()` (406 unless exactly one). */
  const represent = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    list: readonly Record<string, unknown>[],
  ) => {
    const prefer = String(req.headers.prefer ?? '')
    const accept = String(req.headers.accept ?? '')
    if (accept.includes('application/vnd.pgrst.object+json')) {
      const only = list[0]
      if (list.length !== 1 || only === undefined) {
        json(res, 406, {
          code: 'PGRST116',
          details: `The result contains ${String(list.length)} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        })
        return
      }
      json(res, status, only)
      return
    }
    if (prefer.includes('return=representation')) json(res, status, list)
    else json(res, status === 200 ? 204 : status, undefined)
  }

  const onTable = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    origin: string | null,
    method: string,
  ) => {
    const syncId = eqOf(url, 'sync_id')
    const columns = columnsOf(url)
    if (method === 'GET' || method === 'HEAD') {
      const kind: RequestKind =
        syncId === null
          ? 'list'
          : columns.length === 1 && columns[0] === 'updated_at'
            ? 'head'
            : 'pull'
      if (locked) {
        note({ method, kind, origin, syncId, writer: null, outcome: 'denied' })
        json(res, 401, DENIED)
        return
      }
      if (kind === 'list') {
        // no filter: every row, as PostgREST answers anon while it may SELECT (F-006)
        const limit = Number(url.searchParams.get('limit') ?? Infinity)
        const all = [...rows].slice(0, Number.isNaN(limit) ? Infinity : limit)
        note({ method, kind, origin, syncId, writer: null, outcome: 'ok' })
        json(
          res,
          200,
          all.map(([id, r]) => pick(columns, id, r)),
        )
        return
      }
      if (kind === 'pull') await gate()
      const row = syncId === null ? undefined : rows.get(syncId)
      note({ method, kind, origin, syncId, writer: null, outcome: row ? 'ok' : 'missing' })
      const list = row === undefined || syncId === null ? [] : [pick(columns, syncId, row)]
      // a read is an array (`.maybeSingle()` takes its first row), an object only for `.single()`
      if (String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json'))
        represent(req, res, 200, list)
      else json(res, 200, list)
      return
    }
    if (method !== 'POST' && method !== 'PATCH') {
      json(res, 405, { message: 'Method not allowed' })
      return
    }
    const text = await readBody(req)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      json(res, 400, { code: 'PGRST102', message: 'Invalid JSON' })
      return
    }
    const prefer = String(req.headers.prefer ?? '')
    if (method === 'PATCH') {
      const base = eqOf(url, 'updated_at')
      const item = isRecord(body) ? body : {}
      const writer = writerOf(item.payload)
      if (locked) {
        note({ method, kind: 'update', origin, syncId, writer, outcome: 'denied', base })
        json(res, 401, DENIED)
        return
      }
      const row = syncId === null ? undefined : rows.get(syncId)
      const baseUs = base === null ? null : parseMicros(base)
      const matches = row !== undefined && (base === null || (baseUs !== null && row.us === baseUs))
      // an UPDATE that matches no row checks nothing; one that does checks the row it leaves
      const payload = row !== undefined && !('payload' in item) ? row.payload : item.payload
      const refused = matches ? rowRefusal(syncId, payload, item.updated_at, rpc) : null
      const outcome: Outcome =
        row === undefined ? 'missing' : !matches ? 'conflict' : refused ? 'invalid' : 'ok'
      note({ method, kind: 'update', origin, syncId, writer, outcome, base })
      if (refused !== null) {
        json(res, 400, { ...refused, details: null, hint: null })
        return
      }
      if (!matches || syncId === null || row === undefined) {
        represent(req, res, 200, [])
        return
      }
      const sent = typeof item.updated_at === 'string' ? parseMicros(item.updated_at) : null
      const stored = write(syncId, payload, sent ?? row.us)
      represent(req, res, 200, [pick(columns, syncId, stored)])
      return
    }
    // POST: an upsert with merge-duplicates, else an insert. One statement: every row passes its
    // checks (NOT NULL and 004's CHECKs, then the primary key for an insert) or nothing is written.
    const upsert = prefer.includes('resolution=merge-duplicates')
    const kind: RequestKind = upsert ? 'push' : 'insert'
    const items = (Array.isArray(body) ? body : [body]).filter(isRecord)
    for (const item of items) {
      const id = typeof item.sync_id === 'string' ? item.sync_id : null
      const writer = writerOf(item.payload)
      if (locked) {
        note({ method, kind, origin, syncId: id, writer, outcome: 'denied' })
        json(res, 401, DENIED)
        return
      }
      const refused = rowRefusal(id, item.payload, item.updated_at, rpc)
      if (refused !== null) {
        note({ method, kind, origin, syncId: id, writer, outcome: 'invalid' })
        json(res, 400, { ...refused, details: null, hint: null })
        return
      }
      if (!upsert && id !== null && rows.has(id)) {
        note({ method, kind, origin, syncId: id, writer, outcome: 'conflict' })
        json(res, 409, {
          code: '23505',
          details: `Key (sync_id)=(${id}) already exists.`,
          hint: null,
          message: 'duplicate key value violates unique constraint "sync_buckets_pkey"',
        })
        return
      }
    }
    const out: Record<string, unknown>[] = []
    for (const item of items) {
      if (typeof item.sync_id !== 'string') continue
      note({
        method,
        kind,
        origin,
        syncId: item.sync_id,
        writer: writerOf(item.payload),
        outcome: 'ok',
      })
      const sent = typeof item.updated_at === 'string' ? parseMicros(item.updated_at) : null
      out.push(pick(columns, item.sync_id, write(item.sync_id, item.payload, sent ?? nowMicros())))
    }
    represent(req, res, 201, out)
  }

  const onRpc = async (
    req: IncomingMessage,
    res: ServerResponse,
    fn: string,
    origin: string | null,
  ) => {
    const text = await readBody(req)
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text === '' ? '{}' : text)
      if (isRecord(parsed)) args = parsed
    } catch {
      json(res, 400, { code: 'PGRST102', message: 'Invalid JSON' })
      return
    }
    const name: RpcName | null =
      fn === 'st_sync_head' || fn === 'st_sync_pull' || fn === 'st_sync_push' ? fn : null
    const syncId = typeof args.p_row === 'string' ? args.p_row : null
    const writer = name === 'st_sync_push' ? writerOf(args.p_payload) : null
    if (!rpc || name === null) {
      note({
        method: 'POST',
        kind: 'rpc',
        origin,
        syncId,
        writer,
        outcome: 'no-rpc',
        ...(name === null ? {} : { fn: name }),
      })
      json(res, 404, {
        code: 'PGRST202',
        details: `Searched for the function public.${fn} with parameter p_row, but no matches were found in the schema cache.`,
        hint: null,
        message: `Could not find the function public.${fn}(p_row) in the schema cache`,
      })
      return
    }
    // head and pull look up lower-case UUIDs only (004: NULL for any other id)
    const row = syncId === null || !UUID.test(syncId) ? undefined : rows.get(syncId)
    if (name === 'st_sync_head') {
      note({
        method: 'POST',
        kind: 'rpc',
        fn: name,
        origin,
        syncId,
        writer,
        outcome: row ? 'ok' : 'missing',
      })
      json(res, 200, row === undefined ? null : formatMicros(row.us))
      return
    }
    if (name === 'st_sync_pull') {
      await gate()
      note({
        method: 'POST',
        kind: 'rpc',
        fn: name,
        origin,
        syncId,
        writer,
        outcome: row ? 'ok' : 'missing',
      })
      json(
        res,
        200,
        row === undefined
          ? null
          : {
              payload: row.payload,
              updated_at: formatMicros(row.us),
              now: formatMicros(nowMicros()),
            },
      )
      return
    }
    // st_sync_push(p_row, p_payload, p_base, p_force)
    const payload = args.p_payload
    const base = typeof args.p_base === 'string' ? args.p_base : null
    const force = args.p_force === true
    const invalid = pushRefusal(args.p_row, payload)
    if (invalid !== null || syncId === null) {
      note({
        method: 'POST',
        kind: 'rpc',
        fn: name,
        origin,
        syncId,
        writer,
        outcome: 'invalid',
        base,
        force,
      })
      json(res, 400, {
        code: '22023',
        details: null,
        hint: null,
        message: invalid ?? 'invalid row id',
      })
      return
    }
    // A write's token is GREATEST(clock_timestamp(), current + 1 µs): it never repeats or goes
    // back, also over a row a skewed writer dated far ahead.
    const now = nowMicros()
    let landed: StoredRow | null = null
    if (force) {
      if (row !== undefined) landed = write(syncId, payload, Math.max(now, row.us + 1))
    } else if (base === null) {
      if (row === undefined) landed = write(syncId, payload, now)
    } else {
      const baseUs = parseMicros(base)
      if (row !== undefined && baseUs !== null && row.us === baseUs) {
        landed = write(syncId, payload, Math.max(now, row.us + 1))
      }
    }
    if (landed !== null) {
      note({
        method: 'POST',
        kind: 'rpc',
        fn: name,
        origin,
        syncId,
        writer,
        outcome: 'ok',
        base,
        force,
      })
      json(res, 200, { ok: true, updated_at: formatMicros(landed.us) })
      return
    }
    const current = rows.get(syncId)
    const reason = current === undefined ? 'missing' : 'conflict'
    note({
      method: 'POST',
      kind: 'rpc',
      fn: name,
      origin,
      syncId,
      writer,
      outcome: reason,
      base,
      force,
    })
    json(res, 200, {
      ok: false,
      reason,
      updated_at: current === undefined ? null : formatMicros(current.us),
    })
  }

  const onHttpBroadcast = async (
    req: IncomingMessage,
    res: ServerResponse,
    origin: string | null,
  ) => {
    const text = await readBody(req)
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // answered below
    }
    const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
    for (const m of messages.filter(isRecord)) {
      const topic = typeof m.topic === 'string' ? m.topic : ''
      note({
        method: 'POST',
        kind: 'broadcast',
        origin,
        syncId: null,
        writer: null,
        outcome: realtime ? 'ok' : 'refused',
        via: 'http',
        topic,
        message: m.payload,
      })
      if (realtime && typeof m.event === 'string')
        relayBroadcast(`realtime:${topic}`, m.event, m.payload, null)
    }
    if (!realtime) {
      json(res, 403, { message: 'Realtime is not enabled for this project' })
      return
    }
    res.writeHead(202, CORS)
    res.end()
  }

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (
      faultStatus !== null &&
      (url.pathname === TABLE_PATH || url.pathname.startsWith(RPC_PATH))
    ) {
      note({ method, kind: 'other', origin, syncId: null, writer: null, outcome: 'refused' })
      json(res, faultStatus, { code: 'XX000', details: null, hint: null, message: 'e2e fault' })
      return
    }
    if (url.pathname === TABLE_PATH) {
      await onTable(req, res, url, origin, method)
      return
    }
    if (url.pathname.startsWith(RPC_PATH) && method === 'POST') {
      await onRpc(req, res, url.pathname.slice(RPC_PATH.length), origin)
      return
    }
    if (url.pathname === BROADCAST_PATH && method === 'POST') {
      await onHttpBroadcast(req, res, origin)
      return
    }
    note({ method, kind: 'other', origin, syncId: null, writer: null, outcome: 'missing' })
    json(res, 404, { code: 'PGRST202', message: `No route ${url.pathname} on the e2e relay` })
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { message: 'relay error' })
    })
  })
  server.on('upgrade', onUpgrade)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', () => {
      resolve()
    })
  })
  // port 0: the system picked a free one
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port

  const WRITE_KINDS: ReadonlySet<RequestKind> = new Set(['push', 'insert', 'update'])
  const isWrite = (r: RelayRequest): boolean =>
    WRITE_KINDS.has(r.kind) || (r.kind === 'rpc' && r.fn === 'st_sync_push')
  const within = (r: RelayRequest, origin: string | undefined, since: number): boolean =>
    r.at >= since && (origin === undefined || r.origin === origin)

  return {
    origin: `http://localhost:${String(bound)}`,
    log,
    row: (syncId) => {
      const r = rows.get(syncId)
      return r === undefined ? null : asRow(r)
    },
    put: (syncId, payload) => {
      write(syncId, payload, nowMicros())
    },
    remove: (syncId) => {
      rows.delete(syncId)
    },
    pushes: (origin, since = 0) => log.filter((r) => isWrite(r) && within(r, origin, since)),
    writes: (origin, since = 0) =>
      log.filter((r) => isWrite(r) && r.outcome === 'ok' && within(r, origin, since)),
    requests: (kind, origin, since = 0) =>
      log.filter((r) => r.kind === kind && within(r, origin, since)),
    channels: (syncId) =>
      channels.filter((c) => c.bindings.some((b) => b.filter === `sync_id=eq.${syncId}`)).length,
    topicChannels: (topic) => channels.filter((c) => c.topic === `realtime:${topic}`).length,
    topics: () => channels.map((c) => c.topic.replace(/^realtime:/, '')),
    enableRpc: () => {
      rpc = true
    },
    disableRpc: () => {
      if (locked) {
        throw new Error(
          '55000 SpendTrack 004 rollback: the lockdown (005) is applied. Roll back 005 first (005_sync_lockdown.rollback.sql), or keep 004. Nothing was changed.',
        )
      }
      rpc = false
    },
    lockTable: () => {
      if (!rpc) {
        throw new Error(
          '55000 SpendTrack 005: the sync functions from 004 are missing or not as 004 made them. Apply 004 and run 004_verify.sql first. Nothing was changed.',
        )
      }
      locked = true
    },
    unlockTable: () => {
      locked = false
    },
    disablePostgresChanges: () => {
      rowEvents = false
      // the joined row-event channels error out; their rejoins are refused
      for (const ch of channels.filter((c) => c.bindings.length > 0)) {
        send(ch.socket, [ch.joinRef, null, ch.topic, 'phx_error', {}])
      }
      channels = channels.filter((c) => c.bindings.length === 0)
    },
    enablePostgresChanges: () => {
      rowEvents = true
    },
    holdReads: () => {
      let release = (): void => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      hold = held
      releaseHold = release
      return () => {
        if (hold === held) hold = null
        release()
      }
    },
    heldReads: () => waiting,
    fault: (status) => {
      faultStatus = status
    },
    blockRealtime: () => {
      realtime = false
      for (const s of sockets) s.destroy()
      sockets.clear()
      channels = []
    },
    unblockRealtime: () => {
      realtime = true
    },
    reset: () => {
      rows.clear()
      log.length = 0
      rpc = false
      locked = false
      rowEvents = true
      realtime = true
      hold = null
      releaseHold()
      faultStatus = null
    },
    // Every connection goes, also a request still in flight (a held read, a browser's fetch):
    // server.close() alone waits for them, and a spec's afterAll that waits on it can outlast the
    // worker's stop deadline (the worker is then force-killed and the run fails).
    close: async () => {
      hold = null
      releaseHold()
      for (const s of sockets) s.destroy()
      sockets.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

// ─── Static hosting of a build ───────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export interface BuildToServe {
  /** The build's dist folder. */
  readonly dir: string
  /** Its production CSP with the relay added to connect-src (scripts/build-mixed.mjs writes it). */
  readonly csp: string
}

export interface StaticHost {
  readonly origin: string
  /** Serves another build from now on (the next page load gets it). */
  serve(build: BuildToServe): void
  close(): Promise<void>
}

export async function serveBuild(port: number, initial: BuildToServe): Promise<StaticHost> {
  let current = initial
  const server = createServer((req, res) => {
    const build = current
    const url = new URL(req.url ?? '/', 'http://host')
    const headers = {
      'Content-Security-Policy': build.csp,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    }
    const path = decodeURIComponent(url.pathname)
    const asset = path.startsWith('/assets/') || path.startsWith('/fonts/') || extname(path) !== ''
    const file = normalize(join(build.dir, asset ? path : '/index.html'))
    if (!file.startsWith(normalize(build.dir) + sep) && file !== normalize(build.dir)) {
      res.writeHead(403, headers)
      res.end()
      return
    }
    readFile(file).then(
      (body) => {
        res.writeHead(200, {
          ...headers,
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        })
        res.end(body)
      },
      () => {
        res.writeHead(404, headers)
        res.end('Not found')
      },
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', () => {
      resolve()
    })
  })
  return {
    origin: `http://localhost:${String(port)}`,
    serve: (build) => {
      current = build
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}
