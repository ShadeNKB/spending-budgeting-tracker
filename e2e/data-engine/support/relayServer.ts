// A fake sync relay for the data-engine e2e suite: the two Supabase endpoints SpendTrack uses,
// in one node:http process, with no dependency.
//
// - PostgREST: GET /rest/v1/sync_buckets?select=…&sync_id=eq.<code> (pull) and POST with
//   Prefer: resolution=merge-duplicates (plain upsert, last write wins as on the real table).
// - Realtime: /realtime/v1/websocket for supabase-js 2.106 (realtime-js, Phoenix serializer VSN
//   2.0.0: text frames `[join_ref, ref, topic, event, payload]`). It answers heartbeats, replies
//   to phx_join with ids for the channel's postgres_changes bindings (the client checks them in
//   order), and fans every write out as a `postgres_changes` UPDATE/INSERT to the channels whose
//   filter is that row's `sync_id=eq.<code>`. `columns: []` keeps the record as sent (jsonb).
//   The RFC 6455 framing is hand-rolled: masked client frames in, unmasked text frames out.
// - Static hosting of a build per port with the production CSP plus the relay in connect-src,
//   no caching (one origin can switch builds between page loads: the rollback proof), and the
//   SPA fallback of vercel.json.
//
// Every relay request is logged with the writer class of what was pushed, so specs can bound
// the traffic each device makes.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'

export type WriterClass = 'v5' | 'v085' | 'legacy' | 'other'

export interface RelayRequest {
  readonly at: number
  readonly method: string
  readonly kind: 'pull' | 'push' | 'other'
  /** The page origin that made it (one device per origin in this suite). */
  readonly origin: string | null
  readonly syncId: string | null
  /** For a push: who wrote it, read from the payload (`x5` → v5, `wr` → 0.8.5, else legacy). */
  readonly writer: WriterClass | null
}

export interface RelayRow {
  readonly payload: unknown
  readonly updated_at: string
}

export interface Relay {
  readonly origin: string
  readonly log: readonly RelayRequest[]
  /** The row as the relay holds it, or null. */
  row(syncId: string): RelayRow | null
  /** Writes a row as a client would (seeding or poisoning) and fans it out. */
  put(syncId: string, payload: unknown): void
  /** Pushes made from `origin` (all origins when omitted), optionally since `since`. */
  pushes(origin?: string, since?: number): readonly RelayRequest[]
  /** Open realtime channels, for waiting until both devices listen. */
  channels(syncId: string): number
  reset(): void
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const TABLE_PATH = '/rest/v1/sync_buckets'
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':
    'apikey, authorization, content-type, prefer, x-client-info, accept-profile, content-profile, range, x-supabase-api-version',
  'Access-Control-Expose-Headers': 'content-range, x-supabase-api-version',
  'Access-Control-Max-Age': '600',
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function writerOf(payload: unknown): WriterClass {
  if (!isRecord(payload)) return 'other'
  if (isRecord(payload.x5)) return 'v5'
  if (isRecord(payload.wr)) return 'v085'
  return Array.isArray(payload.expenses) ? 'legacy' : 'other'
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
}

function send(socket: Duplex, msg: PhoenixMessage): void {
  if (!socket.writable) return
  socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))))
}

const reply = (msg: PhoenixMessage, response: unknown): PhoenixMessage => [
  msg[0],
  msg[1],
  msg[2],
  'phx_reply',
  { status: 'ok', response },
]

// ─── The relay ───────────────────────────────────────────────────────────────────────────────

