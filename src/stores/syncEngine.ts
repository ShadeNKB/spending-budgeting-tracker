// The v0.8 sync engine on the v4 wire: the cycle, realtime, lifecycle triggers and backoff.
// A lazy chunk: `useSyncStore` (eager, small) loads it on first use, the way this module loads
// the Supabase SDK, so the main bundle carries only the sync state the UI reads.
// The state below is module-level on purpose: one engine per app, loaded once.
//
// The merge is whole-record last-writer-wins with deterministic ties (`mergeBackups`): every
// device resolves every pair of copies alike, so the devices converge and a cycle pushes only
// when the merge holds something the relay does not. The v4 wire has one stamp per record:
// when two devices edit the same record before either has seen the other's edit, the later
// record wins whole (v5 merges per field).

import { storage, WRITER_VERSION } from '../services/storage'
import {
  PayloadTooLargeError,
  SyncTransportError,
  contentKey,
  isSyncableExpense,
  mergeBackups,
  pullSync,
  pushSync,
  readRemote,
  subscribeSync,
  type RemoteChange,
  type SyncPayload,
  type WriterStamp,
} from '../services/syncService'
import { isRecord } from '../lib/backup'
import { canon, fnv1a } from '../lib/canon'
import { stampMs } from '../lib/stamps'
import type { BackupData, Expense } from '../types'
import { applySync } from './applySync'
import { useExpenseStore } from './useExpenseStore'
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

const PUSH_DEBOUNCE_MS = 3000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60_000
const REMOTE_COALESCE_MS = 300
const REMOTE_MIN_GAP_MS = 2000
const RESUME_AFTER_MS = 30_000
// An older device that overrides our push is not pushed over again for this long.
const OLD_WRITER_MEMO_MS = 10 * 60_000
const ECHO_MEMORY = 8

// ---------------------------------------------------------------------------
// Module-level coordination state
// ---------------------------------------------------------------------------

// Generation counter: a cycle or subscription from an older setup is discarded.
let setupGen = 0
let realtimeUnsub: (() => void) | null = null
let subscribingGen: number | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let remoteTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0
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

// Local writes are counted, so a cycle knows whether one landed while it awaited the network.
let localRev = 0
// True while a merge is applied to the store, so it is not counted as a local write.
let applying = false

// Echo filter: what this tab sent recently. A push is known by its rev AND its content, so a
// write that kept our `wr` (a copy of our push with edits) is still news.
interface SentPush {
  rev: string
  /** Hash of the `contentKey` of what was sent (a key is as long as the payload, up to 1 MB). */
  hash: string
  /** The `contentKey` option it was compared with. */
  mappingStamps: boolean
  /**
   * The relay answered it, so it landed before this tab sent anything newer. A push that was
   * never answered (it timed out) can still land later, over a newer one.
   */
  answered: boolean
}
const sentPushes: SentPush[] = []
const sentUpdatedAt: number[] = []

// Old (v0.8.4-) writers: the codes this tab pushed to, and when it last pushed over a given
// (relay content, our content) pair.
const pushedThisSession = new Set<string>()
const oldWriterMemo = new Map<string, number>()

const toastedOnce = new Set<'too-large' | 'moved' | 'permission'>()
// A failure streak runs from the first failed attempt to the next cycle that reaches the relay.
// Offline spells in between make no attempt, so they neither end it nor restart it.
let streakSince: number | null = null
let streakToasted = false
let started = false

const isOffline = () => typeof navigator !== 'undefined' && !navigator.onLine

// Only loaded in builds with a relay, so a saved code is all "configured" needs.
const configured = (): boolean => useSyncStore.getState().syncId !== null

const idOf = (row: unknown): string | undefined =>
  isRecord(row) && typeof row.id === 'string' ? row.id : undefined

const stampOf = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

/** The owner is waiting on this cycle's result in the panel, which shows it there. */
const ownerWaiting = (): boolean => current.some((w) => w.user) || queued.some((w) => w.user)

function clearPushTimer() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

function clearTimers() {
  clearPushTimer()
  clearRetry()
  if (remoteTimer) clearTimeout(remoteTimer)
  remoteTimer = null
}

function stopRealtime() {
  const unsubscribe = realtimeUnsub
  realtimeUnsub = null
  unsubscribe?.()
}

function remember<T>(list: T[], value: T) {
  list.push(value)
  if (list.length > ECHO_MEMORY) list.shift()
}

