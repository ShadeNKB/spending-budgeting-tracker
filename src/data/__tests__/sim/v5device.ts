// A v5 device on the pure core, modelled with real async/await on virtual time.
//
// mode 'pr3' (default) is the 0.11.0 sync engine (PR-3 track spec §3.4–§3.6, DATA-ENGINE-SPEC
// §11.3): single-flight + `again`; the head short-circuit for resume / poll / resubscribe / online
// (empty outbox, no news waiting, own registry entry current, a known etag); one pull, then a
// SYNCHRONOUS section from decode to encode on a FRESH read of the local doc (F-001): news first
// (P2-10, kept with CAS off and harmless with it on), writer classes (moved / e2e pause, newer
// merges only, invalid repaired only by an established device at most once per 10 min), a join
// never creates (`paused('not-found')`), the device registry (`devices[me]` registered before the
// decision when it changed ignoring `seen`, and with `seen` at every push), `decidePush`; then CAS
// with a forced write after 3 conflicts and `busy` after 6 attempts (a plain upsert with CAS off);
// the memo committed only after a push lands, outbox acknowledgement, Broadcast of every landed
// rev. Echo filter §3.6 (own etag, own rev + digest, a merged rev + digest; Broadcast from me or of
// a known rev), 300 ms coalescing ≥ 2 s apart, the storm breaker (the 21st remote cycle within
// 60 s with no local change does not run; remote events start nothing for 60 s, polling goes to
// 60 s, a local change ends it), polling every 5 min while live and 60 s otherwise, the 1.5 s / 5 s
// push debounce, and backoff 2 s · 2ⁿ⁻¹ capped at 60 s with ±20 % jitter.
// `readBeforeAwait` is the test-only F-001 negative control (M1).
//
// mode 'pr2' is the PR-2 sync bridge, i.e. the shipped 0.10.0 (PR-2 track spec §9, P2-8…P2-10):
// PR-0's cycle shape on the core codec with a PLAIN upsert (no CAS, no head()/polling: PR-0's
// triggers only), PR-0's remote coalescing (300 ms, 2 s apart), the echo filter of P2-9, news
// absorption (P2-10), the writer classes of P2-8 (moved/e2e pause, newer merges only, invalid
// repaired at most once per 10 min) and create-on-missing. It never registers itself and never
// hears Broadcast. `absorbNews: false` is the negative control for the crossing-push residual.
import {
  MEMO_WINDOW,
  CAS_FORCE_AFTER,
  CYCLE_ATTEMPTS_MAX,
  PUSH_MAX_WAIT,
  PUSH_QUIET,
  REMOTE_COALESCE,
  POLL_VISIBLE,
  BACKOFF_BASE,
  BACKOFF_CAP,
  BACKOFF_JITTER,
  STORM_CYCLES,
  STORM_WINDOW,
} from '../../core/constants'
import { EMPTY_DOC, digestDoc, maxStampDoc, mergeDoc } from '../../core/doc'
import { newRev } from '../../core/ids'
import { NEW_MEMO, ackOutbox, commitPush, decidePush, guardTrips } from '../../core/push'
import { isPlainObject } from '../../core/sanitize'
import { observe } from '../../core/stamp'
import type {
  CycleReason,
  DeviceInfo,
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
import { NetworkError, type BroadcastMsg, type Pulled, type Relay, type RowEvent } from './relay'

export interface Observer {
  /** Every doc a v5 replica adopts (op commit or merge): feeds the field oracle and I3. */
  readonly onDoc: (dev: V5Device, before: Doc, after: Doc) => void
  /** Every merge of a pulled doc: I1 is checked against the merge's own report. */
  readonly onMerge: (dev: V5Device, local: Doc, m: MergeResult) => void
  readonly trace: (line: string) => void
}

export type V5Mode = 'pr3' | 'pr2'

export interface V5Options {
  readonly name: string
  readonly skew: number
  readonly established: boolean
  /** Test-only negative control: snapshot the local doc BEFORE the pull await (v0.8 F-001 shape). */
  readonly readBeforeAwait?: boolean
  readonly doc?: Doc
  readonly outbox?: ReadonlyMap<OutboxKey, Stamp>
  /** 'pr3' (default): the 0.11.0 engine. 'pr2': the 0.10.0 bridge (PR-2 track spec §9). */
  readonly mode?: V5Mode
  /** Merge foreign event payloads into the next cycle (P2-10). Default true. */
  readonly absorbNews?: boolean
  /** In-place upgrade (0.10.0 → 0.11.0): what the envelope carries over. */
  readonly memo?: MemoState
  readonly lastRev?: string | null
  readonly repairAt?: number
  /** pr3: the app version this device registers (default 0.11.0). */
  readonly app?: string
}

/** The echo memory (P2-9): our last pushes by rev, with the digest each one carried. */
interface SentPush {
  readonly rev: string
  readonly digest: string
  answered: boolean
}
/** pr3: a rev this device fully merged, with the digest of what it merged (§3.6). */
interface MergedRev {
  readonly rev: string
  readonly digest: string
}
const ECHO_MEMORY = 8
const NEWS_MEMORY = 4
const REMOTE_MIN_GAP = 2000
/** pr3 polling while live updates are on (a silently dead socket, P3-13). */
export const POLL_LIVE = 5 * 60_000
/** pr3 reasons that may end at a HEAD (P3-4). */
const HEAD_REASONS: ReadonlySet<CycleReason> = new Set(['resume', 'poll', 'resubscribe', 'online'])
export const APP_VERSION = '0.11.0'

/** Six attempts in one cycle all lost to CAS conflicts (§11.8 `busy`): retried later. */
export class BusyError extends Error {
  constructor() {
    super('busy')
    this.name = 'BusyError'
  }
}
/** An invalid relay copy this device may not repair now (§3.4 step 3): retried later. */
export class InvalidRemoteError extends Error {
  constructor() {
    super('invalid remote')
    this.name = 'InvalidRemoteError'
  }
}
const expected = (e: unknown): boolean =>
  e instanceof NetworkError || e instanceof BusyError || e instanceof InvalidRemoteError

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
const REPAIR: PushDecision = { kind: 'push', why: 'repair', memoKey: null }

/** pr3: the registry entry, ignoring `seen` (P3-7: `seen` alone never causes a push). */
const sameEntry = (a: DeviceInfo | undefined, b: DeviceInfo): boolean =>
  a !== undefined &&
  a.name === b.name &&
  a.app === b.app &&
  a.mode === b.mode &&
  a.e2e === b.e2e &&
  a.rpcSince === b.rpcSince

const x5Of = (payload: unknown): unknown =>
  isPlainObject(payload) ? Reflect.get(payload, 'x5') : undefined
const revOf = (payload: unknown): unknown => {
  const x5 = x5Of(payload)
  return isPlainObject(x5) ? Reflect.get(x5, 'rev') : undefined
}
const devOf = (payload: unknown): unknown => {
  const x5 = x5Of(payload)
  return isPlainObject(x5) ? Reflect.get(x5, 'dev') : undefined
}

export interface JournalEntry {
  readonly kind: 'removed' | 'replaced' | 'edit-after-delete' | 'mass'
  readonly ids: readonly string[]
}

/** pr3: what the synchronous section hands to the push await. */
interface PushStep {
  readonly wire: unknown
  readonly decision: PushDecision
  readonly sent: readonly (readonly [OutboxKey, Stamp])[]
  readonly dec: SanitizeResult
  readonly entry: SentPush
  readonly at: number
}

export class V5Device {
  readonly name: string
  readonly skew: number
  doc: Doc
  readonly hlc: Hlc = { last: 0 }
  outbox: ReadonlyMap<OutboxKey, Stamp>
  memo: MemoState
  lastEtag: string | null = null
  lastRev: string | null
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
  readonly mode: V5Mode
  readonly absorbNews: boolean
  readonly app: string
  /** Foreign event payloads waiting for the next cycle, newest last (P2-10). */
  readonly news: unknown[] = []
  /** News payloads merged so far (the crossing-push test reads it). */
  absorbed = 0
  /** When the last repair of an invalid relay copy was pushed (P2-8, meta.sync.repairAt). */
  repairAt: number
  /** pr3 counters: CAS conflicts, `busy` cycles, storm-breaker trips. */
  conflicts = 0
  busyCycles = 0
  storms = 0
  /** Cycles run, by the reason they ran for (`again` included). */
  readonly cycles = new Map<CycleReason, number>()
  /** pr3: legacy writers last seen (meta.sync.legacySeen; v5pre = a 0.10.0 writer, P3-8). */
  readonly legacySeen: { v084: number | null; v085: number | null; v5pre: number | null } = {
    v084: null,
    v085: null,
    v5pre: null,
  }
  /** pr3: realtime joined (live updates on) or not (polling only). */
  live = false
  private readonly sentPushes: SentPush[] = []
  private readonly lastMerged: MergedRev[] = []
  private remoteCycles: number[] = []
  private stormUntil = Number.NEGATIVE_INFINITY
  private lastRemoteCycleAt = Number.NEGATIVE_INFINITY
  private running = false
  private again = false
  private waiters: (() => void)[] = []
  private quietTimer: number | null = null
  private maxTimer: number | null = null
  private coalesceTimer: number | null = null
  private retryTimer: number | null = null
  private pollTimer: number | null = null
  private socketTimer: number | null = null
  private retries = 0
  private unsubscribe: (() => void) | null = null
  private unlisten: (() => void) | null = null
  private started = false

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
    this.app = opts.app ?? APP_VERSION
    this.doc = opts.doc ?? EMPTY_DOC
    this.outbox = opts.outbox ?? new Map()
    this.memo = opts.memo ?? NEW_MEMO
    this.lastRev = opts.lastRev ?? null
    this.repairAt = opts.repairAt ?? 0
    this.hlc.last = Math.min(maxStampDoc(this.doc), this.wall() + 86_400_000)
  }

  wall(): number {
    return this.clock.now + this.skew
  }

  ctx(): OpCtx {
    return { wall: this.wall(), clock: this.hlc, dev: this.name, rng: this.rng.next }
  }

  /** Start realtime (+ polling on pr3): a visible tab with a sync code. */
  start(): void {
    this.started = true
    this.join()
    if (this.mode === 'pr3') this.schedulePoll()
    if (this.relay.net.socketDrop > 0) this.scheduleSocketCheck()
  }

  stop(): void {
    this.started = false
    this.leave()
    for (const h of [
      this.quietTimer,
      this.maxTimer,
      this.coalesceTimer,
      this.retryTimer,
      this.pollTimer,
      this.socketTimer,
    ]) {
      if (h !== null) this.clock.clearTimeout(h)
    }
    this.quietTimer = this.maxTimer = this.coalesceTimer = this.retryTimer = null
    this.pollTimer = this.socketTimer = null
  }

  private join(): void {
    this.unsubscribe = this.relay.subscribe(this.name, (e) => {
      if (this.mode === 'pr2') this.onEventPr2(e)
      else this.onEvent(e)
    })
    if (this.mode === 'pr3') {
      this.unlisten = this.relay.listen(this.name, (m) => {
        this.onBroadcast(m)
      })
    }
    // a project that refuses the channel leaves the device on polling ("Live updates unavailable")
    this.live = this.relay.rowEvents || (this.mode === 'pr3' && this.relay.broadcast)
  }

  private leave(): void {
    this.unsubscribe?.()
    this.unlisten?.()
    this.unsubscribe = this.unlisten = null
    this.live = false
  }

  /** The socket drops now and then; events in between are lost; the rejoin runs a cycle. */
  private scheduleSocketCheck(): void {
    this.socketTimer = this.clock.setTimeout(() => {
      this.socketTimer = null
      if (!this.started) return
      if (this.live && this.rng.chance(this.relay.net.socketDrop)) {
        this.leave()
        this.reschedulePoll()
        this.socketTimer = this.clock.setTimeout(
          () => {
            this.socketTimer = null
            if (!this.started) return
            this.join()
            this.reschedulePoll()
            void this.triggerSync('resubscribe')
            this.scheduleSocketCheck()
          },
          2000 + this.rng.int(10_001),
        )
        return
      }
      this.scheduleSocketCheck()
    }, 60_000)
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
      this.endStorm()
      this.schedulePush()
    }
    return r
  }

  op(f: (doc: Doc, ctx: OpCtx) => OpResult): OpResult {
    return this.apply(f(this.doc, this.ctx()))
  }

  private clearPushTimers(): void {
    if (this.quietTimer !== null) this.clock.clearTimeout(this.quietTimer)
    if (this.maxTimer !== null) this.clock.clearTimeout(this.maxTimer)
    this.quietTimer = this.maxTimer = null
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

  // ── pr3 triggers: polling, echo filter, Broadcast, storm breaker ─────────────────────────

  get storming(): boolean {
    return this.clock.now < this.stormUntil
  }

  private pollPeriod(): number {
    return this.live && !this.storming ? POLL_LIVE : POLL_VISIBLE
  }

  private schedulePoll(): void {
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null
      void this.triggerSync('poll')
      this.schedulePoll()
    }, this.pollPeriod())
  }

  /** Live status or the storm changed the cadence: the next poll follows the new period. */
  private reschedulePoll(): void {
    if (this.mode !== 'pr3' || !this.started) return
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer)
    this.schedulePoll()
  }

  /** A local change ends the storm pause early and restarts its count. */
  private endStorm(): void {
    if (this.mode !== 'pr3') return
    this.remoteCycles = []
    if (this.storming) {
      this.stormUntil = Number.NEGATIVE_INFINITY
      this.reschedulePoll()
    }
  }

  private isOwnEcho(payload: unknown): boolean {
    const rev = revOf(payload)
    const sent = this.sentPushes.find((p) => p.rev === rev)
    if (sent === undefined || !(sent.answered || sent === this.sentPushes.at(-1))) return false
    return digestDoc(decodeWire(payload, 'remote').doc) === sent.digest
  }

  private isMerged(payload: unknown): boolean {
    const rev = revOf(payload)
    const merged = this.lastMerged.find((p) => p.rev === rev)
    return merged !== undefined && digestDoc(decodeWire(payload, 'remote').doc) === merged.digest
  }

  /** §3.6 row event: our landed write, our echo or a merged rev start nothing; else news. */
  private onEvent(e: RowEvent): void {
    if (e.updatedAt === this.lastEtag || this.isOwnEcho(e.payload) || this.isMerged(e.payload))
      return
    if (this.absorbNews) this.keepNews(e.payload)
    this.scheduleRemote()
  }

  /** P2-10: a foreign payload may be the only copy of what a crossing push dropped. */
  private keepNews(payload: unknown): void {
    if (!isPlainObject(payload)) return
    this.news.push(payload)
    if (this.news.length > NEWS_MEMORY) this.news.shift()
  }

  /** §3.6 Broadcast: from me, or a rev pushed, merged or last landed here, starts nothing. */
  private onBroadcast(m: BroadcastMsg): void {
    if (
      m.dev === this.name ||
      m.rev === this.lastRev ||
      this.sentPushes.some((p) => p.rev === m.rev) ||
      this.lastMerged.some((p) => p.rev === m.rev)
    ) {
      return
    }
    this.scheduleRemote()
  }

  /** 300 ms trailing coalescing, remote cycles ≥ 2 s apart, and the storm breaker (P3-14). */
  private scheduleRemote(): void {
    if (this.storming || this.coalesceTimer !== null) return
    const wait = Math.max(REMOTE_COALESCE, this.lastRemoteCycleAt + REMOTE_MIN_GAP - this.clock.now)
    this.coalesceTimer = this.clock.setTimeout(() => {
      this.coalesceTimer = null
      const now = this.clock.now
      this.remoteCycles = this.remoteCycles.filter((t) => t > now - STORM_WINDOW)
      if (this.remoteCycles.length >= STORM_CYCLES) {
        this.stormUntil = now + STORM_WINDOW
        this.storms++
        this.remoteCycles = []
        this.reschedulePoll()
        this.observer.trace(`${this.name} storm`)
        return
      }
      this.remoteCycles.push(now)
      this.lastRemoteCycleAt = now
      void this.triggerSync('remote')
    }, wait)
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

  private retryLater(reason: CycleReason): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    let wait: number
    // pr3 retries the same reason (a failed poll retries as a HEAD); the bridge as PR-0 did
    const why: CycleReason = this.mode === 'pr3' ? reason : 'again'
    if (this.mode === 'pr3') {
      // 2, 4, 8, 16, 32, 60, 60 s, each ±20 % (P3-15)
      this.retries++
      const base = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (this.retries - 1))
      wait = base * (1 + BACKOFF_JITTER * (2 * this.rng.next() - 1))
    } else {
      this.retries = Math.min(this.retries + 1, 5)
      wait = Math.min(60_000, 2000 * 2 ** this.retries)
    }
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      void this.triggerSync(why)
    }, wait)
  }

  private async runCycle(reason: CycleReason): Promise<void> {
    if (this.mode === 'pr2' ? this.paused !== null : this.paused === 'moved') return
    this.cycles.set(reason, (this.cycles.get(reason) ?? 0) + 1)
    try {
      if (this.mode === 'pr2') await this.cyclePr2(reason)
      else await this.cycle(reason)
      this.retries = 0
    } catch (e) {
      // the network fails; the core never may (I8)
      if (e instanceof BusyError) this.busyCycles++
      if (!expected(e)) this.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
      this.retryLater(reason)
    }
  }

  /** Merge a decoded remote doc into `local` (the CURRENT doc), with the guard and the journal. */
  private applyRemote(dec: SanitizeResult, local: Doc = this.doc): void {
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
    const pulled = await this.relay.pull(this.name) // AWAIT 1
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
            ? REPAIR
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

  // ── pr3: the 0.11.0 cycle ────────────────────────────────────────────────────────────────

  private entry(seen: number): DeviceInfo {
    return { name: this.name, app: this.app, mode: 'table', e2e: false, seen }
  }

  /** This device's registry entry in its own doc matches what it would register (P3-4, P3-7). */
  registryCurrent(): boolean {
    return sameEntry(this.doc.devices.get(this.name), this.entry(0))
  }

  /** `port.register`: devices[me] := entry. No outbox entry, no localRev bump, same expenses. */
  private register(seen: number): void {
    this.adopt({ ...this.doc, devices: new Map(this.doc.devices).set(this.name, this.entry(seen)) })
  }

  private headAllowed(reason: CycleReason): boolean {
    return (
      HEAD_REASONS.has(reason) &&
      this.outbox.size === 0 &&
      this.news.length === 0 &&
      this.registryCurrent() &&
      this.lastEtag !== null
    )
  }

  private async cycle(reason: CycleReason): Promise<void> {
    const snapRev = this.localRev
    if (this.headAllowed(reason)) {
      const h = await this.relay.head(this.name) // AWAIT 0
      if (h !== null && h === this.lastEtag && this.outbox.size === 0 && this.news.length === 0) {
        this.observer.trace(`${this.name} ${reason} head`)
        if (this.localRev !== snapRev) this.again = true
        return
      }
      if (h === null && !this.established) {
        this.paused = 'not-found'
        return
      }
    }
    let conflicts = 0
    for (let attempt = 0; attempt < CYCLE_ATTEMPTS_MAX; attempt++) {
      const stale = this.doc // what the v0.8 F-001 shape would merge into
      const pulled = await this.relay.pull(this.name) // AWAIT 1
      const step = this.mergeStep(pulled, reason, stale)
      if (step === null) {
        if (this.localRev !== snapRev) this.again = true
        return
      }
      const decision = step.decision
      const res = await this.relay.push(
        this.name,
        step.wire,
        pulled?.etag ?? null,
        conflicts >= CAS_FORCE_AFTER,
      ) // AWAIT 2
      if (!res.ok) {
        const i = this.sentPushes.indexOf(step.entry)
        if (i >= 0) this.sentPushes.splice(i, 1)
        if (res.reason === 'conflict') {
          conflicts++
          this.conflicts++
        }
        this.observer.trace(`${this.name} push ${res.reason}`)
        continue
      }
      step.entry.answered = true
      this.remember({ rev: step.entry.rev, digest: step.entry.digest })
      this.lastEtag = res.etag
      this.lastRev = step.entry.rev
      this.memo = commitPush(this.memo, decision, step.at)
      if (decision.why === 'repair') this.repairAt = step.at
      const ack = ackOutbox(this.outbox, step.sent, step.dec, 'pushed')
      this.outbox = ack.outbox
      this.waitingForOld = 0
      this.established = true
      this.pushes++
      this.pushWhy.push(decision.why)
      this.relay.announce({ rev: step.entry.rev, dev: this.name })
      this.observer.trace(`${this.name} pushed ${decision.why} ${res.etag}`)
      if (this.localRev !== snapRev) this.again = true
      return
    }
    throw new BusyError()
  }

  /**
   * The synchronous section (§3.4 mergeStep): no await from decode to encode. Returns null when
   * the cycle ends here (nothing to push, or paused), else what to push.
   */
  private mergeStep(pulled: Pulled | null, reason: CycleReason, stale: Doc): PushStep | null {
    const at = this.wall()
    this.clearPushTimers() // this cycle carries every change made so far
    if (this.paused !== null) this.paused = null // not-found / update-required are re-checked
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
      return null
    }
    if (dec.writer === 'e2e') {
      this.paused = 'update-required'
      return null
    }
    if (pulled === null && !this.established) {
      this.paused = 'not-found' // a join never creates a row (§11.6)
      return null
    }
    const invalid = dec.writer === 'invalid'
    if (invalid && (!this.established || at - this.repairAt <= MEMO_WINDOW)) {
      throw new InvalidRemoteError()
    }
    this.noteWriter(pulled, dec, at)
    const sent = [...this.outbox]
    const local = this.readBeforeAwait ? stale : this.doc // FRESH read after the await (F-001)
    if (pulled !== null && !invalid) this.applyRemote(dec, local)
    if (!this.registryCurrent()) this.register(at)
    let decision =
      dec.writer === 'newer'
        ? NONE('newer')
        : invalid
          ? REPAIR
          : decidePush(
              this.doc,
              dec,
              pulled === null ? null : { etag: pulled.etag },
              reason,
              this.memo,
              at,
            )
    // the memo holds back a push an old device overwrote, never a change made since (PR-2)
    if (decision.kind === 'suppressed' && sent.length > 0) {
      decision = { kind: 'push', why: 'adoptable', memoKey: decision.memoKey }
    }
    if (decision.kind !== 'push') {
      const ack = ackOutbox(this.outbox, sent, dec, decision)
      this.outbox = ack.outbox
      this.waitingForOld = ack.waitingForOld
      if (pulled !== null) {
        this.remember({ rev: dec.rev, digest: digestDoc(dec.doc) })
        // until the relay moves on, a HEAD is all a resume needs; not for an old writer's copy,
        // which may still lack what is here (§11.4: its resume is a full cycle, ext-refresh)
        if (decision.kind === 'none' && (dec.writer === 'v5' || dec.writer === 'newer'))
          this.lastEtag = pulled.etag
        this.established = true // a joined device becomes established on an existing row
      }
      if (dec.writer === 'newer') this.paused = 'update-required'
      this.observer.trace(`${this.name} ${reason} ${decision.why}`)
      return null
    }
    this.register(at) // `seen` at push time; the digest ignores it
    const rev = newRev(this.rng.next)
    const wire = encodeWire(this.doc, { dev: this.name, rev, min: 4 })
    const entry: SentPush = { rev, digest: digestDoc(this.doc), answered: false }
    this.sentPushes.push(entry)
    if (this.sentPushes.length > ECHO_MEMORY) this.sentPushes.shift()
    return { wire, decision, sent, dec, entry, at }
  }

  /** A rev this device holds in full (merged, or its own landed push), with its digest. */
  private remember(m: { readonly rev: string | null; readonly digest: string }): void {
    if (m.rev === null) return
    this.lastMerged.push({ rev: m.rev, digest: m.digest })
    if (this.lastMerged.length > ECHO_MEMORY) this.lastMerged.shift()
  }

  /** P3-8: old writers, and a v5 writer that is not this device and never registered (0.10.0). */
  private noteWriter(pulled: Pulled | null, dec: SanitizeResult, at: number): void {
    if (pulled === null) return
    if (dec.writer === 'v084') this.legacySeen.v084 = at
    else if (dec.writer === 'v085') this.legacySeen.v085 = at
    else if (dec.writer === 'v5') {
      const dev = devOf(pulled.payload)
      if (typeof dev === 'string' && dev !== this.name && !dec.doc.devices.has(dev))
        this.legacySeen.v5pre = at
    }
  }
}
