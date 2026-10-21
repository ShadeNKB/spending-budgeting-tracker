// The v0.8 sync engine on the v4 wire: the cycle, realtime, lifecycle triggers and backoff.
// A lazy chunk: `useSyncStore` (eager, small) loads it on first use, the way this module loads
// the Supabase SDK, so the main bundle carries only the sync state the UI reads.
// The state below is module-level on purpose: one engine per app, loaded once.

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
import { nextStampIso, stampMs } from '../lib/stamps'
import type { BackupData, Expense } from '../types'
import {
  ackPendingEdits,
  clearPendingEdits,
  flushPendingSave,
  notePendingBase,
  pendingEditsSnapshot,
  sameValue,
  useExpenseStore,
  type PendingEdit,
} from './useExpenseStore'
import { useUIStore } from './useUIStore'
import {
  clockTime,
  lastSyncCode,
  syncMessage,
  useSyncStore,
  type SyncErrorKind,
  type SyncFailure,
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
const FAILING_TOAST_AFTER_MS = 10 * 60_000
const ECHO_MEMORY = 8
const TOAST_MS = 12_000
const STREAK_KINDS: ReadonlySet<SyncFailure['kind']> = new Set([
  'network',
  'server',
  'permission',
  'invalid',
])

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

// Local writes are counted; `ackedRev` is the count the relay is known to hold.
let localRev = 0
let ackedRev = -1
// True while a merge is applied to the store, so it is not counted as a local write.
let applying = false

// Echo filter: what this tab sent recently.
const sentRevs: string[] = []
const sentUpdatedAt: number[] = []

// Old (v0.8.4-) writers: the codes this tab pushed to, and when it last pushed over a given
// (relay content, our content) pair.
const pushedThisSession = new Set<string>()
const oldWriterMemo = new Map<string, number>()

const toastedOnce = new Set<'too-large' | 'moved'>()
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

function toast(kind: 'error' | 'warning', message: string) {
  useUIStore.getState().pushToast({ kind, message, duration: TOAST_MS })
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

function succeed(snapRev: number, pushed: boolean, changedLocal: boolean, waitingForOld: boolean) {
  // A local write that landed while this cycle awaited the network needs one more cycle.
  if (localRev !== snapRev) again = true
  retryAttempt = 0
  streakToasted = false
  useSyncStore.setState({
    cloudStatus: 'synced',
    lastSyncAt: Date.now(),
    lastError: null,
    pendingLocal: localRev !== ackedRev,
    waitingForOld,
  })
  return { ok: true, pushed, changedLocal } satisfies SyncResult
}

function acknowledge(snapRev: number, snapSeq: number) {
  ackedRev = snapRev
  ackPendingEdits(snapSeq)
}

function goOffline(): SyncResult {
  clearRetry()
  const message = syncMessage('offline')
  const prev = useSyncStore.getState().lastError
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

/** Fences and too-large: no retry; the next trigger runs the cycle again. */
function pause(reason: SyncPauseReason, message: string): SyncResult {
  clearRetry()
  const prev = useSyncStore.getState().lastError
  useSyncStore.setState({
    cloudStatus: 'paused',
    lastError: { kind: reason, message, since: prev?.kind === reason ? prev.since : Date.now() },
  })
  // Once per session. When the owner asked for this cycle, the panel's own toast is that once.
  const group = reason === 'too-large' ? 'too-large' : 'moved'
  if (!toastedOnce.has(group)) {
    toastedOnce.add(group)
    if (!ownerWaiting()) toast(reason === 'too-large' ? 'error' : 'warning', message)
  }
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
  const prev = useSyncStore.getState().lastError
  const since = prev !== null && STREAK_KINDS.has(prev.kind) ? prev.since : Date.now()
  useSyncStore.setState({ cloudStatus: 'error', lastError: { kind, message, since } })
  scheduleRetry()
  // The pill is desktop-only, so a long failure streak in the background also gets one toast
  // on the phone. A cycle the owner asked for shows its own result instead.
  if (!streakToasted && !ownerWaiting() && Date.now() - since >= FAILING_TOAST_AFTER_MS) {
    streakToasted = true
    toast(
      'error',
      `Sync has been failing since ${clockTime(since)}. Your changes are saved on this device.`,
    )
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

const sameContent = (a: Expense, b: Expense) =>
  canon({ ...a, updatedAt: undefined }) === canon({ ...b, updatedAt: undefined })

interface Rebased {
  data: BackupData
  /** Relay copies newer than a pending edit's base, now merged here (they become the base). */
  seen: Expense[]
}

/**
 * Re-applies this device's pending field edits on top of a newer relay copy, so a
 * whole-record merge cannot drop either side's edit of a different field (§12.3 rows 4, 5).
 * A relay copy no newer than what an edit was built on carries nothing new, so plain
 * last-writer-wins stands: a stale overwrite on the relay (there is no compare-and-set on the
 * v4 wire) or an old device's unstamped re-file cannot come back through the rebase. A field
 * both sides changed goes to the newer record, as plain last-writer-wins would.
 */
function rebase(
  merged: BackupData,
  local: readonly Expense[],
  remote: BackupData,
  edits: ReadonlyMap<string, PendingEdit>,
): Rebased {
  if (edits.size === 0) return { data: merged, seen: [] }
  const mine = new Map(local.map((e) => [e.id, e]))
  const theirs = new Map(remote.expenses.map((e) => [e.id, e]))
  const seen: Expense[] = []
  const now = Date.now()
  const expenses = merged.expenses.map((m) => {
    const edit = edits.get(m.id)
    const l = mine.get(m.id)
    const r = theirs.get(m.id)
    if (!edit || !l || !r || stampOf(r) <= edit.baseStamp) return m
    seen.push(r)
    const candidate: Expense = { ...r }
    for (const field of edit.fields) {
      const theirsUntouched = sameValue(field, r[field], edit.base[field])
      Object.assign(candidate, { [field]: (theirsUntouched ? l : m)[field] })
    }
    if (sameContent(candidate, m)) return m // nothing to add to the merge's winner
    if (sameContent(candidate, r)) return r // the relay copy already holds our edits
    return { ...candidate, updatedAt: nextStampIso(now, stampOf(l), stampOf(r)) }
  })
  const changed = expenses.some((e, i) => e !== merged.expenses[i])
  return { data: changed ? { ...merged, expenses } : merged, seen }
}

type Step =
  | { kind: 'done'; result: SyncResult }
  | {
      kind: 'push'
      payload: SyncPayload
      snapRev: number
      snapSeq: number
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
  const snap = pendingEditsSnapshot()
  clearPushTimer() // this cycle carries every change made so far
  const local = useExpenseStore.getState().exportBackup()
  // Rows this version cannot read are merged by no one: they stay in the store (unless the
  // merge has a row or a tombstone with their id) and are never sent.
  const readable = local.expenses.filter(isSyncableExpense)
  const unreadable = local.expenses.filter((row) => !isSyncableExpense(row))
  const mine: BackupData = { ...local, expenses: readable }
  const { data: merged, seen } =
    rem.kind === 'ok'
      ? rebase(mergeBackups(mine, rem.data), readable, rem.data, snap.edits)
      : { data: mine, seen: [] }
  const known = new Set([...merged.expenses.map((e) => e.id), ...(merged.deletedIds ?? [])])
  const keep = unreadable.filter((row) => {
    const id = idOf(row)
    return id === undefined || !known.has(id)
  })

  applying = true
  let changedLocal: boolean
  try {
    changedLocal = useExpenseStore
      .getState()
      .applySync(keep.length ? { ...merged, expenses: [...merged.expenses, ...keep] } : merged)
  } finally {
    applying = false
  }
  // Those relay copies are part of this device's state now: the base of its pending edits.
  for (const copy of seen) notePendingBase(copy.id, copy)

  // Relay rows we could not read go back as they were, unless they have been deleted.
  const dead = new Set(merged.deletedIds ?? [])
  const passthrough =
    rem.kind === 'ok'
      ? rem.passthrough.filter((row) => {
          const id = idOf(row)
          return id === undefined || !dead.has(id)
        })
      : []
  const outgoing = { ...merged, expenses: [...passthrough, ...merged.expenses], version: '4.0' }
  const outKey = contentKey(outgoing)

  const legacy = rem.kind === 'ok' && rem.writer === 'legacy'
  const pushedBefore = pushedThisSession.has(code)
  // An old device wrote after this one: tell the owner to update it.
  if (legacy && pushedBefore) useSyncStore.setState({ legacyWriterAt: Date.now() })
  const memoKey = rem.kind === 'ok' && legacy ? fnv1a(`${rem.key}\n${outKey}`) : null

  const equal = rem.kind === 'ok' && outKey === rem.key
  // Equal content needs no push, except once per session over an old writer's row: the row
  // then carries our stamp, so other devices (and v5) stop reading it as an old device's write.
  if (equal && !(legacy && !pushedBefore)) {
    acknowledge(snapRev, snap.seq)
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
  // Remembered before sending, so our own echo is filtered however early it arrives.
  remember(sentRevs, payload.wr.rev)
  return { kind: 'push', payload, snapRev, snapSeq: snap.seq, changedLocal, memoKey }
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
  if (gen !== setupGen) return offResult()
  remember(sentUpdatedAt, Date.parse(updatedAt))
  pushedThisSession.add(code)
  if (step.memoKey !== null) oldWriterMemo.set(step.memoKey, Date.now())
  acknowledge(step.snapRev, step.snapSeq)
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
      if (!result.ok && gen === setupGen) {
        // A failed cycle ends the loop: the backoff retry or the next trigger runs the next one.
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

function onRemoteChange(change: RemoteChange) {
  const { payload } = change
  if (isRecord(payload)) {
    const wr = payload.wr
    if (isRecord(wr) && typeof wr.rev === 'string' && sentRevs.includes(wr.rev)) return // our echo
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
  // Read before saving: reconnecting with the saved code at start-up is not a switch, so an
  // edit made while the engine loaded keeps its pending entry.
  const previous = lastSyncCode()
  try {
    storage.saveSyncId(syncId)
  } catch {
    // Not persisted (storage full): the code still works for this session.
  }
  const gen = ++setupGen
  stopRealtime()
  clearTimers()
  retryAttempt = 0
  if (previous !== syncId) clearPendingEdits() // they were relative to the old relay copy
  ackedRev = -1 // nothing is known to be on this relay until the first cycle
  useSyncStore.setState({
    syncId,
    cloudStatus: 'idle',
    lastError: null,
    pendingLocal: true,
    waitingForOld: false,
    legacyWriterAt: previous === syncId ? useSyncStore.getState().legacyWriterAt : null,
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
  s.budgets,
  s.budgetUpdatedAt,
  s.budgetDeletedAt,
  s.deletedIds,
]

function onLocalChange() {
  if (applying || !useExpenseStore.getState().hydrated) return
  localRev++
  if (!configured()) return
  if (!useSyncStore.getState().pendingLocal) useSyncStore.setState({ pendingLocal: true })
  scheduleSyncPush()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // Save first (also done by persistence), then send anything not yet on the relay now:
    // a backgrounded app may be suspended before the 3 s push timer fires.
    flushPendingSave()
    if (configured() && (pushTimer !== null || localRev !== ackedRev)) {
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
  // Offline replaces the last failure: no retry runs now, so nothing may still say retrying.
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