function newRev(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function writerStamp(): WriterStamp {
  return {
    app: WRITER_VERSION,
    dev: storage.getDeviceId(),
    rev: newRev(),
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const offResult = (): SyncResult => ({ ok: false, error: 'off', message: syncMessage('off') })

/**
 * A cycle that ended with the relay holding this device's state as of `snapRev`, unless
 * `heldBack` (a push held back for an old device that keeps overwriting the relay).
 */
function succeed(snapRev: number, pushed: boolean, changedLocal: boolean, heldBack: boolean) {
  // A local write that landed while this cycle awaited the network needs one more cycle.
  const behind = localRev !== snapRev
  if (behind) again = true
  retryAttempt = 0
  endStreak()
  useSyncStore.setState({
    cloudStatus: 'synced',
    lastSyncAt: Date.now(),
    lastError: null,
    pendingLocal: behind || heldBack,
    waitingForOld: heldBack,
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

class InvalidRemoteError extends Error {}

function fail(err: unknown): SyncResult {
  if (err instanceof PayloadTooLargeError) {
    return pause('too-large', syncMessage('too-large', Math.round(err.bytes / 1024)))
  }
  const kind: SyncErrorKind = err instanceof SyncTransportError ? err.kind : 'invalid'
  if (kind === 'network' && isOffline()) return goOffline()
  const message = syncMessage(kind)
  streakSince ??= Date.now()
  const since = streakSince
  useSyncStore.setState({ cloudStatus: 'error', lastError: { kind, message, since } })
  scheduleRetry()
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

function scheduleRetry() {
  clearRetry()
  if (isOffline()) return // the 'online' handler resumes
  retryAttempt = Math.min(retryAttempt + 1, 16)
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (retryAttempt - 1))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void requestCycle()
  }, delay)
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/** The relay before its first push: merging with it normalises the local copy. */
const EMPTY: BackupData = {
  expenses: [],
  categories: [],
  categoryMappings: {},
  deletedIds: [],
  exportDate: '',
  version: '4.0',
}

/**
 * A v0.8.4 device re-files rows by keyword (and renames) without touching their stamps, so its
 * copy ties with this one and differs only in the category. The content tie-break would adopt
 * its re-file for some rows (F-015 spreading again); this device keeps its own copy instead.
 * Only for a legacy writer: v0.8.5 and v5 stamp every change, so a tie from them is a real tie
 * that every device must resolve alike.
 */
function keepLocalRefiles(
  merged: BackupData,
  local: readonly Expense[],
  remote: readonly Expense[],
): BackupData {
  const mine = new Map(local.map((e) => [e.id, e]))
  const theirs = new Map(remote.map((e) => [e.id, e]))
  const expenses = merged.expenses.map((m) => {
    const l = mine.get(m.id)
    const r = theirs.get(m.id)
    if (!l || !r || m === l || l.category === r.category || stampOf(l) !== stampOf(r)) return m
    if (canon({ ...l, category: undefined }) !== canon({ ...r, category: undefined })) return m
    return l
  })
  return expenses.some((e, i) => e !== merged.expenses[i]) ? { ...merged, expenses } : merged
}

type Step =
  | { kind: 'done'; result: SyncResult }
  | {
      kind: 'push'
      payload: SyncPayload
      sent: SentPush
      snapRev: number
      changedLocal: boolean
      memoKey: string | null
    }

/**
 * The synchronous section: read the pulled payload, merge it into the CURRENT local state,
 * apply the result and decide what to push, with no await in between, so a local write can
 * never be overwritten by a merge of an older snapshot.
 */
function mergeStep(code: string, raw: unknown): Step {
  const rem = readRemote(raw)
  if (rem.kind === 'moved' || rem.kind === 'update-required') {
    return { kind: 'done', result: pause(rem.kind, syncMessage(rem.kind)) }
  }
  if (rem.kind === 'invalid') throw new InvalidRemoteError(rem.reason)

  const snapRev = localRev
  clearPushTimer() // this cycle carries every change made so far
  const local = useExpenseStore.getState().exportBackup()
  // Rows this version cannot read are merged by no one: they stay in the store (unless the
  // merge has a row or a tombstone with their id) and are never sent.
  const readable = local.expenses.filter(isSyncableExpense)
  const unreadable = local.expenses.filter((row) => !isSyncableExpense(row))
  const mine: BackupData = { ...local, expenses: readable }
  const legacy = rem.kind === 'ok' && rem.writer === 'legacy'
  const remote = rem.kind === 'ok' ? rem.data : EMPTY
  const plain = mergeBackups(mine, remote)
  const merged = legacy ? keepLocalRefiles(plain, readable, remote.expenses) : plain

  const known = new Set([...merged.expenses.map((e) => e.id), ...(merged.deletedIds ?? [])])
  const keep = unreadable.filter((row) => {
    const id = idOf(row)
    return id === undefined || !known.has(id)
  })
  // Relay rows we could not read go back as they were, unless they have been deleted.
  const dead = new Set(merged.deletedIds ?? [])
  const passthrough =
    rem.kind === 'ok'
      ? rem.passthrough.filter((row) => {
          const id = idOf(row)
          return id === undefined || !dead.has(id)
        })
      : []

  applying = true
  let changedLocal: boolean
  try {
    changedLocal = applySync(
      keep.length ? { ...merged, expenses: [...merged.expenses, ...keep] } : merged,
    )
  } finally {
    applying = false
  }

  const outgoing = { ...merged, expenses: [...passthrough, ...merged.expenses], version: '4.0' }
  // A v0.8.4 writer drops the mapping stamps on every push: against its copy, the mappings
  // themselves are what can be compared.
  const keyOpts = { mappingStamps: !legacy }
  const outKey = contentKey(outgoing, keyOpts)
  const relayKey = rem.kind === 'ok' ? contentKey(raw, keyOpts) : null

  const pushedBefore = pushedThisSession.has(code)
  // An old device wrote after this one: tell the owner to update it.
  if (legacy && pushedBefore) useSyncStore.setState({ legacyWriterAt: Date.now() })
  const memoKey = legacy && relayKey !== null ? fnv1a(`${relayKey}\n${outKey}`) : null

  const equal = outKey === relayKey
  // Equal content needs no push, except once per session over an old writer's row: the row
  // then carries our stamp, so other devices (and v5) stop reading it as an old device's write.
  if (equal && !(legacy && !pushedBefore)) {
    return { kind: 'done', result: succeed(snapRev, false, changedLocal, false) }
  }
  if (
    !equal &&
    memoKey !== null &&
    (oldWriterMemo.get(memoKey) ?? Number.NEGATIVE_INFINITY) > Date.now() - OLD_WRITER_MEMO_MS
  ) {
    // An old device already overwrote this exact push; pushing again would ping-pong.
    return { kind: 'done', result: succeed(snapRev, false, changedLocal, true) }
  }

  const payload: SyncPayload = { ...outgoing, wr: writerStamp() }
  // Remembered before sending, so our own echo is filtered however early it arrives, and a
  // push that lands although its answer never came back (a timeout) is still known as ours.
  const sent: SentPush = {
    rev: payload.wr.rev,
    hash: fnv1a(outKey),
    mappingStamps: keyOpts.mappingStamps,
    answered: false,
  }
  remember(sentPushes, sent)
  return { kind: 'push', payload, sent, snapRev, changedLocal, memoKey }
}

async function runCycle(): Promise<SyncResult> {
  const code = useSyncStore.getState().syncId
  if (code === null) return offResult()
  const gen = setupGen
  if (isOffline()) return goOffline()
  useSyncStore.setState({ cloudStatus: 'syncing' })

  let raw: unknown
  try {
    raw = await pullSync(code)
  } catch (err) {
    return gen === setupGen ? fail(err) : offResult()
  }
  if (gen !== setupGen) return offResult() // disconnected or switched code: discard

  let step: Step
  try {
    step = mergeStep(code, raw)
  } catch (err) {
    return fail(err)
  }
  if (step.kind === 'done') return step.result

  let updatedAt: string
  try {
    updatedAt = (await pushSync(code, step.payload)).updatedAt
  } catch (err) {
    return gen === setupGen ? fail(err) : offResult()
  }
  step.sent.answered = true
  if (gen !== setupGen) return offResult()
  remember(sentUpdatedAt, Date.parse(updatedAt))
  pushedThisSession.add(code)
  if (step.memoKey !== null) oldWriterMemo.set(step.memoKey, Date.now())
  // The relay received this state, so "Synced" is honest.
  return succeed(step.snapRev, true, step.changedLocal, false)
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
      const gen = setupGen
      let result: SyncResult
      try {
        result = await runCycle()
      } catch (err) {
        result = fail(err)
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

function requestCycle(user = false): Promise<SyncResult> {
  if (!configured()) return Promise.resolve(offResult())
  return new Promise((resolve) => {
    queued.push({ resolve, user })
    if (running) again = true
    else void runLoop()
  })
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * The event is our own push coming back: our rev, and exactly the content we sent, from a push
 * that cannot have landed over a newer one (the latest, or one the relay answered before
 * anything newer was sent). An older push that was never answered (it timed out) and lands
 * after a newer one has put the relay back: that is news, and the cycle it starts repairs it.
 */
function isOwnEcho(payload: Record<string, unknown>): boolean {
  const wr = payload.wr
  if (!isRecord(wr)) return false
  const rev = wr.rev
  const sent = sentPushes.find((push) => push.rev === rev)
  return (
    sent !== undefined &&
    (sent.answered || sent === sentPushes.at(-1)) &&
    fnv1a(contentKey(payload, { mappingStamps: sent.mappingStamps })) === sent.hash
  )
}

function onRemoteChange(change: RemoteChange) {
  const { payload } = change
  if (isRecord(payload)) {
    if (isOwnEcho(payload)) return
  } else if (
    payload === undefined &&
    change.updatedAt !== null &&
    sentUpdatedAt.includes(Date.parse(change.updatedAt))
  ) {
    return // our echo of a row too large to carry its payload
  }
  // Coalesce a burst into one pull, and start remote-triggered cycles at least 2 s apart.
  if (remoteTimer) return
  const wait = Math.max(REMOTE_COALESCE_MS, lastRemoteCycleAt + REMOTE_MIN_GAP_MS - Date.now())
  remoteTimer = setTimeout(() => {
    remoteTimer = null
    lastRemoteCycleAt = Date.now()
    void requestCycle()
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
        if (gen === setupGen) void requestCycle()
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
  const result = await requestCycle(user)
  if (gen === setupGen && !isOffline()) await ensureSubscribed(gen)
  return result
}

/** Stops everything this engine runs; useSyncStore clears the code and the state. */
export function stop(): void {
  setupGen++ // discards a running cycle and any pending subscription
  stopRealtime()
  clearTimers()
  retryAttempt = 0
}

export function triggerSync(opts?: { resetBackoff?: boolean }): Promise<SyncResult> {
  if (opts?.resetBackoff) retryAttempt = 0
  return requestCycle(true)
}

export function scheduleSyncPush(): void {
  if (!configured()) return
  clearPushTimer()
  pushTimer = setTimeout(() => {
    pushTimer = null
    void requestCycle()
  }, PUSH_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// Wiring: local changes and app lifecycle → cycles
// ---------------------------------------------------------------------------

type ExpenseSnapshot = ReturnType<typeof useExpenseStore.getState>

const syncedCollections = (s: ExpenseSnapshot): readonly unknown[] => [
  s.expenses,
  s.categories,
  s.categoryMappings,
  s.mappingUpdatedAt,
  s.budgets,
  s.budgetUpdatedAt,
  s.budgetDeletedAt,
  s.deletedIds,
]

function onLocalChange() {
  if (applying || !useExpenseStore.getState().hydrated) return
  localRev++
  if (!configured()) return
  // A change the relay has not seen: the next cycle pushes it, even over an old device's copy
  // (the old-writer memo holds back only the exact push that device already overwrote).
  const { pendingLocal, waitingForOld } = useSyncStore.getState()
  if (!pendingLocal || waitingForOld) {
    useSyncStore.setState({ pendingLocal: true, waitingForOld: false })
  }
  scheduleSyncPush()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // Persistence has already written the save (its listener runs first, from bootstrap). Send
    // anything not yet on the relay now: a backgrounded app may be suspended before the 3 s
    // push timer fires.
    if (configured() && (pushTimer !== null || useSyncStore.getState().pendingLocal)) {
      clearPushTimer()
      void requestCycle()
    }
    return
  }
  if (!configured()) return
  if (Date.now() - (useSyncStore.getState().lastSyncAt ?? 0) > RESUME_AFTER_MS) {
    retryAttempt = 0
    void ensureSubscribed(setupGen)
    void requestCycle()
  }
}

function onOnline() {
  if (!configured()) return
  retryAttempt = 0
  void ensureSubscribed(setupGen)
  void requestCycle()
}

function onOffline() {
  // Offline replaces the last failure (no retry runs now, so nothing may still say retrying),
  // except a pause, which going offline does not end.
  if (configured()) goOffline()
}

/** Wires local changes and lifecycle events to cycles. Runs once, when the engine loads. */
export function start(): void {
  if (started) return
  started = true
  useExpenseStore.subscribe(syncedCollections, onLocalChange, {
    equalityFn: (a, b) => a.every((value, i) => value === b[i]),
  })
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  }
}
