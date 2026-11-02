// The sync engine: PR-0's cycle, realtime, lifecycle triggers and backoff, now running the v5
// core codec on the local engine (DATA-ENGINE-SPEC §11.3 without CAS or RPC; PR-2 track spec §9).
// A lazy chunk: `useSyncStore` (eager, small) loads it on first use, the way this module loads
// the Supabase SDK, so the main bundle carries only the sync state the UI reads.
// The state below is module-level on purpose: one engine per app, loaded once.
//
// Every pulled payload is decoded by `decodeWire` (bad rows quarantined, never merged blind) and
// joined into the local doc by the engine's SyncPort (`applyRemote`: guard, snapshot, merge,
// commit, journal). The merge is a join, so a cycle pushes only when the relay lacks something:
// against a v5 writer when the digests differ, against an old writer (0.9.2 or 0.8.4) only what
// it will keep (`decidePush`). The push is a plain upsert of the v5 wire (`x5` rides along, and
// 0.9.2 reads the rest as the v4 payload it knows).

import {
  MEMO_WINDOW,
  PLAIN_MIN,
  PUSH_MAX_WAIT,
  PUSH_QUIET,
  REMOTE_COALESCE,
  WIRE_PUSH_MAX,
} from '../data/core/constants'
import { EMPTY_DOC, digestDoc } from '../data/core/doc'
import { newRev } from '../data/core/ids'
import { commitPush, decidePush } from '../data/core/push'
import type {
  CycleReason,
  Doc,
  ExpenseRec,
  OutboxKey,
  PushDecision,
  SanitizeResult,
  Stamp,
  WriterClass,
} from '../data/core/types'
import { decodeWire, encodeWire, wireString } from '../data/core/wire'
import { SafetyCopyError } from '../data/local/refusal'
import { isRecord } from '../lib/backup'
import {
  PayloadTooLargeError,
  SyncTransportError,
  pullSync,
  pushSync,
  subscribeSync,
  type RemoteChange,
} from '../services/syncService'
import {
  getSyncPort,
  useExpenseStore,
  whenHydrated,
  type RemoteApplied,
  type SyncPort,
} from './useExpenseStore'
import { syncPanelShown, useUIStore } from './useUIStore'
import {
  FAILING_AFTER_MS,
  failingSinceMessage,
  failureSeverity,
  keepCode,
  keptOffline,
  lookForNewBuild,
  noSyncSurface,
  syncMessage,
  syncToast,
  useSyncStore,
  type SyncErrorKind,
  type SyncPauseReason,
  type SyncResult,
} from './useSyncStore'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60_000
const REMOTE_MIN_GAP_MS = 2000
const RESUME_AFTER_MS = 30_000
const ECHO_MEMORY = 8
/** Foreign payloads kept from realtime events until the next cycle merges them (P2-10). */
const NEWS_MEMORY = 4
/** A relay copy this device cannot read is pushed over at most this often (P2-8). */
export const REPAIR_EVERY_MS = MEMO_WINDOW
/** How long a cycle waits for another tab's cycle before it runs anyway (a frozen tab, P2-18). */
const LOCK_WAIT_MS = 35_000
const LOCK_NAME = 'st5:sync'
/** An old writer's sighting is persisted at most this often (it costs an envelope write). */
const LEGACY_SEEN_EVERY_MS = 60_000
/** The mass-removal toast stays this long, like every Undo for a bulk change (P2-12, P2-20). */
export const MASS_UNDO_MS = 30_000

export const REPAIRED_MESSAGE = 'The sync copy was damaged. Restored it from this device.'

// ---------------------------------------------------------------------------
// Module-level coordination state
// ---------------------------------------------------------------------------

// Generation counter: a cycle or subscription from an older setup is discarded.
let setupGen = 0
let realtimeUnsub: (() => void) | null = null
let subscribingGen: number | null = null
let quietTimer: ReturnType<typeof setTimeout> | null = null
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let remoteTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0
let retryReason: CycleReason = 'again'
let lastRemoteCycleAt = Number.NEGATIVE_INFINITY

