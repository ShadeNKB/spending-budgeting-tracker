// A single relay row (public.sync_buckets) on a virtual network: request/response latency, drops,
// lost responses and reordering, optional CAS on updated_at, realtime fan-out to every subscriber
// including the writer (self-echo), as postgres_changes does, and Broadcast (`rev` pings between
// 0.11.0 devices, never back to the sender: `self: false`). Requests are counted by kind, so a test
// can tell a HEAD-only idle minute from a pull.
import type { RelayPort } from '../legacy/v084'
import type { RelayPort085 } from '../legacy/v085'
import { makeRng, type Rng } from '../support/rng'
import type { VirtualClock } from './clock'

export interface NetOptions {
  /** Conditional PATCH on updated_at (§11.1); off = plain upsert, as today. */
  readonly cas: boolean
  readonly latency: readonly [number, number]
  /** Probability a request never reaches the relay. */
  readonly drop: number
  /** Probability the relay applies a request but its response is lost. */
  readonly lostResponse: number
  /** Probability a realtime event is not delivered. */
  readonly eventDrop: number
  /** Probability of an extra 1–4 s delay (reordering). */
  readonly spike: number
  /**
   * Probability, per device and minute, that its realtime socket drops and rejoins 2–12 s later
   * (iOS suspends a PWA's socket). Events in between are lost, as on the real channel.
   */
  readonly socketDrop: number
}

export const CALM: NetOptions = {
  cas: true,
  latency: [50, 800],
  drop: 0,
  lostResponse: 0,
  eventDrop: 0,
  spike: 0,
  socketDrop: 0,
}
export const FLAKY: NetOptions = {
  cas: true,
  latency: [50, 800],
  drop: 0.08,
  lostResponse: 0.05,
  eventDrop: 0.15,
  spike: 0.1,
  socketDrop: 0.1,
}

/** A fetch that never answers fails after this long (§11.8). */
export const TIMEOUT = 15_000

export interface Pulled {
  readonly payload: unknown
  readonly etag: string
}
export type PushResult =
  | { readonly ok: true; readonly etag: string }
  | { readonly ok: false; readonly reason: 'conflict' | 'missing' }

export interface RowEvent {
  readonly payload: unknown
  readonly updatedAt: string
}

/** A Broadcast `rev` ping (§11.2): who landed which push. It carries no payload. */
export interface BroadcastMsg {
  readonly rev: string
  readonly dev: string
}

export class NetworkError extends Error {
  constructor() {
    super('network')
    this.name = 'NetworkError'
  }
}

export class Relay {
  /** The row as Postgres stores it (a JSON string), or null when missing. */
  row: string | null = null
  /** Scripted fault: the next v5 push request is dropped (never reaches the relay). */
  dropNextPush = false
  /** Scripted fault: the next v5 push is applied but its response is lost. */
  loseNextPushResponse = false
  /** Scripted fault: this many conditional (unforced) v5 writes are refused as conflicts. */
  casConflicts = 0
  /** Conditional writes refused, by device. */
  readonly conflictsBy = new Map<string, number>()
  /**
   * Realtime as the project allows it: `postgres_changes` (off after 005, or a blocked socket)
   * and Broadcast (off when public channels are refused). Set before devices start.
   */
  rowEvents = true
  broadcast = true
  etag = 0
  writes = 0
  /** Requests that reached the relay, by kind (HEAD, pull, Broadcast sent). */
  heads = 0
  pulls = 0
  broadcasts = 0
  readonly writesBy = new Map<string, number>()
  readonly headsBy = new Map<string, number>()
  readonly pullsBy = new Map<string, number>()
  private readonly subscribers = new Map<string, (e: RowEvent) => void>()
  private readonly listeners = new Map<string, (m: BroadcastMsg) => void>()

  /**
   * `aux` draws the latency and loss of the requests only 0.11.0 makes (HEAD, Broadcast), so
   * adding them leaves the random timeline of every pull, push and row event as it was.
   */
  constructor(
    readonly clock: VirtualClock,
    readonly rng: Rng,
    public net: NetOptions,
    readonly aux: Rng = makeRng(0x5eed),
  ) {}

  private delay(rng: Rng = this.rng): number {
    const [lo, hi] = this.net.latency
    const base = lo + rng.int(hi - lo + 1)
    return rng.chance(this.net.spike) ? base + 1000 + rng.int(3000) : base
  }

