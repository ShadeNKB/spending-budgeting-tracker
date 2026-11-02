// A v5 device: the §11.3 cycle on the pure core, modelled with real async/await on virtual time.
// Single-flight + `again`, a FRESH read of the local doc after every await, a synchronous section
// from decode to encode, CAS with a forced write after 3 conflicts (≤ 6 attempts), the memo
// committed only after a push lands, outbox acknowledgement, echo filter, 300 ms coalescing and the
// 1.5 s / 5 s push debounce. `readBeforeAwait` is the test-only F-001 negative control (M1).
//
// mode 'pr2' is the PR-2 sync bridge instead (track spec §9, P2-8…P2-10): PR-0's cycle shape on the
// core codec with a PLAIN upsert (no CAS, no head()/polling: PR-0's triggers only), PR-0's remote
// coalescing (300 ms, 2 s apart), the echo filter of P2-9, news absorption (P2-10), the writer
// classes of P2-8 (moved/e2e pause, newer merges only, invalid repaired at most once per 10 min) and
// create-on-missing. `absorbNews: false` is its negative control for the crossing-push residual.
import {
  MEMO_WINDOW,
  CAS_FORCE_AFTER,
  CYCLE_ATTEMPTS_MAX,
  PUSH_MAX_WAIT,
  PUSH_QUIET,
  REMOTE_COALESCE,
  POLL_VISIBLE,
} from '../../core/constants'
import { EMPTY_DOC, digestDoc, maxStampDoc, mergeDoc } from '../../core/doc'
import { newRev } from '../../core/ids'
import { NEW_MEMO, ackOutbox, commitPush, decidePush, guardTrips } from '../../core/push'
import { isPlainObject } from '../../core/sanitize'
import { observe } from '../../core/stamp'
import type {
  CycleReason,
  Doc,
  ExpenseRec,
  Hlc,
  MemoState,
  MergeResult,
  OpCtx,
  PushDecision,
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
  /** 'pr3' (default): the §11.3 cycle with CAS and polling. 'pr2': the PR-2 bridge (§9). */
  readonly mode?: 'pr3' | 'pr2'
  /** pr2 only (default true): merge foreign event payloads into the next cycle (P2-10). */
  readonly absorbNews?: boolean
}

/** The bridge's echo memory (P2-9): our last pushes by rev, with the digest each one carried. */
interface SentPush {
  readonly rev: string
  readonly digest: string
  answered: boolean
}
const ECHO_MEMORY = 8
const NEWS_MEMORY = 4
const REMOTE_MIN_GAP = 2000

