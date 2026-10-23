// The v0.8 sync engine on the v4 wire: the cycle, realtime, lifecycle triggers and backoff.
// A lazy chunk: `useSyncStore` (eager, small) loads it on first use, the way this module loads
// the Supabase SDK, so the main bundle carries only the sync state the UI reads.
// The state below is module-level on purpose: one engine per app, loaded once.

import { storage, WRITER_VERSION } from '../services/storage'
import {
  PayloadTooLargeError,
  SEEN_MAX,
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
import { DEFAULT_CATEGORIES } from '../constants'
import { isRecord } from '../lib/backup'
import { canon, fnv1a } from '../lib/canon'
import { nextStampIso, stampMs } from '../lib/stamps'
import type { BackupData, CategoryMappings, Expense } from '../types'
import {
  ackPendingEdits,
  clearPendingEdits,
  flushPendingSave,
  notePendingBase,
  pendingEditsSnapshot,
  sameValue,
  useExpenseStore,
  type PendingEdit,
  type PendingSnapshot,
} from './useExpenseStore'
import { syncPanelShown, useUIStore } from './useUIStore'
import {
  FAILING_AFTER_MS,
  failingSinceMessage,
  failureSeverity,
  isPaused,
  lastSyncCode,
  syncMessage,
  syncPillShown,
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
// A landed push that carried pending changes is checked by one more pull this much later; see
// `scheduleCheck`.
const CHECK_AFTER_MS = 2500
// An older device that overrides our push is not pushed over again for this long.
const OLD_WRITER_MEMO_MS = 10 * 60_000
const ECHO_MEMORY = 8
// This tab's pushes it can still recognise in a relay copy's `wr` (see `ownPushes`).
const OWN_PUSH_MEMORY = 64
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
let checkTimer: ReturnType<typeof setTimeout> | null = null
// The newest pending-change seq a landed push was checked on (see `scheduleCheck`).
let checkedSeq = -1
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

// Local writes are counted; `ackedRev` is the count the relay is known to have received.
let localRev = 0
let ackedRev = -1

/**
 * This tab's pushes (sent, whether or not the answer came back), each with the pending-change
 * seq it carried. There is no compare-and-set on the v4 wire: a push from another device that
 * was built on a pull taken before ours landed can still land over it, and whole-record
 * last-writer-wins would then drop our changes everywhere. So pending changes are acknowledged
 * only when another device's push names one of ours in its `wr` lineage (it was built on a
 * relay copy that held ours, see `ackedByLineage`), or holds exactly our state. Until then the
 * rebase keeps re-applying them over copies that never saw them.
 */
const ownPushes = new Map<string, number>()
// True while a merge is applied to the store, so it is not counted as a local write.
let applying = false

/**
 * The relay's category names and item mappings as this device last saw them (pulled, or
 * pushed and landed). Against it, a name the relay lost or a mapping it changed since is
 * another device's removal or pick, not news from here to union back. Unknown (null) until the
 * first pull of a setup; `categories` is null while the relay's list is unreadable.
 */
interface RelayLists {
  categories: ReadonlySet<string> | null
  mappings: Readonly<CategoryMappings>
}
let relaySeen: RelayLists | null = null

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
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = null
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

function writerStamp(seen: readonly string[]): WriterStamp {
  return {
    app: WRITER_VERSION,
    dev: storage.getDeviceId(),
    rev: newRev(),
    at: new Date().toISOString(),
    seen,
  }
}

/** Remembers a push of this tab and the pending-change seq it carries. */
function noteOwnPush(rev: string, seq: number) {
  ownPushes.set(rev, seq)
  if (ownPushes.size > OWN_PUSH_MEMORY) {
    const oldest = ownPushes.keys().next()
    if (!oldest.done) ownPushes.delete(oldest.value)
  }
}

/**
 * The pending-change seq that a relay copy acknowledges: the newest of this tab's pushes that a
 * push from another client was built on. `chain` is the copy's rev, then its lineage, newest
 * first; everything after the first rev that is not ours was seen by that client.
 */
function ackedByLineage(chain: readonly string[]): number | null {
  const other = chain.findIndex((rev) => !ownPushes.has(rev))
  let acked: number | null = null
  for (const rev of other < 0 ? [] : chain.slice(other + 1)) {
    const seq = ownPushes.get(rev)
    if (seq !== undefined && (acked === null || seq > acked)) acked = seq
  }
  return acked
}

/**
 * The lineage our push names: the copy it is built on and that copy's lineage, without this
 * tab's own revs (a newer push of ours supersedes them, and only we look for them).
 */
const lineageFor = (chain: readonly string[]): string[] =>
  chain.filter((rev) => rev !== '' && !ownPushes.has(rev)).slice(0, SEEN_MAX)

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

function goOffline(): SyncResult {
  clearRetry()
  const prev = useSyncStore.getState().lastError
  // A pause outlasts the outage: coming back online does not end it, so being offline must
  // not promise a sync. The pause, its banner and its words stay.
  if (prev !== null && isPaused(prev.kind)) {
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
    if (!ownerWaiting()) toast(failureSeverity({ kind: reason, since: Date.now() }), message)
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
  // on the phone. A cycle the owner asked for shows its own result instead, and where the pill
  // or the open Sync panel already says so, a toast would only say it twice.
  if (!streakToasted && !ownerWaiting() && Date.now() - since >= FAILING_AFTER_MS) {
    streakToasted = true
    if (!syncPillShown() && !syncPanelShown(useUIStore.getState())) {
      toast(failureSeverity({ kind, since }), failingSinceMessage(since))
    }
  }
  return { ok: false, error: kind, message }
}

/**
 * A push from another device built on a pull taken before ours landed can land over ours
 * about a round trip later; this pull, soon after, sees it and rebases our pending changes over
 * it even if its realtime event is lost. If the network has gone meanwhile, its failure starts
 * the retries that catch up once it is back. It acknowledges nothing by itself (see
 * `ownPushes`).
 */
function scheduleCheck() {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    checkTimer = null
    void requestCycle()
  }, CHECK_AFTER_MS)
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
  /**
   * Relay copies newer than a pending edit's base, now merged here (see `notePendingBase`),
   * each with the copy this device wrote over it, if it did.
   */
  seen: { copy: Expense; written: Expense | null }[]
}

/**
 * Re-applies this device's pending field edits on top of a newer relay copy, so a
 * whole-record merge cannot drop either side's edit of a different field (§12.3 rows 4, 5).
 * A relay copy no newer than what an edit was built on carries nothing new, so plain
 * last-writer-wins stands: a stale overwrite on the relay (there is no compare-and-set on the
 * v4 wire) or an old device's unstamped re-file cannot come back through the rebase. A field
 * both sides changed goes to the newer record, as plain last-writer-wins would, unless the
 * other copy holds a value this device held (then the other device has not changed it).
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
  const seen: Rebased['seen'] = []
  const now = Date.now()
  const expenses = merged.expenses.map((m) => {
    const edit = edits.get(m.id)
    const l = mine.get(m.id)
    const r = theirs.get(m.id)
    if (!edit || !l || !r || stampOf(r) <= edit.baseStamp) return m
    const candidate: Expense = { ...r }
    for (const field of edit.fields) {
      // Holding the base or a value written here is no change from the other side.
      const own = edit.own.get(field) ?? [edit.base[field]]
      const theirsUntouched = own.some((value) => sameValue(field, r[field], value))
      Object.assign(candidate, { [field]: (theirsUntouched ? l : m)[field] })
    }
    // Nothing to add to the merge's winner, or the relay copy already holds our edits.
    const kept = sameContent(candidate, m) ? m : sameContent(candidate, r) ? r : null
    if (kept) {
      seen.push({ copy: r, written: null })
      return kept
    }
    const written = { ...candidate, updatedAt: nextStampIso(now, stampOf(l), stampOf(r)) }
    seen.push({ copy: r, written })
    return written
  })
  const changed = expenses.some((e, i) => e !== merged.expenses[i])
  return { data: changed ? { ...merged, expenses } : merged, seen }
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

/** Category names a row (readable or not, here or on the relay) or a budget still uses. */
function usedNames(merged: BackupData, ...others: readonly (readonly unknown[])[]): Set<string> {
  const used = new Set(Object.keys(merged.budgets ?? {}))
  for (const e of merged.expenses) used.add(e.category)
  for (const rows of others) {
    for (const row of rows)
      if (isRecord(row) && typeof row.category === 'string') used.add(row.category)
  }
  return used
}

const ownValue = (record: Readonly<CategoryMappings>, key: string): string | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

/**
 * Category names and item mappings carry no stamps on the v4 wire, so the pure merge can only
 * union names and keep the larger mapping value: a rename, a removal or a new pick for an item
 * would come back undone. Changes made here win until a pull sees the relay holding them (as
 * field edits do, so a stale peer push cannot take them away). A change made elsewhere is told
 * apart from this device's own state by the relay copy last seen here, and adopted. A name a row
 * or budget uses is always kept, and a relay list that cannot be read removes nothing.
 */
function rebaseLists(
  merged: BackupData,
  local: BackupData,
  remote: BackupData,
  remoteListReadable: boolean,
  snap: PendingSnapshot,
  used: ReadonlySet<string>,
): Pick<BackupData, 'categories' | 'categoryMappings'> {
  const here = new Set(local.categories)
  const there = new Set(remote.categories)
  const seenNames = remoteListReadable ? (relaySeen?.categories ?? null) : null
  const kept = merged.categories.filter((name) => {
    if (used.has(name)) return true
    const mine = snap.categories.get(name)
    if (mine !== undefined) return mine
    // Gone from one side since the relay copy seen here: removed there or here, so not news.
    return seenNames === null || !seenNames.has(name) || (here.has(name) && there.has(name))
  })

  const seenMappings = relaySeen?.mappings ?? null
  const mappings = Object.entries(merged.categoryMappings).map(([key, value]): [string, string] => {
    const l = ownValue(local.categoryMappings, key)
    const r = ownValue(remote.categoryMappings, key)
    if (l === undefined || r === undefined || l === r) return [key, value]
    // Picked here: ours, unless the relay holds a pick this device never held: another device
    // picked without having seen ours, and its pick, which landed, wins.
    const own = snap.mappings.get(key)
    if (own) return [key, own.includes(r) ? l : r]
    // Unchanged here since the relay copy seen last: the relay holds another device's pick.
    if (seenMappings !== null && ownValue(seenMappings, key) === l) return [key, r]
    return [key, value]
  })

  return {
    categories: kept.length > 0 ? kept : [...DEFAULT_CATEGORIES],
    categoryMappings: Object.fromEntries(mappings),
  }
}

/** The lists a payload holds, as the base for the next merge. */
const listsOf = (data: Pick<BackupData, 'categories' | 'categoryMappings'>): RelayLists => ({
  categories: new Set(data.categories),
  mappings: data.categoryMappings,
})

type Step =
  | { kind: 'done'; result: SyncResult }
  | {
      kind: 'push'
      payload: SyncPayload
      snapRev: number
      changedLocal: boolean
      memoKey: string | null
      /** The pending-change seq the push carries, if it carries any (see `scheduleCheck`). */
      pendingSeq: number | null
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

  // Who wrote the relay copy, and what it was built on (v0.8.5 copies only). Changes another
  // client has built on are acknowledged before the merge: they are its to change now.
  const chain = rem.kind === 'ok' && rem.writer === 'v085' ? [rem.rev ?? '', ...rem.seen] : []
  const ownCopy = rem.kind === 'ok' && rem.rev !== null && ownPushes.has(rem.rev)
  const acked = ackedByLineage(chain)
  if (acked !== null) ackPendingEdits(acked)

  const snapRev = localRev
  const snap = pendingEditsSnapshot()
  clearPushTimer() // this cycle carries every change made so far
  const local = useExpenseStore.getState().exportBackup()
  // Rows this version cannot read are merged by no one: they stay in the store (unless the
  // merge has a row or a tombstone with their id) and are never sent.
  const readable = local.expenses.filter(isSyncableExpense)
  const unreadable = local.expenses.filter((row) => !isSyncableExpense(row))
  const mine: BackupData = { ...local, expenses: readable }
  const legacy = rem.kind === 'ok' && rem.writer === 'legacy'
  let merged = mine
  let seen: Rebased['seen'] = []
  if (rem.kind === 'ok') {
    const plain = mergeBackups(mine, rem.data)
    const tied = legacy ? keepLocalRefiles(plain, readable, rem.data.expenses) : plain
    ;({ data: merged, seen } = rebase(tied, readable, rem.data, snap.edits))
  }
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

  if (rem.kind === 'ok') {
    // A relay list that is not a list of names (damaged) tells nothing about removals.
    const listReadable = isRecord(raw) && Array.isArray(raw.categories) && raw.categories.length > 0
    const used = usedNames(merged, keep, passthrough)
    merged = { ...merged, ...rebaseLists(merged, local, rem.data, listReadable, snap, used) }
    relaySeen = {
      ...listsOf(rem.data),
      categories: listReadable ? new Set(rem.data.categories) : null,
    }
  } else {
    relaySeen = listsOf({ categories: [], categoryMappings: {} })
  }

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
  for (const { copy, written } of seen) notePendingBase(copy.id, copy, written)

  const outgoing = { ...merged, expenses: [...passthrough, ...merged.expenses], version: '4.0' }
  const outKey = contentKey(outgoing)

  const pushedBefore = pushedThisSession.has(code)
  // An old device wrote after this one: tell the owner to update it.
  if (legacy && pushedBefore) useSyncStore.setState({ legacyWriterAt: Date.now() })
  const memoKey = rem.kind === 'ok' && legacy ? fnv1a(`${rem.key}\n${outKey}`) : null

  const equal = rem.kind === 'ok' && outKey === rem.key
  // Equal content needs no push, except once per session over an old writer's row: the row
  // then carries our stamp, so other devices (and v5) stop reading it as an old device's write.
  if (equal && !(legacy && !pushedBefore)) {
    ackedRev = snapRev
    // Another client wrote exactly our state, so it holds our changes and builds on them from
    // here on. Our own copy read back proves nothing: a stale push may still land over it.
    if (!ownCopy) ackPendingEdits(snap.seq)
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

  const payload: SyncPayload = { ...outgoing, wr: writerStamp(lineageFor(chain)) }
  // Remembered before sending, so our own echo is filtered however early it arrives, and a
  // push that lands although its answer never came back (a timeout) is still known as ours.
  remember(sentRevs, payload.wr.rev)
  noteOwnPush(payload.wr.rev, snap.seq)
  const pending = snap.edits.size > 0 || snap.categories.size > 0 || snap.mappings.size > 0
  return {
    kind: 'push',
    payload,
    snapRev,
    changedLocal,
    memoKey,
    pendingSeq: pending ? snap.seq : null,
  }
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
  relaySeen = listsOf(step.payload)
  // The relay received this state, so "Synced" is honest. The pending changes it carried stay
  // pending until another client builds on them (see `ownPushes`).
  ackedRev = step.snapRev
  // Once per batch of pending changes: a later push that carries only changes already checked
  // on gives the check nothing new to look for.
  if (step.pendingSeq !== null && step.pendingSeq > checkedSeq) {
    checkedSeq = step.pendingSeq
    scheduleCheck()
  }
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
  checkedSeq = -1
  if (previous !== syncId) clearPendingEdits() // they were relative to the old relay copy
  ackedRev = -1 // nothing is known to be on this relay until the first cycle
  relaySeen = null
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
  relaySeen = null
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