// Single flight: one cycle at a time. A trigger during a cycle sets `again` and waits for
// the next cycle, so no caller ever gets a result that predates its trigger.
interface Waiter {
  resolve: (result: SyncResult) => void
  /** Asked for by the owner (Sync now, Generate, Connect): the panel shows the result. */
  user: boolean
}
let running = false
let again = false
let queued: Waiter[] = []
let current: Waiter[] = []
/** Why the next cycle runs (the strongest reason asked for since the last one started). */
let nextReason: CycleReason | null = null

// Echo filter: what this tab sent recently. A push is known by its rev AND its content, so a
// write that kept our rev is still news unless it holds exactly the doc we sent (P2-9).
interface SentPush {
  rev: string
  /** digestDoc of the doc as sent (demo rows left out on a demo build). */
  digest: string
  /**
   * The relay answered it, so it landed before this tab sent anything newer. A push that was
   * never answered (it timed out) can still land later, over a newer one.
   */
  answered: boolean
}
const sentPushes: SentPush[] = []
const sentUpdatedAt: number[] = []

// News (P2-10): foreign payloads that realtime delivered. Without compare-and-set a push that
// crosses ours on the wire can be overwritten on the relay before this device ever pulls it;
// the event still carried it, so the next cycle merges it (the merge is a join, so a stale or
// repeated payload is harmless) and the relay gets it back from here.
const news: Record<string, unknown>[] = []

// The codes this tab pushed to: an old device that writes after that is overwriting our copy.
const pushedThisSession = new Set<string>()

const toastedOnce = new Set<'too-large' | 'moved' | 'permission' | 'repair'>()
// A failure streak runs from the first failed attempt to the next cycle that reaches the relay.
// Offline spells in between make no attempt, so they neither end it nor restart it.
let streakSince: number | null = null
let streakToasted = false
let started = false

// The local engine's port this engine listens to (a re-hydrate may hand out a new one).
let attachedPort: SyncPort | null = null
let detachPort: (() => void) | null = null

const isOffline = () => typeof navigator !== 'undefined' && !navigator.onLine

// Only loaded in builds with a relay, so a saved code is all "configured" needs.
const configured = (): boolean => useSyncStore.getState().syncId !== null

/** The owner is waiting on this cycle's result in the panel, which shows it there. */
const ownerWaiting = (): boolean => current.some((w) => w.user) || queued.some((w) => w.user)

/** Reasons that may re-publish v5-only facts to a relay an old device wrote (§11.4). */
const REFRESH_REASONS: ReadonlySet<CycleReason> = new Set(['boot', 'resume', 'local-change'])

/** Keeps a refresh reason once asked for, so a coalesced cycle never loses it. */
const strongest = (held: CycleReason | null, asked: CycleReason): CycleReason =>
  held !== null && REFRESH_REASONS.has(held) ? held : asked

