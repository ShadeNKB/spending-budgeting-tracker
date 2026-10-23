// A single relay row (public.sync_buckets) on a virtual network: request/response latency, drops,
// lost responses and reordering, optional CAS on updated_at, and realtime fan-out to every
// subscriber including the writer (self-echo), as postgres_changes does today.
import type { RelayPort } from '../legacy/v084'
import type { Rng } from '../support/rng'
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
}

export const CALM: NetOptions = {
  cas: true,
  latency: [50, 800],
  drop: 0,
  lostResponse: 0,
  eventDrop: 0,
  spike: 0,
}
export const FLAKY: NetOptions = {
  cas: true,
  latency: [50, 800],
  drop: 0.08,
  lostResponse: 0.05,
  eventDrop: 0.15,
  spike: 0.1,
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
  etag = 0
  writes = 0
  readonly writesBy = new Map<string, number>()
  private readonly subscribers = new Map<string, (e: RowEvent) => void>()

  constructor(
    readonly clock: VirtualClock,
    readonly rng: Rng,
    public net: NetOptions,
  ) {}

  private delay(): number {
    const [lo, hi] = this.net.latency
    const base = lo + this.rng.int(hi - lo + 1)
    return this.rng.chance(this.net.spike) ? base + 1000 + this.rng.int(3000) : base
  }

  /** request → (latency) → server work → (latency) → response; drops and lost responses time out. */
  private call<T>(work: () => T, forceDrop = false, forceLost = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const dropped = forceDrop || this.rng.chance(this.net.drop)
      const lost = !dropped && (forceLost || this.rng.chance(this.net.lostResponse))
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
        }, this.delay())
      }, this.delay())
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
    for (const [name, cb] of this.subscribers) {
      if (this.rng.chance(this.net.eventDrop)) continue
      this.clock.setTimeout(() => {
        // a listener may have unsubscribed in the meantime
        if (this.subscribers.get(name) === cb) cb(event)
      }, this.delay())
    }
    return String(this.etag)
  }

  /** v5 transport: select payload, updated_at. */
  pull(): Promise<Pulled | null> {
    return this.call(() =>
      this.row === null ? null : { payload: this.parsed(), etag: String(this.etag) },
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
        if (base !== String(this.etag)) return { ok: false, reason: 'conflict' }
        return { ok: true, etag: this.write(who, payload) }
      },
      drop,
      lose,
    )
  }

  /** The current etag without transfer (head); synchronous in this model. */
  head(): string | null {
    return this.row === null ? null : String(this.etag)
  }

  subscribe(who: string, cb: (e: RowEvent) => void): () => void {
    this.subscribers.set(who, cb)
    return () => {
      if (this.subscribers.get(who) === cb) this.subscribers.delete(who)
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

  /** Writes the row directly (scripted interleavings: pruned rows, poisoned relays). */
  poke(who: string, payload: unknown): void {
    if (payload === null) {
      this.row = null
      return
    }
    this.write(who, payload)
  }
}
