// A v5 device: the §11.3 cycle on the pure core, modelled with real async/await on virtual time.
// Single-flight + `again`, a FRESH read of the local doc after every await, a synchronous section
// from decode to encode, CAS with a forced write after 3 conflicts (≤ 6 attempts), the memo
// committed only after a push lands, outbox acknowledgement, echo filter, 300 ms coalescing and the
// 1.5 s / 5 s push debounce. `readBeforeAwait` is the test-only F-001 negative control (M1).
import {
  CAS_FORCE_AFTER,
  CYCLE_ATTEMPTS_MAX,
  PUSH_MAX_WAIT,
  PUSH_QUIET,
  REMOTE_COALESCE,
  POLL_VISIBLE,
} from '../../core/constants'
import { EMPTY_DOC, maxStampDoc, mergeDoc } from '../../core/doc'
import { newRev } from '../../core/ids'
import { NEW_MEMO, ackOutbox, commitPush, decidePush, guardTrips } from '../../core/push'
import { observe } from '../../core/stamp'
import type {
  CycleReason,
  Doc,
  ExpenseRec,
  Hlc,
  MemoState,
  MergeResult,
  OpCtx,
  OpResult,
  OutboxKey,
  SanitizeResult,
  Stamp,
} from '../../core/types'
import { decodeWire, encodeWire } from '../../core/wire'
import type { Rng } from '../support/rng'
import type { VirtualClock } from './clock'
import { NetworkError, type Relay, type RowEvent } from './relay'

export interface Observer {
  /** Every doc a v5 replica adopts (op commit or merge): feeds the field oracle and I3. */
  readonly onDoc: (dev: V5Device, before: Doc, after: Doc) => void
  /** Every merge of a pulled doc: I1 is checked against the merge's own report. */
  readonly onMerge: (dev: V5Device, local: Doc, m: MergeResult) => void
  readonly trace: (line: string) => void
}

export interface V5Options {
  readonly name: string
  readonly skew: number
  readonly established: boolean
  /** Test-only negative control: snapshot the local doc BEFORE the pull await (v0.8 F-001 shape). */
  readonly readBeforeAwait?: boolean
  readonly doc?: Doc
  readonly outbox?: ReadonlyMap<OutboxKey, Stamp>
}

export interface JournalEntry {
  readonly kind: 'removed' | 'replaced' | 'edit-after-delete' | 'mass'
  readonly ids: readonly string[]
}

export class V5Device {
  readonly name: string
  readonly skew: number
  doc: Doc
  readonly hlc: Hlc = { last: 0 }
  outbox: ReadonlyMap<OutboxKey, Stamp>
  memo: MemoState = NEW_MEMO
  lastEtag: string | null = null
  lastRev: string | null = null
  established: boolean
  localRev = 0
  pushes = 0
  pushWhy: string[] = []
  paused: string | null = null
  waitingForOld = 0
  readonly journal: JournalEntry[] = []
  /** Exceptions other than network failures thrown inside a cycle (must stay empty). */
  readonly errors: string[] = []
  readonly snapshots: Doc[] = []
  readonly readBeforeAwait: boolean
  private running = false
  private again = false
  private waiters: (() => void)[] = []
  private quietTimer: number | null = null
  private maxTimer: number | null = null
  private coalesceTimer: number | null = null
  private retryTimer: number | null = null
  private pollTimer: number | null = null
  private retries = 0
  private unsubscribe: (() => void) | null = null

  constructor(
    readonly clock: VirtualClock,
    readonly relay: Relay,
    readonly rng: Rng,
    readonly observer: Observer,
    opts: V5Options,
  ) {
    this.name = opts.name
    this.skew = opts.skew
    this.established = opts.established
    this.readBeforeAwait = opts.readBeforeAwait ?? false
    this.doc = opts.doc ?? EMPTY_DOC
    this.outbox = opts.outbox ?? new Map()
    this.hlc.last = Math.min(maxStampDoc(this.doc), this.wall() + 86_400_000)
  }

  wall(): number {
    return this.clock.now + this.skew
  }