function clearPushTimers() {
  if (quietTimer) clearTimeout(quietTimer)
  if (maxWaitTimer) clearTimeout(maxWaitTimer)
  quietTimer = null
  maxWaitTimer = null
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function clearTimers() {
  clearPushTimers()
  clearRetry()
  if (remoteTimer) clearTimeout(remoteTimer)
  remoteTimer = null
}

function stopRealtime() {
  const unsubscribe = realtimeUnsub
  realtimeUnsub = null
  unsubscribe?.()
}

function remember<T>(list: T[], value: T, size = ECHO_MEMORY) {
  list.push(value)
  if (list.length > size) list.shift()
}

/** "1 entry", "2,000 entries": counts read the same here as in Settings and the undo toasts. */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

// ---------------------------------------------------------------------------
// The local engine
// ---------------------------------------------------------------------------

/** Listens to the port's commits; a port handed out by a re-hydrate replaces the old one. */
function attach(port: SyncPort): void {
  if (attachedPort === port) return
  detachPort?.()
  attachedPort = port
  detachPort = port.onCommit(onCommit)
}

/** The port, attached, or null while the engine has not hydrated. */
function livePort(): SyncPort | null {
  const port = getSyncPort()
  if (port !== null) attach(port)
  return port
}

/**
 * Resolves once local data is loaded (true), or as soon as it can never be (false: the local
 * engine's code failed to load, so there is nothing to merge into).
 */
function engineReady(): Promise<boolean> {
  if (getSyncPort() !== null) return Promise.resolve(true)
  if (useExpenseStore.getState().bootError !== null) return Promise.resolve(false)
  return new Promise((resolve) => {
    const unsubscribe = useExpenseStore.subscribe((s) => {
      if (s.bootError === null) return
      unsubscribe()
      resolve(false)
    })
    void whenHydrated().then(() => {
      unsubscribe()
      resolve(getSyncPort() !== null)
    })
  })
}

/** The doc as the wire carries it: demo rows stay on this device (P2-22). */
function wireDoc(doc: Doc, omit: ((id: string) => boolean) | undefined): Doc {
  if (omit === undefined || ![...doc.expenses.keys()].some(omit)) return doc
  const kept = new Map<string, ExpenseRec>()
  for (const [id, rec] of doc.expenses) if (!omit(id)) kept.set(id, rec)
  return { ...doc, expenses: kept }
}

/** What the transport gives for a row that does not exist yet: nothing to merge. */
const MISSING: SanitizeResult = {
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

/** A writer whose copy is merged: v5, 0.9.2 (v085) and 0.8.4 (v084). */
const mergeable = (writer: WriterClass): boolean =>
  writer === 'v5' || writer === 'v085' || writer === 'v084'

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const offResult = (): SyncResult => ({ ok: false, error: 'off', message: syncMessage('off') })

/**
 * A cycle that ended with the relay holding this device's state as of `snapRev`, except the
 * `waiting` changes an old device on the relay has not taken yet, and unless `heldBack` (a push
 * held back for an old device that keeps overwriting the relay).
 */
function succeed(
  snapRev: number,
  pushed: boolean,
  changedLocal: boolean,
  waiting: number,
  heldBack = false,
) {
  const port = livePort()
  // A local write that landed while this cycle awaited the network needs one more cycle.
  const behind = port !== null && port.localRev() !== snapRev
  if (behind) {
    again = true
    nextReason = strongest(nextReason, 'local-change')
  }
  retryAttempt = 0
  endStreak()
  useSyncStore.setState({
    cloudStatus: 'synced',
    lastSyncAt: Date.now(),
    lastError: null,
    // "Synced" is only true of an empty outbox (I11): every change is known to be on the relay.
    pendingLocal: behind || heldBack || (port !== null && port.outbox().size > 0),
    waitingForOld: heldBack || waiting > 0,
  })
  return { ok: true, pushed, changedLocal } satisfies SyncResult
}

function goOffline(): SyncResult {
  clearRetry()
  const prev = useSyncStore.getState().lastError
  // A pause, refused access and a streak failing for 10 minutes outlast the outage: coming
  // back online does not end them, so being offline must not promise a sync. The failure, its
  // banner and its words stay (none of them says "retrying").
  if (prev !== null && keptOffline(prev)) {
    return { ok: false, error: prev.kind, message: prev.message }
  }
  const message = syncMessage('offline')
  useSyncStore.setState({
    cloudStatus: 'offline',
    lastError: {
      kind: 'offline',
      message,
      since: prev?.kind === 'offline' ? prev.since : Date.now(),
    },
  })
  return { ok: false, error: 'offline', message }
}

function endStreak() {
  streakSince = null
  streakToasted = false
}

/** Fences and too-large: no retry; the next trigger runs the cycle again. */
function pause(reason: Exclude<SyncPauseReason, 'reload'>, message: string): SyncResult {
  clearRetry()
  endStreak() // the relay answered
  const prev = useSyncStore.getState().lastError
  const fence = reason !== 'too-large'
  // A newer build moved the relay: look for it now, so the Reload that follows runs it.
  if (fence && prev?.kind !== reason) lookForNewBuild()
  // Once per session. When the owner asked for this cycle, the panel's own toast is that once,
  // and with Settings › Sync open its banner says it. Shown before the state changes: the pill
  // then finds the toast saying it and stays quiet, so a screen reader hears it once.
  const group = fence ? 'moved' : 'too-large'
  if (!toastedOnce.has(group)) {
    toastedOnce.add(group)
    if (!ownerWaiting() && !syncPanelShown(useUIStore.getState())) {
      syncToast(failureSeverity({ kind: reason, since: Date.now() }), message, fence)
    }
  }
  useSyncStore.setState({
    cloudStatus: 'paused',
    lastError: { kind: reason, message, since: prev?.kind === reason ? prev.since : Date.now() },
  })
  return { ok: false, error: reason, message }
}

/** The local engine never loaded on this page, so there is nothing to sync until a reload. */
function engineDown(): SyncResult {
  const prev = useSyncStore.getState().lastError
  const message = syncMessage('reload')
  useSyncStore.setState({
    cloudStatus: 'paused',
    lastError: {
      kind: 'reload',
      message,
      since: prev?.kind === 'reload' ? prev.since : Date.now(),
    },
  })
  return { ok: false, error: 'reload', message }
}

/** A relay copy this device cannot read, while its repair is not due yet (P2-8). */
class InvalidRemoteError extends Error {}

function fail(err: unknown, reason: CycleReason): SyncResult {
  if (err instanceof PayloadTooLargeError) {
    return pause('too-large', syncMessage('too-large', Math.round(err.bytes / 1024)))
  }
  const kind: SyncErrorKind = err instanceof SyncTransportError ? err.kind : 'invalid'
  if (kind === 'network' && isOffline()) return goOffline()
  // A merge the engine refused for want of room for its safety copy says so in its own words:
  // the synced copy read fine, and nothing was removed here.
  const message = err instanceof SafetyCopyError ? err.message : syncMessage(kind)
  streakSince ??= Date.now()
  const since = streakSince
  useSyncStore.setState({ cloudStatus: 'error', lastError: { kind, message, since } })
  scheduleRetry(reason)
  // The pill is desktop-only, so on a phone a toast is what says it: refused access (red, it
  // needs the owner) at once and once per session, any other streak once it has failed for 10
  // minutes. A cycle the owner asked for shows its own result instead, and where the pill or
  // the open Sync panel already says so, a toast would only say it twice.
  if (kind === 'permission' && !toastedOnce.has('permission')) {
    toastedOnce.add('permission')
    if (!ownerWaiting() && noSyncSurface()) syncToast('error', message)
  }
  if (!streakToasted && !ownerWaiting() && Date.now() - since >= FAILING_AFTER_MS) {
    streakToasted = true
    if (noSyncSurface()) syncToast(failureSeverity({ kind, since }), failingSinceMessage(since))
  }
  return { ok: false, error: kind, message }
}

function scheduleRetry(reason: CycleReason) {
  clearRetry()
  if (isOffline()) return // the 'online' handler resumes
  retryReason = reason
  retryAttempt = Math.min(retryAttempt + 1, 16)
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (retryAttempt - 1))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void requestCycle(retryReason)
  }, delay)
}