export async function startRelay(port = 4219): Promise<Relay> {
  const rows = new Map<string, RelayRow>()
  const log: RelayRequest[] = []
  let channels: Channel[] = []
  let nextBindingId = 1000
  const sockets = new Set<Duplex>()

  const fanOut = (syncId: string, row: RelayRow, existed: boolean) => {
    const record = { sync_id: syncId, payload: row.payload, updated_at: row.updated_at }
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
            commit_timestamp: row.updated_at,
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

  const write = (syncId: string, payload: unknown, updatedAt: string) => {
    const existed = rows.has(syncId)
    const row: RelayRow = { payload, updated_at: updatedAt }
    rows.set(syncId, row)
    fanOut(syncId, row, existed)
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
      const bindings: Binding[] = wanted.filter(isRecord).map((b) => ({
        id: nextBindingId++,
        event: typeof b.event === 'string' ? b.event : '*',
        schema: typeof b.schema === 'string' ? b.schema : 'public',
        table: typeof b.table === 'string' ? b.table : '',
        filter: typeof b.filter === 'string' ? b.filter : undefined,
      }))
      channels = channels.filter((c) => !(c.socket === socket && c.topic === topic))
      channels.push({ socket, topic, joinRef, bindings })
      send(socket, reply(msg, { postgres_changes: bindings }))
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
      return
    }
    if (event === 'phx_leave') {
      channels = channels.filter((c) => !(c.socket === socket && c.topic === topic))
      send(socket, reply(msg, {}))
      send(socket, [joinRef, ref, topic, 'phx_close', {}])
      return
    }
    // access_token, broadcast, presence: acknowledged, otherwise ignored.
    if (ref !== null) send(socket, reply(msg, {}))
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    const key = req.headers['sec-websocket-key']
    if (url.pathname !== '/realtime/v1/websocket' || typeof key !== 'string') {
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
    let pending: Buffer = Buffer.alloc(0)
    let message: Buffer[] = []
    const drop = () => {
      sockets.delete(socket)
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
          message.push(f.data)
          if (!f.fin) continue
          const text = Buffer.concat(message).toString('utf8')
          message = []
          onPhoenix(socket, text)
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

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (url.pathname !== TABLE_PATH) {
      log.push({ at: Date.now(), method, kind: 'other', origin, syncId: null, writer: null })
      json(res, 404, { code: 'PGRST202', message: `No route ${url.pathname} on the e2e relay` })
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      const eq = url.searchParams.get('sync_id') ?? ''
      const syncId = eq.startsWith('eq.') ? eq.slice(3) : null
      log.push({ at: Date.now(), method, kind: 'pull', origin, syncId, writer: null })
      const row = syncId === null ? undefined : rows.get(syncId)
      const columns = (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim())
      const pick = (r: RelayRow, id: string): Record<string, unknown> => {
        const full: Record<string, unknown> = {
          sync_id: id,
          payload: r.payload,
          updated_at: r.updated_at,
        }
        if (columns.includes('*')) return full
        return Object.fromEntries(columns.filter((c) => c in full).map((c) => [c, full[c]]))
      }
      json(res, 200, row === undefined || syncId === null ? [] : [pick(row, syncId)])
      return
    }
    if (method === 'POST' || method === 'PATCH') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        json(res, 400, { code: 'PGRST102', message: 'Invalid JSON' })
        return
      }
      const items = (Array.isArray(body) ? body : [body]).filter(isRecord)
      for (const item of items) {
        const syncId = typeof item.sync_id === 'string' ? item.sync_id : null
        log.push({
          at: Date.now(),
          method,
          kind: 'push',
          origin,
          syncId,
          writer: writerOf(item.payload),
        })
        if (syncId === null) continue
        const updatedAt =
          typeof item.updated_at === 'string' ? item.updated_at : new Date().toISOString()
        write(syncId, item.payload, updatedAt)
      }
      const prefer = String(req.headers.prefer ?? '')
      if (prefer.includes('return=representation')) json(res, 201, items)
      else json(res, 201, undefined)
      return
    }
    json(res, 405, { message: 'Method not allowed' })
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

  return {
    origin: `http://localhost:${String(port)}`,
    log,
    row: (syncId) => rows.get(syncId) ?? null,
    put: (syncId, payload) => {
      write(syncId, payload, new Date().toISOString())
    },
    pushes: (origin, since = 0) =>
      log.filter(
        (r) => r.kind === 'push' && r.at >= since && (origin === undefined || r.origin === origin),
      ),
    channels: (syncId) =>
      channels.filter((c) => c.bindings.some((b) => b.filter === `sync_id=eq.${syncId}`)).length,
    reset: () => {
      rows.clear()
      log.length = 0
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
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