  ctx(): OpCtx {
    return { wall: this.wall(), clock: this.hlc, dev: this.name, rng: this.rng.next }
  }

  /** Start realtime + polling (a visible tab with a sync code). */
  start(): void {
    this.unsubscribe = this.relay.subscribe(this.name, (e) => {
      this.onEvent(e)
    })
    this.schedulePoll()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const h of [
      this.quietTimer,
      this.maxTimer,
      this.coalesceTimer,
      this.retryTimer,
      this.pollTimer,
    ]) {
      if (h !== null) this.clock.clearTimeout(h)
    }
    this.quietTimer = this.maxTimer = this.coalesceTimer = this.retryTimer = this.pollTimer = null
  }

  private adopt(next: Doc): void {
    const before = this.doc
    this.doc = next
    if (next !== before) this.observer.onDoc(this, before, next)
  }

  /** A user op: commit synchronously (I9), outbox, then the push debounce. */
  apply(r: OpResult): OpResult {
    this.adopt(r.doc)
    if (r.touched.length > 0) {
      const ob = new Map(this.outbox)
      for (const [k, s] of r.touched) ob.set(k, Math.max(ob.get(k) ?? 0, s))
      this.outbox = ob
      this.localRev++
      this.schedulePush()
    }
    return r
  }

  op(f: (doc: Doc, ctx: OpCtx) => OpResult): OpResult {
    return this.apply(f(this.doc, this.ctx()))
  }

  private schedulePush(): void {
    if (this.quietTimer !== null) this.clock.clearTimeout(this.quietTimer)
    const fire = (): void => {
      if (this.quietTimer !== null) this.clock.clearTimeout(this.quietTimer)
      if (this.maxTimer !== null) this.clock.clearTimeout(this.maxTimer)
      this.quietTimer = this.maxTimer = null
      void this.triggerSync('local-change')
    }
    this.quietTimer = this.clock.setTimeout(fire, PUSH_QUIET)
    this.maxTimer ??= this.clock.setTimeout(fire, PUSH_MAX_WAIT)
  }

  private schedulePoll(): void {
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null
      // head() short-circuit: no transfer when nothing is pending and the etag is unchanged
      if (this.outbox.size > 0 || this.relay.head() !== this.lastEtag) void this.triggerSync('poll')
      this.schedulePoll()
    }, POLL_VISIBLE)
  }

  /** Echo filter (own rev or own etag), then 300 ms trailing coalescing. */
  private onEvent(e: RowEvent): void {
    const x5: unknown =
      typeof e.payload === 'object' && e.payload !== null ? Reflect.get(e.payload, 'x5') : undefined
    const rev: unknown = typeof x5 === 'object' && x5 !== null ? Reflect.get(x5, 'rev') : undefined
    if ((typeof rev === 'string' && rev === this.lastRev) || e.updatedAt === this.lastEtag) return
    if (this.coalesceTimer !== null) this.clock.clearTimeout(this.coalesceTimer)
    this.coalesceTimer = this.clock.setTimeout(() => {
      this.coalesceTimer = null
      void this.triggerSync('remote')
    }, REMOTE_COALESCE)
  }

  /** Resolves after the NEXT completed cycle; a call during a cycle sets `again`. */
  triggerSync(reason: CycleReason): Promise<void> {
    const done = new Promise<void>((resolve) => this.waiters.push(resolve))
    if (this.running) {
      this.again = true
      return done
    }
    this.running = true
    void (async () => {
      let why = reason
      do {
        this.again = false
        await this.runCycle(why)
        why = 'again'
      } while (this.againRequested())
      this.running = false
      const ws = this.waiters
      this.waiters = []
      for (const w of ws) w()
    })()
    return done
  }

  get busy(): boolean {
    return this.running
  }

  /** Read through a call: a write during an await sets it, which control-flow analysis cannot see. */
  private againRequested(): boolean {
    return this.again
  }

  private retryLater(): void {
    this.retries = Math.min(this.retries + 1, 5)
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = this.clock.setTimeout(
      () => {
        this.retryTimer = null
        void this.triggerSync('again')
      },
      Math.min(60_000, 2000 * 2 ** this.retries),
    )
  }

  private async runCycle(reason: CycleReason): Promise<void> {
    if (this.paused !== null) return
    try {
      await this.cycle(reason)
      this.retries = 0
    } catch (e) {
      // the network fails; the core never may (I8)
      if (!(e instanceof NetworkError))
        this.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
      this.retryLater()
    }
  }

  private async cycle(reason: CycleReason): Promise<void> {
    let conflicts = 0
    let snapRev = this.localRev
    for (let attempt = 0; attempt < CYCLE_ATTEMPTS_MAX; attempt++) {
      const stale = this.doc // what the v0.8 F-001 shape would merge into
      const pulled = await this.relay.pull() // AWAIT 1
      // ── synchronous section: no await until the payload is built ──
      const dec: SanitizeResult = decodeWire(pulled === null ? null : pulled.payload, 'remote', {
        reuse: this.doc,
        at: this.wall(),
      })
      if (pulled !== null && dec.writer === 'moved') {
        this.paused = 'moved'
        return
      }
      if (pulled === null && !this.established) {
        this.paused = 'not-found'
        return
      }
      snapRev = this.localRev
      const local = this.readBeforeAwait ? stale : this.doc // FRESH read after the await (F-001)
      const m =
        pulled === null
          ? { doc: local, removed: [], replaced: [], editAfterDelete: [] }
          : mergeDoc(local, dec.doc)
      this.observer.onMerge(this, local, m)
      if (guardTrips(m.removed, local)) {
        this.snapshots.push(local)
        this.journal.push({ kind: 'mass', ids: m.removed.map((r) => r.id) })
      } else if (m.removed.length > 0)
        this.journal.push({ kind: 'removed', ids: m.removed.map((r) => r.id) })
      if (m.replaced.length > 0)
        this.journal.push({ kind: 'replaced', ids: m.replaced.map((r) => r.before.id) })
      if (m.editAfterDelete.length > 0) {
        this.journal.push({
          kind: 'edit-after-delete',
          ids: m.editAfterDelete.map((r: ExpenseRec) => r.id),
        })
      }
      if (m.doc !== this.doc) this.adopt(m.doc)
      if (pulled !== null) observe(this.hlc, this.wall(), maxStampDoc(dec.doc))
      const pulledRow = pulled === null ? null : { etag: pulled.etag }
      const decision =
        pulled !== null && dec.writer === 'newer'
          ? ({ kind: 'none', why: 'newer', memoKey: null } as const)
          : decidePush(m.doc, dec, pulledRow, reason, this.memo, this.wall())
      const sent = [...this.outbox]
      if (decision.kind !== 'push') {
        const ack = ackOutbox(this.outbox, sent, dec, decision)
        this.outbox = ack.outbox
        this.waitingForOld = ack.waitingForOld
        this.lastEtag = pulled?.etag ?? null
        this.observer.trace(`${this.name} ${reason} ${decision.why}`)
        break
      }
      const rev = newRev(this.rng.next)
      const wire = encodeWire(m.doc, { dev: this.name, rev, min: 4 })
      // ── end of the synchronous section ──
      const res = await this.relay.push(
        this.name,
        wire,
        pulled?.etag ?? null,
        conflicts >= CAS_FORCE_AFTER,
      ) // AWAIT 2
      if (!res.ok) {
        if (res.reason === 'conflict') conflicts++
        this.observer.trace(`${this.name} push ${res.reason}`)
        continue
      }
      this.lastEtag = res.etag
      this.lastRev = rev
      this.memo = commitPush(this.memo, decision, this.wall())
      const ack = ackOutbox(this.outbox, sent, dec, 'pushed')
      this.outbox = ack.outbox
      this.waitingForOld = 0
      this.established = true
      this.pushes++
      this.pushWhy.push(decision.why)
      this.observer.trace(`${this.name} pushed ${decision.why} ${res.etag}`)
      break
    }
    if (this.localRev !== snapRev) this.again = true
  }
}