// ---------------------------------------------------------------------------
// What a merge tells the owner
// ---------------------------------------------------------------------------

/** The guard tripped (§11.9): applied, snapshotted and journaled; one tap brings it all back. */
function toastMassRemoval(mass: NonNullable<RemoteApplied['mass']>): void {
  useUIStore.getState().pushToast({
    kind: 'warning',
    message: `Your other device removed ${entries(mass.count)}`,
    duration: MASS_UNDO_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void restoreMass(mass.entryId)
      },
    },
  })
}

async function restoreMass(entryId: string): Promise<void> {
  const ui = useUIStore.getState()
  try {
    const { applied } = await useExpenseStore.getState().restoreJournal(entryId)
    ui.pushToast({
      kind: 'success',
      message: applied > 0 ? `Restored ${entries(applied)}` : 'Those entries are already back.',
    })
  } catch (err) {
    ui.pushToast({
      kind: 'error',
      message: err instanceof Error ? err.message : "Couldn't restore those entries.",
    })
  }
}

/** An old device wrote the relay: remember when (§11.10), and banner a v0.8.4 overwriting us. */
function noteWriter(code: string, writer: WriterClass, port: SyncPort, now: number): void {
  if (writer !== 'v084' && writer !== 'v085') return
  const seen = port.meta().legacySeen
  if (now - (seen[writer] ?? Number.NEGATIVE_INFINITY) >= LEGACY_SEEN_EVERY_MS) {
    port.setMeta({ legacySeen: { ...seen, [writer]: now } })
  }
  // An old device wrote after this one: tell the owner to update it.
  if (writer === 'v084' && pushedThisSession.has(code)) {
    useSyncStore.setState({ legacyWriterAt: now })
  }
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

const REPAIR: PushDecision = { kind: 'push', why: 'repair', memoKey: null }
const MERGE_ONLY: PushDecision = { kind: 'none', why: 'newer', memoKey: null }

type Step =
  | { kind: 'done'; result: SyncResult }
  | {
      kind: 'push'
      wire: unknown
      sent: SentPush
      /** The outbox entries this push carries (acknowledged once it lands). */
      outbox: readonly (readonly [OutboxKey, Stamp])[]
      dec: SanitizeResult
      decision: PushDecision
      snapRev: number
      changedLocal: boolean
    }

const done = (result: SyncResult): Step => ({ kind: 'done', result })

/**
 * The synchronous section: merge the news and the pulled payload into the CURRENT local doc,
 * commit it and decide what to push, with no await in between, so a local write can never be
 * overwritten by a merge of an older snapshot (F-001).
 */
function mergeStep(code: string, raw: unknown, reason: CycleReason): Step {
  const port = livePort()
  if (port === null) return done(engineDown())
  const now = Date.now()
  clearPushTimers() // this cycle carries every change made so far
  let changedLocal = false
  const take = (applied: RemoteApplied) => {
    changedLocal ||= applied.changedLocal
    if (applied.mass !== null) toastMassRemoval(applied.mass)
  }

  // News first: what realtime carried and the relay may since have lost to a crossing push. A
  // merge the engine refuses for want of room for its safety copy keeps that payload and the
  // rest for the next cycle: the event may be the only copy of what it carried.
  const pending = news.splice(0)
  for (const [i, payload] of pending.entries()) {
    const item = decodeWire(payload, 'remote', { reuse: port.doc(), at: now })
    if (!mergeable(item.writer)) continue
    try {
      take(port.applyRemote(item))
    } catch (err) {
      if (err instanceof SafetyCopyError) news.unshift(...pending.slice(i))
      throw err
    }
  }

  const missing = raw === null || raw === undefined
  const dec = missing ? MISSING : decodeWire(raw, 'remote', { reuse: port.doc(), at: now })
  if (dec.writer === 'moved') return done(pause('moved', syncMessage('moved')))
  if (dec.writer === 'e2e') return done(pause('update-required', syncMessage('update-required')))
  const repair = dec.writer === 'invalid'
  if (repair) {
    // Kept for the owner (needs attention), never merged; pushed over at most every 10 minutes,
    // so two devices that disagree about the copy cannot overwrite each other in a loop.
    port.quarantine(dec.report.quarantined)
    if (now - port.meta().repairAt < REPAIR_EVERY_MS) throw new InvalidRemoteError()
    // The quarantine entry holds an excerpt; the push over the copy waits until this device
    // keeps all of it (P2-8, P2-16: never overwrite the only copy of something).
    if (!port.keepRelayCopy(raw)) throw new InvalidRemoteError()
  }

  const snapRev = port.localRev()
  const sent = [...port.outbox()]
  // A newer SpendTrack's copy is merged too (its data is ours as well); it is only never pushed over.
  if (!missing && (mergeable(dec.writer) || dec.writer === 'newer')) take(port.applyRemote(dec))
  noteWriter(code, dec.writer, port, now)

  const omitIds = port.omitIds()
  const local = wireDoc(port.doc(), omitIds)
  let decision =
    dec.writer === 'newer'
      ? MERGE_ONLY
      : repair
        ? REPAIR
        : decidePush(local, dec, missing ? null : { etag: '' }, reason, port.meta().memo, now)
  // The memo holds back the push an old device already overwrote, never a change made since:
  // that one gets its push (bounded by the owner's own changes, so it cannot loop).
  if (decision.kind === 'suppressed' && sent.length > 0) {
    decision = { kind: 'push', why: 'adoptable', memoKey: decision.memoKey }
  }
  if (decision.kind !== 'push') {
    const waiting = port.ack(sent, dec, decision)
    // A newer SpendTrack wrote the relay: its data is merged here, and nothing is pushed over it.
    if (dec.writer === 'newer')
      return done(pause('update-required', syncMessage('update-required')))
    // Held back: an old device overwrote this exact push, so the relay lacks what is here.
    return done(succeed(snapRev, false, changedLocal, waiting, decision.kind === 'suppressed'))
  }

  const rev = newRev(() => port.rng())
  const opts = { dev: port.deviceId(), rev, min: PLAIN_MIN, omitIds }
  const chars = wireString(port.doc(), opts).length
  if (chars > WIRE_PUSH_MAX) {
    return done(pause('too-large', syncMessage('too-large', Math.round(chars / 1024))))
  }
  // Remembered before sending, so our own echo is filtered however early it arrives, and a
  // push that lands although its answer never came back (a timeout) is still known as ours.
  const sentPush: SentPush = { rev, digest: digestDoc(local), answered: false }
  remember(sentPushes, sentPush)
  return {
    kind: 'push',
    wire: encodeWire(port.doc(), opts),
    sent: sentPush,
    outbox: sent,
    dec,
    decision,
    snapRev,
    changedLocal,
  }
}

/** After a push lands: the memo, the outbox and the repair stamp (never before, M4). */
function landed(step: Extract<Step, { kind: 'push' }>): number {
  const port = livePort()
  if (port === null) return 0
  const now = Date.now()
  const repaired = step.decision.why === 'repair'
  port.setMeta({
    lastRev: step.sent.rev,
    memo: commitPush(port.meta().memo, step.decision, now),
    ...(repaired ? { repairAt: now } : {}),
  })
  const waiting = port.ack(step.outbox, step.dec, 'pushed')
  if (repaired && !toastedOnce.has('repair')) {
    toastedOnce.add('repair')
    useUIStore.getState().pushToast({ kind: 'warning', message: REPAIRED_MESSAGE })
  }
  return waiting
}

async function cycle(code: string, gen: number, reason: CycleReason): Promise<SyncResult> {
  useSyncStore.setState({ cloudStatus: 'syncing' })
  let raw: unknown
  try {
    raw = await pullSync(code)
  } catch (err) {
    return gen === setupGen ? fail(err, reason) : offResult()
  }
  if (gen !== setupGen) return offResult() // disconnected or switched code: discard

  let step: Step
  try {
    step = mergeStep(code, raw, reason)
  } catch (err) {
    return fail(err, reason)
  }
  if (step.kind === 'done') return step.result

  let updatedAt: string
  try {
    updatedAt = (await pushSync(code, step.wire)).updatedAt
  } catch (err) {
    return gen === setupGen ? fail(err, reason) : offResult()
  }
  step.sent.answered = true
  if (gen !== setupGen) return offResult()
  remember(sentUpdatedAt, Date.parse(updatedAt))
  pushedThisSession.add(code)
  // The relay received this state, so "Synced" is honest.
  return succeed(step.snapRev, true, step.changedLocal, landed(step))
}

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null
  const locks: unknown = Reflect.get(navigator, 'locks')
  return isLockManager(locks) ? locks : null
}