  /** request → (latency) → server work → (latency) → response; drops and lost responses time out. */
  private call<T>(work: () => T, forceDrop = false, forceLost = false, rng = this.rng): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const dropped = forceDrop || rng.chance(this.net.drop)
      const lost = !dropped && (forceLost || rng.chance(this.net.lostResponse))
      if (dropped) {
        this.clock.setTimeout(() => {
          reject(new NetworkError())
        }, TIMEOUT)
        return
      }
      this.clock.setTimeout(() => {
        const out = work()
        if (lost) {
          this.clock.setTimeout(() => {
            reject(new NetworkError())
          }, TIMEOUT)
          return
        }
        this.clock.setTimeout(() => {
          resolve(out)
        }, this.delay(rng))
      }, this.delay(rng))
    })
  }

  private parsed(): unknown {
    return this.row === null ? null : JSON.parse(this.row)
  }

  private write(who: string, payload: unknown): string {
    this.row = JSON.stringify(payload)
    this.etag++
    this.writes++
    this.writesBy.set(who, (this.writesBy.get(who) ?? 0) + 1)
    const event: RowEvent = { payload: JSON.parse(this.row), updatedAt: String(this.etag) }
    for (const [name, cb] of this.rowEvents ? this.subscribers : []) {
      if (this.rng.chance(this.net.eventDrop)) continue
      this.clock.setTimeout(() => {
        // a listener may have unsubscribed in the meantime
        if (this.subscribers.get(name) === cb) cb(event)
      }, this.delay())
    }
    return String(this.etag)
  }

  private count(map: Map<string, number>, who: string): void {
    map.set(who, (map.get(who) ?? 0) + 1)
  }

  /** v5 transport: select payload, updated_at. */
  pull(who = 'v5'): Promise<Pulled | null> {
    return this.call(() => {
      this.pulls++
      this.count(this.pullsBy, who)
      return this.row === null ? null : { payload: this.parsed(), etag: String(this.etag) }
    })
  }

  /** v5 transport: select updated_at only (the head short-circuit, §11.3); null = no row. */
  head(who = 'v5'): Promise<string | null> {
    return this.call(
      () => {
        this.heads++
        this.count(this.headsBy, who)
        return this.row === null ? null : String(this.etag)
      },
      false,
      false,
      this.aux,
    )
  }

  /** v5 transport: create (base null), CAS on base, or force (never creates). */
  push(who: string, payload: unknown, base: string | null, force: boolean): Promise<PushResult> {
    const drop = this.dropNextPush
    const lose = this.loseNextPushResponse
    this.dropNextPush = false
    this.loseNextPushResponse = false
    return this.call(
      (): PushResult => {
        if (!this.net.cas) return { ok: true, etag: this.write(who, payload) }
        if (!force && this.casConflicts > 0) {
          this.casConflicts--
          this.count(this.conflictsBy, who)
          return { ok: false, reason: 'conflict' }
        }
        if (force) {
          return this.row === null
            ? { ok: false, reason: 'missing' }
            : { ok: true, etag: this.write(who, payload) }
        }
        if (base === null) {
          return this.row === null
            ? { ok: true, etag: this.write(who, payload) }
            : { ok: false, reason: 'conflict' }
        }
        if (this.row === null) return { ok: false, reason: 'missing' }
        if (base !== String(this.etag)) {
          this.count(this.conflictsBy, who)
          return { ok: false, reason: 'conflict' }
        }
        return { ok: true, etag: this.write(who, payload) }
      },
      drop,
      lose,
    )
  }

  /** The PR-2 bridge's transport (P2-8): a plain upsert, whatever the row holds. */
  upsert(who: string, payload: unknown): Promise<string> {
    const drop = this.dropNextPush
    const lose = this.loseNextPushResponse
    this.dropNextPush = false
    this.loseNextPushResponse = false
    return this.call(() => this.write(who, payload), drop, lose)
  }

  subscribe(who: string, cb: (e: RowEvent) => void): () => void {
    this.subscribers.set(who, cb)
    return () => {
      if (this.subscribers.get(who) === cb) this.subscribers.delete(who)
    }
  }

  /** Broadcast `rev` listeners (0.11.0 only; 0.10.0 and older never bind the event). */
  listen(who: string, cb: (m: BroadcastMsg) => void): () => void {
    this.listeners.set(who, cb)
    return () => {
      if (this.listeners.get(who) === cb) this.listeners.delete(who)
    }
  }

  /** `channel.send` of a landed push: every other listener, with latency and event loss. */
  announce(msg: BroadcastMsg): void {
    this.broadcasts++
    for (const [name, cb] of this.broadcast ? this.listeners : []) {
      if (name === msg.dev || this.aux.chance(this.net.eventDrop)) continue
      this.clock.setTimeout(
        () => {
          if (this.listeners.get(name) === cb) cb(msg)
        },
        this.delay(this.aux) + this.delay(this.aux),
      )
    }
  }

  /** The port a v0.8.x client uses: plain upsert, select payload, postgres_changes. */
  legacyPort(who: string): RelayPort {
    return {
      pull: () => this.call(() => (this.row === null ? null : { payload: this.parsed() })),
      push: (_syncId, payload) =>
        this.call(() => {
          this.write(who, payload)
        }),
      subscribe: (_syncId, onUpdate) =>
        this.subscribe(who, () => {
          onUpdate()
        }),
    }
  }

  /** The port of a v0.8.5 client (app 0.9.2): realtime passes the change, its echo filter reads it. */
  legacyPort085(who: string): RelayPort085 {
    const port = this.legacyPort(who)
    return {
      pull: (syncId) => port.pull(syncId),
      push: (syncId, payload) => port.push(syncId, payload),
      subscribe: (_syncId, onChange) =>
        this.subscribe(who, (e) => {
          onChange({ payload: e.payload, updatedAt: e.updatedAt })
        }),
    }
  }

  /** Writes the row directly (scripted interleavings: pruned rows, poisoned relays). */
  poke(who: string, payload: unknown): void {
    if (payload === null) {
      this.row = null
      return
    }
    this.write(who, payload)
  }
}