/** The bridge's stand-in for a missing row: decidePush is given `pulled: null` (create). */
const NO_ROW: SanitizeResult = {
  doc: EMPTY_DOC,
  writer: 'v5',
  report: {
    quarantined: [],
    repaired: 0,
    repairs: [],
    deduped: 0,
    liveAndDeleted: 0,
    droppedKeys: [],
  },
  legacyTs: new Map(),
  rev: null,
}
const NONE = (why: PushDecision['why']): PushDecision => ({ kind: 'none', why, memoKey: null })

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
  readonly mode: 'pr3' | 'pr2'
  readonly absorbNews: boolean
  /** pr2: foreign event payloads waiting for the next cycle, newest last (P2-10). */
  readonly news: unknown[] = []
  /** pr2: news payloads merged so far (the crossing-push test reads it). */
  absorbed = 0
  /** pr2: when the last repair of an invalid relay copy was pushed (P2-8, meta.sync.repairAt). */
  repairAt = 0
  private readonly sentPushes: SentPush[] = []
  private lastRemoteCycleAt = Number.NEGATIVE_INFINITY
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
    this.mode = opts.mode ?? 'pr3'
    this.absorbNews = opts.absorbNews ?? true
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
      if (this.mode === 'pr2') this.onEventPr2(e)
      else this.onEvent(e)
    })
    if (this.mode === 'pr3') this.schedulePoll()
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

  /**
   * P2-9: our own echo iff its x5.rev is one of our last 8 pushes, that push was answered or is the
   * latest, and the digest of what came back is the digest we sent. Anything else is foreign: its
   * payload is kept for the next cycle (P2-10), and remote cycles start 300 ms later, 2 s apart.
   */
  private onEventPr2(e: RowEvent): void {
    const x5: unknown = isPlainObject(e.payload) ? Reflect.get(e.payload, 'x5') : undefined
    const rev: unknown = isPlainObject(x5) ? Reflect.get(x5, 'rev') : undefined
    const sent = this.sentPushes.find((p) => p.rev === rev)
    if (
      sent !== undefined &&
      (sent.answered || sent === this.sentPushes.at(-1)) &&
      digestDoc(decodeWire(e.payload, 'remote').doc) === sent.digest
    ) {
      return
    }
    if (this.absorbNews && isPlainObject(e.payload)) {
      this.news.push(e.payload)
      if (this.news.length > NEWS_MEMORY) this.news.shift()
    }
    if (this.coalesceTimer !== null) return
    const wait = Math.max(REMOTE_COALESCE, this.lastRemoteCycleAt + REMOTE_MIN_GAP - this.clock.now)
    this.coalesceTimer = this.clock.setTimeout(() => {
      this.coalesceTimer = null
      this.lastRemoteCycleAt = this.clock.now
      void this.triggerSync('remote')
    }, wait)
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
      if (this.mode === 'pr2') await this.cyclePr2(reason)
      else await this.cycle(reason)
      this.retries = 0
    } catch (e) {
      // the network fails; the core never may (I8)
      if (!(e instanceof NetworkError))
        this.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
      this.retryLater()
    }
  }

  /** Merge a decoded remote doc into the CURRENT doc, with the guard and the journal. */
  private applyRemote(dec: SanitizeResult): void {
    const local = this.doc
    const m = mergeDoc(local, dec.doc)
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
    observe(this.hlc, this.wall(), maxStampDoc(dec.doc))
  }

  /** The PR-2 bridge cycle (track spec §9): one pull, one synchronous section, one plain upsert. */
  private async cyclePr2(reason: CycleReason): Promise<void> {
    const pulled = await this.relay.pull() // AWAIT 1
    // ── synchronous section: no await until the payload is built ──
    const at = this.wall()
    for (const p of this.news.splice(0)) {
      const d = decodeWire(p, 'remote', { reuse: this.doc, at })
      if (d.writer === 'v5' || d.writer === 'v085' || d.writer === 'v084') {
        this.applyRemote(d)
        this.absorbed++
      }
    }
    const dec =
      pulled === null ? NO_ROW : decodeWire(pulled.payload, 'remote', { reuse: this.doc, at })
    if (dec.writer === 'moved') {
      this.paused = 'moved'
      return
    }
    if (dec.writer === 'e2e') {
      this.paused = 'update-required'
      return
    }
    const snapRev = this.localRev
    const sent = [...this.outbox]
    const mergeable = dec.writer !== 'invalid'
    if (pulled !== null && mergeable) this.applyRemote(dec)
    const repair = dec.writer === 'invalid' && at - this.repairAt > MEMO_WINDOW
    const decision =
      dec.writer === 'newer'
        ? NONE('newer')
        : dec.writer === 'invalid'
          ? repair
            ? ({ kind: 'push', why: 'repair', memoKey: null } as const)
            : NONE('old-quiet')
          : decidePush(this.doc, dec, pulled === null ? null : { etag: '' }, reason, this.memo, at)
    if (dec.writer === 'newer') this.paused = 'update-required'
    if (decision.kind !== 'push') {
      const ack = ackOutbox(this.outbox, sent, dec, decision)
      this.outbox = ack.outbox
      this.waitingForOld = ack.waitingForOld
      this.observer.trace(`${this.name} ${reason} ${decision.why}`)
      if (this.localRev !== snapRev) this.again = true
      return
    }
    const rev = newRev(this.rng.next)
    const wire = encodeWire(this.doc, { dev: this.name, rev, min: 4 })
    const entry: SentPush = { rev, digest: digestDoc(this.doc), answered: false }
    this.sentPushes.push(entry)
    if (this.sentPushes.length > ECHO_MEMORY) this.sentPushes.shift()
    // ── end of the synchronous section ──
    const etag = await this.relay.upsert(this.name, wire) // AWAIT 2
    entry.answered = true
    this.lastEtag = etag
    this.lastRev = rev
    this.memo = commitPush(this.memo, decision, at)
    if (repair) this.repairAt = at
    const ack = ackOutbox(this.outbox, sent, dec, 'pushed')
    this.outbox = ack.outbox
    this.waitingForOld = 0
    this.established = true
    this.pushes++
    this.pushWhy.push(decision.why)
    this.observer.trace(`${this.name} pushed ${decision.why} ${etag}`)
    if (this.localRev !== snapRev) this.again = true
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