const isLockManager = (value: unknown): value is LockManager =>
  isRecord(value) && typeof value.request === 'function'

/**
 * One cycle at a time across this device's tabs (P2-18), so two tabs never push over each other.
 * A tab that holds the lock too long (frozen in the background) cannot stop this one syncing:
 * the merge is a join, so two cycles at once only cost a push.
 */
async function withLock(run: () => Promise<SyncResult>): Promise<SyncResult> {
  const locks = lockManager()
  if (locks === null) return run()
  const giveUp = new AbortController()
  const timer = setTimeout(() => {
    giveUp.abort()
  }, LOCK_WAIT_MS)
  // An object, not a `let`: the grant happens in a callback the type checker cannot follow.
  const lock = { granted: false }
  try {
    return await locks.request(LOCK_NAME, { signal: giveUp.signal }, () => {
      lock.granted = true
      clearTimeout(timer)
      return run()
    })
  } catch (err) {
    // A cycle that failed inside the lock fails as it would without one.
    if (lock.granted) throw err
    // Never granted: another tab held it too long (a frozen tab), or this page may not lock.
    clearTimeout(timer)
    return run()
  }
}

async function runCycle(reason: CycleReason): Promise<SyncResult> {
  const code = useSyncStore.getState().syncId
  if (code === null) return offResult()
  const gen = setupGen
  if (isOffline()) return goOffline()
  // A cycle may be asked for before local data has loaded (start-up with a saved code): it
  // merges into the loaded doc, never into an empty one.
  const ready = await engineReady()
  if (gen !== setupGen) return offResult()
  if (!ready) return engineDown()
  if (isOffline()) return goOffline()
  return withLock(() => cycle(code, gen, reason))
}

// Read through a function: cycles change these while the loop awaits.
const moreRequested = () => again || queued.length > 0

async function runLoop(): Promise<void> {
  running = true
  try {
    do {
      current = queued
      queued = []
      again = false
      clearRetry()
      const reason = nextReason ?? 'again'
      nextReason = null
      const gen = setupGen
      let result: SyncResult
      try {
        result = await runCycle(reason)
      } catch (err) {
        result = fail(err, reason)
      }
      for (const waiter of current) waiter.resolve(result)
      current = []
      // A failed cycle ends the loop when its backoff retry runs the next one, so a failing
      // server is not hammered. A failure that schedules no retry (offline, paused) leaves
      // nothing to run a trigger that came in during the cycle, and the `online` that ends an
      // outage is exactly such a trigger: that one gets a fresh cycle.
      if (!result.ok && gen === setupGen && (retryTimer !== null || result.error === 'off')) {
        for (const waiter of queued) waiter.resolve(result)
        queued = []
        again = false
      }
    } while (moreRequested())
  } finally {
    running = false
  }
}

function requestCycle(reason: CycleReason, user = false): Promise<SyncResult> {
  if (!configured()) return Promise.resolve(offResult())
  return new Promise((resolve) => {
    queued.push({ resolve, user })
    nextReason = strongest(nextReason, reason)
    if (running) again = true
    else void runLoop()
  })
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * The event is our own push coming back: our rev, exactly the doc we sent, from a push that
 * cannot have landed over a newer one (the latest, or one the relay answered before anything
 * newer was sent). An older push that was never answered (it timed out) and lands after a newer
 * one has put the relay back: that is news, and the cycle it starts repairs it (P2-9).
 */
function isOwnEcho(payload: Record<string, unknown>): boolean {
  const x5 = payload.x5
  if (!isRecord(x5)) return false
  const rev = x5.rev
  const sent = sentPushes.find((push) => push.rev === rev)
  if (sent === undefined || !(sent.answered || sent === sentPushes.at(-1))) return false
  const port = getSyncPort()
  if (port === null) return false
  const echoed = decodeWire(payload, 'remote', { reuse: port.doc(), at: Date.now() })
  return digestDoc(echoed.doc) === sent.digest
}

function onRemoteChange(change: RemoteChange) {
  const { payload } = change
  if (isRecord(payload)) {
    if (isOwnEcho(payload)) return
    remember(news, payload, NEWS_MEMORY)
  } else if (
    payload === undefined &&
    change.updatedAt !== null &&
    sentUpdatedAt.includes(Date.parse(change.updatedAt))
  ) {
    return // our echo of a row too large to carry its payload
  }
  // Coalesce a burst into one pull, and start remote-triggered cycles at least 2 s apart.
  if (remoteTimer) return
  const wait = Math.max(REMOTE_COALESCE, lastRemoteCycleAt + REMOTE_MIN_GAP_MS - Date.now())
  remoteTimer = setTimeout(() => {
    remoteTimer = null
    lastRemoteCycleAt = Date.now()
    void requestCycle('remote')
  }, wait)
}

async function ensureSubscribed(gen: number): Promise<void> {
  const code = useSyncStore.getState().syncId
  if (code === null || gen !== setupGen || realtimeUnsub !== null || subscribingGen === gen) return
  subscribingGen = gen
  try {
    const unsubscribe = await subscribeSync(code, {
      onRemoteChange: (change) => {
        if (gen === setupGen) onRemoteChange(change)
      },
      // Events are not replayed after a drop, so every (re)subscribe catches up with a cycle.
      onSubscribed: () => {
        if (gen === setupGen) void requestCycle('resubscribe')
      },
    })
    if (gen === setupGen) {
      stopRealtime()
      realtimeUnsub = unsubscribe
    } else {
      unsubscribe()
    }
  } catch {
    // The SDK could not load (offline): 'online' or the next resume subscribes again.
  } finally {
    if (subscribingGen === gen) subscribingGen = null
  }
}

// ---------------------------------------------------------------------------
// Actions (called through useSyncStore)
// ---------------------------------------------------------------------------

/** Connects to `syncId`: saves it, runs the first cycle, then subscribes to realtime. */
export async function setupSync(syncId: string, user: boolean): Promise<SyncResult> {
  // The same code again (start-up with the saved code, Connect with the linked one) keeps
  // what is known about the devices on it.
  const sameCode = useSyncStore.getState().syncId === syncId
  keepCode(syncId)
  const gen = ++setupGen
  stopRealtime()
  clearTimers()
  retryAttempt = 0
  endStreak()
  if (!sameCode) news.length = 0 // another code's relay copy is no news for this one
  useSyncStore.setState({
    syncId,
    cloudStatus: 'idle',
    lastError: null,
    // Nothing is known to be on this relay until the first cycle.
    pendingLocal: true,
    waitingForOld: false,
    legacyWriterAt: sameCode ? useSyncStore.getState().legacyWriterAt : null,
  })
  // Pull first, then subscribe; SUBSCRIBED runs one more cycle to close the gap between.
  // The first cycle on a code is a boot: it may publish what an old writer's copy lacks (§11.4).
  const result = await requestCycle('boot', user)
  if (gen === setupGen && !isOffline()) await ensureSubscribed(gen)
  return result
}

/** Stops everything this engine runs; useSyncStore clears the code and the state. */
export function stop(): void {
  setupGen++ // discards a running cycle and any pending subscription
  stopRealtime()
  clearTimers()
  retryAttempt = 0
  news.length = 0
}

export function triggerSync(opts?: { resetBackoff?: boolean }): Promise<SyncResult> {
  if (opts?.resetBackoff) retryAttempt = 0
  return requestCycle('manual', true)
}

/** A local change: sync once it has been quiet for 1.5 s, and at most 5 s after the first. */
export function scheduleSyncPush(): void {
  if (!configured()) return
  if (quietTimer) clearTimeout(quietTimer)
  const fire = () => {
    clearPushTimers()
    void requestCycle('local-change')
  }
  quietTimer = setTimeout(fire, PUSH_QUIET)
  maxWaitTimer ??= setTimeout(fire, PUSH_MAX_WAIT)
}

// ---------------------------------------------------------------------------
// Wiring: local commits and app lifecycle → cycles
// ---------------------------------------------------------------------------

function onCommit(source: 'local' | 'tab' | 'remote' | 'boot') {
  if (!configured()) return
  if (source === 'local' || source === 'tab') {
    // A change the relay has not seen: the next cycle pushes it, even over an old device's copy.
    const { pendingLocal, waitingForOld } = useSyncStore.getState()
    if (!pendingLocal || waitingForOld) {
      useSyncStore.setState({ pendingLocal: true, waitingForOld: false })
    }
    scheduleSyncPush()
    return
  }
  if (source === 'boot') {
    // Local data was loaded again: what it still has to send is what the outbox says.
    const port = getSyncPort()
    if (port !== null && port.outbox().size > 0 && !useSyncStore.getState().pendingLocal) {
      useSyncStore.setState({ pendingLocal: true })
    }
  }
}

/** Something not yet on the relay: a change waiting for its push, or the durable outbox. */
function unsent(): boolean {
  if (quietTimer !== null) return true
  const port = getSyncPort()
  return port === null ? useSyncStore.getState().pendingLocal : port.outbox().size > 0
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // The local engine has already written the save (its listener runs first, from bootstrap).
    // Send anything not yet on the relay now: a backgrounded app may be suspended before the
    // push timer fires.
    if (configured() && unsent()) {
      clearPushTimers()
      void requestCycle('hide')
    }
    return
  }
  if (!configured()) return
  if (Date.now() - (useSyncStore.getState().lastSyncAt ?? 0) > RESUME_AFTER_MS) {
    retryAttempt = 0
    void ensureSubscribed(setupGen)
    void requestCycle('resume')
  }
}

function onOnline() {
  if (!configured()) return
  retryAttempt = 0
  void ensureSubscribed(setupGen)
  void requestCycle('online')
}

function onOffline() {
  // Offline replaces the last failure (no retry runs now, so nothing may still say retrying),
  // except a pause, which going offline does not end.
  if (configured()) goOffline()
}

/** Wires local commits and lifecycle events to cycles. Runs once, when the engine loads. */
export function start(): void {
  if (started) return
  started = true
  void whenHydrated().then(() => {
    livePort()
  })
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  }
}
