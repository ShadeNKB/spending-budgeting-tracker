// The sync engine v5 (DATA-ENGINE-SPEC §11.3; PR-3 track spec §3.4 to §3.9): PR-0's single-flight
// cycle and PR-2's synchronous merge section, now over a transport that can compare-and-set,
// reach the relay's sync functions, and answer "has anything changed?" with a HEAD.
// A lazy chunk: `useSyncStore` (eager, small) loads it on first use, the way this module loads
// the Supabase SDK, so the main bundle carries only the sync state the UI reads.
// The state below is module-level on purpose: one engine per app, loaded once.
//
// Every pulled payload is decoded by `decodeWire` (bad rows quarantined, never merged blind) and
// joined into the local doc by the engine's SyncPort (`applyRemote`: guard, snapshot, merge,
// commit, journal). The merge is a join, so a cycle pushes only when the relay lacks something:
// against a v5 writer when the digests differ, against an old writer (0.9.2 or 0.8.4) only what
// it will keep (`decidePush`). A push that loses a compare-and-set is merged again from the
// relay's newer copy; without compare-and-set (the default build) it is the plain upsert 0.10.0
// sends, and realtime news keeps a crossing push from losing anything.

import {
  BACKOFF_BASE,
  BACKOFF_CAP,
  BACKOFF_JITTER,
  CAS_FORCE_AFTER,
  CYCLE_ATTEMPTS_MAX,
  MEMO_WINDOW,
  PLAIN_MIN,
  POLL_VISIBLE,
  PUSH_MAX_WAIT,
  PUSH_QUIET,
  REMOTE_COALESCE,
  STORM_CYCLES,
  STORM_WINDOW,
  WIRE_PUSH_MAX,
} from '../data/core/constants'
import { maskCode, normalizeUuid } from '../data/core/codes'
import { EMPTY_DOC, digestDoc, mergeDoc } from '../data/core/doc'
import { fnv36 } from '../data/core/hash'
import { newRev } from '../data/core/ids'
import { commitPush, decidePush } from '../data/core/push'
import type {
  CycleReason,
  DeviceInfo,
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
import {
  deviceRows,
  placeV5pre,
  readiness,
  registerFirst,
  registryEntry,
  wroteItself,
} from '../data/sync/registry'
import { isRecord } from '../lib/backup'
import { whenIdle } from '../lib/whenIdle'
import { storage } from '../services/storage'
import {
  PayloadTooLargeError,
  RELAY_PIN,
  SyncTransportError,
  announce,
  etagTime,
  openTransport,
  sameEtag,
  subscribeSync,
  topicOf,
  type ModeHint,
  type Pulled,
  type PushOutcome,
  type RelayMode,
  type RemoteChange,
  type Transport,
} from '../services/syncService'
import {
  getSyncPort,
  useExpenseStore,
  whenHydrated,
  type RemoteApplied,
  type RestoreResult,
  type SyncPort,
} from './useExpenseStore'
import { syncPanelShown, useUIStore } from './useUIStore'
import {
  FAILING_AFTER_MS,
  SYNC_OFF_MESSAGE,
  SYNC_RELOAD_MESSAGE,
  failingSinceMessage,
  failureSeverity,
  keepCode,
  keptOffline,
  lookForNewBuild,
  noSyncSurface,
  syncToast,
  useSyncStore,
  type SyncErrorKind,
  type SyncPauseReason,
  type SyncResult,
  type SyncView,
} from './useSyncStore'

// ---------------------------------------------------------------------------
// Copy (the engine's words; every surface shows them as they are)
// ---------------------------------------------------------------------------

export function syncMessage(
  kind: SyncErrorKind | SyncPauseReason | 'off' | 'offline',
  kb?: number,
): string {
  switch (kind) {
    case 'offline':
      return "You're offline. Changes are saved on this device and will sync when you're back online."
    case 'network':
      return "Couldn't reach the sync server. Your changes are saved on this device."
    case 'server':
      return 'The sync server had a problem. Your changes are saved on this device.'
    case 'permission':
      return 'The sync server refused access. Your data is safe on this device.'
    case 'invalid':
      return "The synced copy couldn't be read, so nothing was merged. Your data is safe on this device."
    case 'busy':
      return 'Your devices kept syncing at the same moment. Your changes are saved on this device.'
    case 'too-large':
      return `Sync paused: your data${kb === undefined ? '' : ` (${String(kb)} KB)`} is too large for the sync server. It's still saved here — export a backup.`
    case 'moved':
    case 'update-required':
      return 'Sync moved to a newer version. Reload SpendTrack to update.'
    case 'reload':
      return SYNC_RELOAD_MESSAGE
    case 'not-found':
      return 'No synced data found for this code. Check it on your other device.'
    case 'denied':
      return 'Sync paused: the sync server refused access. Your data is safe on this device.'
    case 'off':
      return SYNC_OFF_MESSAGE
  }
}

/** A 53400 from the relay: it will not take another row. */
export const FULL_RELAY_MESSAGE = 'The sync relay is full. Your changes are saved on this device.'
export const REPAIRED_MESSAGE = 'The sync copy was damaged. Restored it from this device.'
const INVALID_CODE_MESSAGE = "That code isn't valid."

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const REMOTE_MIN_GAP_MS = 2000
/** A resume is a HEAD now, so it may run this often (was 30 s). */
const RESUME_AFTER_MS = 5000
/** A hidden tab keeps its channel this long (a quick app switch keeps it). */
const HIDDEN_UNSUBSCRIBE_MS = 30_000
/** Polling while live updates are on: a socket that died silently is found this soon. */
const POLL_LIVE_MS = 5 * 60_000
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
/** The conflict toast stays as long as the other toasts with a Review. */
export const CONFLICT_TOAST_MS = 8000
/** st_sync_push refuses a payload whose jsonb text is over 1.2 MB (migration 004). */
const RPC_PAYLOAD_MAX = 1_258_291
/** jsonb text is longer than JSON.stringify's (a space after every `:` and `,`). */
const JSONB_SLACK = 1.15
const RETRY_ATTEMPTS_CAP = 16

/** Reasons a HEAD may answer: nothing pending here, so only a change on the relay matters (P3-4). */
const HEAD_REASONS: ReadonlySet<CycleReason> = new Set(['resume', 'poll', 'resubscribe', 'online'])

/** This build's version, in every registry entry it pushes (P3-7). */
const APP = __APP_VERSION__

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
let pollTimer: ReturnType<typeof setTimeout> | null = null
let hiddenTimer: ReturnType<typeof setTimeout> | null = null
let stormTimer: ReturnType<typeof setTimeout> | null = null
let pollDueAt = 0
let retryAttempt = 0
let retryReason: CycleReason = 'again'
/** A retry was due while the page was hidden: becoming visible runs it at once. */
let retryPaused = false
let lastRemoteCycleAt = Number.NEGATIVE_INFINITY
let lastCycleAt = Number.NEGATIVE_INFINITY

// Single flight: one cycle at a time. A trigger during a cycle sets `again` and waits for
// the next cycle, so no caller ever gets a result that predates its trigger.
interface Waiter {
  resolve: (result: SyncResult) => void
  /** Asked for by the owner (Sync now, Generate, Connect): the panel shows the result. */
  user: boolean
}
let running = false
let runningReason: CycleReason | null = null
let again = false
let queued: Waiter[] = []
let current: Waiter[] = []
/** Why the next cycle runs (the strongest reason asked for since the last one started). */
let nextReason: CycleReason | null = null

/**
 * This device may create (or re-create) the relay copy: it generated the code, or a cycle has
 * found the copy since it joined (P3-5). A join that finds nothing writes nothing.
 */
let established = true
/** The relay mode of the last cycle (the registry entry says it). */
let mode: RelayMode = RELAY_PIN === 'rpc' ? 'rpc' : 'table'
/**
 * When a cycle of this setup last left the relay at `lastEtag`: the port it merged into, and the
 * local revision the relay then held all of (null: merged, but it lacks what is here, e.g. too
 * large). A HEAD answers for a cycle only within that setup and while nothing was committed here
 * since (P3-4): a Disconnect keeps the etag, and a change made with sync off reaches no outbox
 * (M34), so only a full cycle after the setup can find it.
 */
let held: { readonly gen: number; readonly port: SyncPort; readonly rev: number | null } | null =
  null
/** A table call was refused this session (migration 005): row events are not armed again. */
let tableDenied = false

// Realtime: whether the channel is joined, and whether it carries row events.
let joinedNow = false
/** A subscription is open and has not reported yet: live updates are neither on nor off. */
let connecting = false
let liveRowEvents = false
/** This subscription's row events were refused twice: it runs on Broadcast alone. */
let rowEventsFailed = false
let liveState: SyncView['live'] = 'off'
/** Remote events start no cycle until then (the storm breaker, P3-14). */
let stormUntil = 0
const remoteCycles: number[] = []

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
/** The etags our landed pushes got back (a row event too large to carry its payload). */
const sentEtags: string[] = []
/** Revs this tab has fully merged, with the doc they carried (§3.6). */
const merged: { readonly rev: string; readonly digest: string }[] = []

// News (P2-10): foreign payloads that realtime delivered. Without compare-and-set a push that
// crosses ours on the wire can be overwritten on the relay before this device ever pulls it;
// the event still carried it, so the next cycle merges it (the merge is a join, so a stale or
// repeated payload is harmless) and the relay gets it back from here.
const news: Record<string, unknown>[] = []

// The codes this tab pushed to: an old device that writes after that is overwriting our copy.
const pushedThisSession = new Set<string>()

const toastedOnce = new Set<string>()
// A failure streak runs from the first failed attempt to the next cycle that reaches the relay.
// Offline spells in between make no attempt, so they neither end it nor restart it.
let streakSince: number | null = null
let streakToasted = false
let started = false

// The local engine's port this engine listens to (a re-hydrate may hand out a new one).
let attachedPort: SyncPort | null = null
let detachPort: (() => void) | null = null

let topic: { readonly code: string; readonly value: Promise<string> } | null = null
let lastView: SyncView | null = null
let sizePct: number | null = null
let sizeMeasured = false

const isOffline = () => typeof navigator !== 'undefined' && !navigator.onLine
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

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

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function clearTimers() {
  clearPushTimers()
  clearRetry()
  stopPolling()
  if (remoteTimer) clearTimeout(remoteTimer)
  if (hiddenTimer) clearTimeout(hiddenTimer)
  if (stormTimer) clearTimeout(stormTimer)
  remoteTimer = null
  hiddenTimer = null
  stormTimer = null
  stormUntil = 0
  remoteCycles.length = 0
  retryPaused = false
}

function stopRealtime() {
  const unsubscribe = realtimeUnsub
  realtimeUnsub = null
  joinedNow = false
  connecting = false
  liveRowEvents = false
  unsubscribe?.()
}

function remember<T>(list: T[], value: T, size = ECHO_MEMORY) {
  list.push(value)
  if (list.length > size) list.shift()
}

/** "1 entry", "2,000 entries": counts read the same here as in Settings and the undo toasts. */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

/** The realtime topic of a code, computed once per code (the raw code is never a topic). */
function topicFor(code: string): Promise<string> {
  if (topic?.code !== code) topic = { code, value: topicOf(code) }
  return topic.value
}

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

/** Live entries the owner would count (demo rows left out on a demo build). */
function liveCount(doc: Doc, omit: ((id: string) => boolean) | undefined): number {
  if (omit === undefined) return doc.expenses.size
  let n = 0
  for (const id of doc.expenses.keys()) if (!omit(id)) n++
  return n
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

/** This device's registry entry as it should be now (P3-7). */
function entryNow(port: SyncPort, now: number): DeviceInfo {
  return registryEntry(port.doc().devices.get(port.deviceId()), APP, mode, now)
}

/** This tab's registry entry needs a push of its own: a new app version or relay mode (P3-7). */
const entryDue = (port: SyncPort, now: number): boolean =>
  registerFirst(port.doc().devices.get(port.deviceId()), entryNow(port, now))

/** The relay copy this device last merged or wrote, when it belongs to `code` (P3-3). */
function etagOf(port: SyncPort, code: string): string | null {
  const meta = port.meta()
  return meta.etagFor === fnv36(code) ? meta.lastEtag : null
}

/**
 * The relay is at `etag`, merged here in this setup; `rev`: the local revision it holds all of
 * (null when it lacks something here).
 */
function setEtag(port: SyncPort, code: string, etag: string, rev: number | null): void {
  const meta = port.meta()
  const etagFor = fnv36(code)
  if (meta.lastEtag !== etag || meta.etagFor !== etagFor) port.setMeta({ lastEtag: etag, etagFor })
  held = { gen: setupGen, port, rev }
}

/** A joined device found its relay copy: from now on it may re-create it (P3-5). */
function establish(code: string): void {
  if (established) return
  established = true
  storage.markEstablished(code)
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const offResult = (): SyncResult => ({ ok: false, error: 'off', message: syncMessage('off') })

/** The outbox size and what the store says it is, kept equal after every commit and ack (I11). */
function publishPending(): void {
  const port = getSyncPort()
  const pending = configured() && port !== null ? port.outbox().size : 0
  if (useSyncStore.getState().pending !== pending) useSyncStore.setState({ pending })
}

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
  const pending = port?.outbox().size ?? 0
  useSyncStore.setState({
    cloudStatus: 'synced',
    lastSyncAt: Date.now(),
    lastError: null,
    // "Synced" is only true of an empty outbox (I11): every change is known to be on the relay.
    pendingLocal: behind || heldBack || pending > 0,
    pending,
    waitingForOld: heldBack ? Math.max(1, waiting) : waiting,
  })
  measureSizeOnce()
  return { ok: true, pushed, changedLocal } satisfies SyncResult
}

function goOffline(): SyncResult {
  clearRetry()
  const prev = useSyncStore.getState().lastError
  // A pause, refused access and a streak failing for 10 minutes outlast the outage: coming
  // back online does not end them, so being offline must not promise a sync. The failure, its
  // banner and its words stay (none of them says "retrying").
  if (prev !== null && keptOffline(prev)) {
    if (prev.retryAt !== undefined) {
      useSyncStore.setState({
        lastError: { kind: prev.kind, message: prev.message, since: prev.since },
      })
    }
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

/**
 * No retry; the next trigger runs the cycle again: fences (moved, update-required) until a
 * reload, too-large until the data shrinks, not-found until the copy appears, denied until the
 * relay lets this device in.
 */
function pause(reason: Exclude<SyncPauseReason, 'reload'>, message: string): SyncResult {
  clearRetry()
  endStreak() // the relay answered
  const prev = useSyncStore.getState().lastError
  const fence = reason === 'moved' || reason === 'update-required'
  // A newer build moved the relay: look for it now, so the Reload that follows runs it.
  if (fence && prev?.kind !== reason) lookForNewBuild()
  // Once per session. When the owner asked for this cycle, the panel's own toast is that once,
  // and with Settings › Sync open its banner says it. Shown before the state changes: the pill
  // then finds the toast saying it and stays quiet, so a screen reader hears it once.
  const group = fence ? 'moved' : reason === 'denied' ? 'permission' : reason
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

/** Six attempts in one cycle all crossed another device's push (§11.3). */
class BusyError extends Error {}

/** The kind the owner sees for a transport failure. */
function kindOf(err: unknown): SyncErrorKind {
  if (err instanceof BusyError) return 'busy'
  if (!(err instanceof SyncTransportError)) return 'invalid'
  switch (err.kind) {
    case 'network':
    case 'permission':
    case 'invalid':
    case 'server':
      return err.kind
    case 'full':
    case 'no-rpc':
      return 'server'
  }
}

function fail(err: unknown, reason: CycleReason): SyncResult {
  if (err instanceof PayloadTooLargeError) {
    return pause('too-large', syncMessage('too-large', Math.round(err.bytes / 1024)))
  }
  const kind = kindOf(err)
  if (kind === 'network' && isOffline()) return goOffline()
  // A merge the engine refused for want of room for its safety copy says so in its own words:
  // the synced copy read fine, and nothing was removed here.
  const message =
    err instanceof SafetyCopyError
      ? err.message
      : err instanceof SyncTransportError && err.kind === 'full'
        ? FULL_RELAY_MESSAGE
        : syncMessage(kind)
  if (import.meta.env.DEV && err instanceof SyncTransportError && err.kind === 'invalid') {
    console.warn('[sync] the relay refused the payload (22023):', err.message)
  }
  streakSince ??= Date.now()
  const since = streakSince
  const retryAt = scheduleRetry(reason)
  useSyncStore.setState({
    cloudStatus: 'error',
    lastError: { kind, message, since, ...(retryAt === null ? {} : { retryAt }) },
  })
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

/**
 * The next attempt after 2, 4, 8 … 60 s, ±20 % so two devices that failed together do not retry
 * together. None while offline ('online' resumes) or hidden (becoming visible resumes).
 * Returns when it runs, or null when none is scheduled.
 */
function scheduleRetry(reason: CycleReason): number | null {
  clearRetry()
  if (isOffline()) return null
  if (hidden()) {
    retryPaused = true
    return null
  }
  retryReason = reason
  retryAttempt = Math.min(retryAttempt + 1, RETRY_ATTEMPTS_CAP)
  const base = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (retryAttempt - 1))
  const delay = Math.round(base * (1 + BACKOFF_JITTER * (2 * Math.random() - 1)))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void requestCycle(retryReason)
  }, delay)
  return Date.now() + delay
}

// ---------------------------------------------------------------------------
// What a merge tells the owner
// ---------------------------------------------------------------------------

/**
 * The guard tripped (§11.9): applied, snapshotted and journaled; one tap brings it all back. The
 * Undo runs in the Recovery centre's lazy chunk: it starts loading now, so the tap waits on no
 * fetch (a failed load is tried again by the tap itself).
 */
function toastMassRemoval(mass: NonNullable<RemoteApplied['mass']>): void {
  Promise.resolve()
    .then(() => useExpenseStore.getState().recovery())
    .catch(() => undefined)
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

/**
 * Edits made here that a merge replaced or removed (§9.8 conflicts): kept in the journal, and one
 * tap away in Settings › Backup › Recovery, where each one can be put back.
 */
function toastConflicts(n: number): void {
  useUIStore.getState().pushToast({
    kind: 'warning',
    message: `${entries(n)} you changed here ${n === 1 ? 'was' : 'were'} also changed on your other device`,
    duration: CONFLICT_TOAST_MS,
    action: {
      label: 'Review',
      onClick: () => {
        const ui = useUIStore.getState()
        ui.focusSettings('backup', 'recovery-changes')
        ui.setSettingsOpen(true)
      },
    },
  })
}

/** A mass restore that brought nothing back, by why (Settings › Backup › Recovery's words). */
const MASS_REFUSAL: Readonly<Record<NonNullable<RestoreResult['why']>, string>> = {
  already: 'Those entries are already back.',
  'changed-since': 'Those entries are already back.',
  'deleted-since':
    'Those entries are back already or were deleted again since, so nothing was restored.',
  gone: "This change can't be restored any more.",
}

async function restoreMass(entryId: string): Promise<void> {
  const ui = useUIStore.getState()
  try {
    const { applied, why } = await useExpenseStore.getState().restoreJournal(entryId)
    ui.pushToast(
      applied > 0
        ? { kind: 'success', message: `Restored ${entries(applied)}` }
        : { kind: 'info', message: MASS_REFUSAL[why ?? 'already'] },
    )
  } catch (err) {
    ui.pushToast({
      kind: 'error',
      message: err instanceof Error ? err.message : "Couldn't restore those entries.",
    })
  }
}

type LegacyKind = 'v084' | 'v085' | 'v5pre'

/** Device ids are short; anything longer is not kept (P3-8). */
const DEV_ID_MAX = 64

/** The device a v5 copy names as its writer (`x5.dev`), or null. */
const writerOf = (raw: unknown): string | null =>
  isRecord(raw) && isRecord(raw.x5) && typeof raw.x5.dev === 'string' ? raw.x5.dev : null

/**
 * Who wrote the relay copy, when it matters: 0.8.4 and 0.9.2 by their payloads; another device's
 * v5 copy is a registering writer's ('v5') or a 0.10.0's (the only v5 release that never
 * registers itself, P3-8): no entry of its own, an older release's, or one it only carried
 * (`wroteItself`, given what this device knew of it before the pull and when the relay took the
 * write). A copy this device judged before (`judged`: the relay has not moved) keeps that
 * verdict, which the time passed since cannot change. This device's own copy and a newer
 * writer's say nothing.
 */
function writerKind(
  dec: SanitizeResult,
  writer: string | null,
  me: string,
  judged: boolean | null,
  known: DeviceInfo | undefined,
  wroteAt: number | null,
): { readonly kind: LegacyKind | 'v5'; readonly dev: string | null } | null {
  if (dec.writer === 'v084' || dec.writer === 'v085') return { kind: dec.writer, dev: null }
  if (dec.writer !== 'v5' || writer === null || writer === me) return null
  const registered = judged ?? wroteItself(dec.doc.devices.get(writer), known, wroteAt)
  return { kind: registered ? 'v5' : 'v5pre', dev: writer.length <= DEV_ID_MAX ? writer : null }
}

/**
 * An old device wrote the relay: remember when, and which 0.10.0 it was (§11.10), and banner a
 * v0.8.4 overwriting us. The 0.10.0 last seen writing that now writes registering itself has
 * updated: its sighting ends there, whatever its clock says.
 */
function noteWriter(
  code: string,
  writer: ReturnType<typeof writerKind>,
  port: SyncPort,
  now: number,
): void {
  if (writer === null) return
  const { kind, dev } = writer
  const meta = port.meta()
  const seen = meta.legacySeen
  if (kind === 'v5') {
    if (dev !== null && dev === meta.v5preDev) {
      const next: { v084?: number; v085?: number; v5pre?: number } = { ...seen }
      delete next.v5pre
      port.setMeta({ legacySeen: next, v5preDev: null })
    }
    return
  }
  const another = dev !== null && dev !== meta.v5preDev
  if (another || now - (seen[kind] ?? Number.NEGATIVE_INFINITY) >= LEGACY_SEEN_EVERY_MS) {
    const next: { v084?: number; v085?: number; v5pre?: number } = { ...seen }
    next[kind] = now
    port.setMeta({ legacySeen: next, ...(dev === null ? {} : { v5preDev: dev }) })
  }
  // An old device wrote after this one: tell the owner to update it.
  if (kind === 'v084' && pushedThisSession.has(code)) {
    useSyncStore.setState({ legacyWriterAt: now })
  }
}

// ---------------------------------------------------------------------------
// The view (P3-9, §3.9)
// ---------------------------------------------------------------------------

function computeLive(): SyncView['live'] {
  if (!configured() || hidden()) return 'off'
  if (Date.now() < stormUntil) return 'polling'
  return joinedNow ? 'on' : connecting ? 'connecting' : 'polling'
}

/** Live status changed: the view says it, and polling takes the matching pace. */
function publishLive(): void {
  const next = computeLive()
  if (next === liveState) return
  liveState = next
  schedulePoll(false)
  publishView()
}

/** Publishes what Settings › Sync shows; the same object while nothing in it changed. */
function publishView(): void {
  const port = getSyncPort()
  const code = useSyncStore.getState().syncId
  if (port === null || code === null) return
  const now = Date.now()
  const me = port.deviceId()
  const devices = new Map(port.doc().devices)
  if (!devices.has(me)) devices.set(me, { name: '', app: APP, mode, e2e: false, seen: 0 })
  const meta = port.meta()
  const seen = meta.legacySeen
  // The 0.10.0 device is listed (it never registers itself) until it registers again.
  const v5preAt = placeV5pre(
    devices,
    meta.v5preDev === me ? null : meta.v5preDev,
    seen.v5pre ?? null,
  )
  const rows = deviceRows(devices, me, APP, now)
  const legacy = { v084At: seen.v084 ?? null, v085At: seen.v085 ?? null, v5preAt }
  const ready = readiness(rows, legacy, mode, now)
  const next: SyncView = {
    codeMasked: maskCode(code),
    transport: mode,
    live: liveState,
    devices: rows,
    legacy,
    sizePct,
    allCurrent: ready.allCurrent,
    lockdown: ready.lockdown,
  }
  if (lastView !== null && JSON.stringify(lastView) === JSON.stringify(next)) return
  lastView = next
  useSyncStore.setState({ view: next })
}

function setSize(chars: number): void {
  sizePct = Math.round((100 * chars) / WIRE_PUSH_MAX)
  publishView()
}

/** Once per session, after the first good cycle and off the busy path: how big the copy is. */
function measureSizeOnce(): void {
  if (sizeMeasured || typeof window === 'undefined') return
  sizeMeasured = true
  whenIdle(() => {
    const port = getSyncPort()
    if (port !== null && configured())
      setSize(wireString(port.doc(), { omitIds: port.omitIds() }).length)
  })
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

const REPAIR: PushDecision = { kind: 'push', why: 'repair', memoKey: null }
const MERGE_ONLY: PushDecision = { kind: 'none', why: 'newer', memoKey: null }

type PushStep = {
  kind: 'push'
  wire: unknown
  chars: number
  /** The etag the push was merged from (its compare-and-set base). */
  base: string | null
  sent: SentPush
  /** The outbox entries this push carries (acknowledged once it lands). */
  outbox: readonly (readonly [OutboxKey, Stamp])[]
  dec: SanitizeResult
  decision: PushDecision
  snapRev: number
  changedLocal: boolean
}

type Step = { kind: 'done'; result: SyncResult } | PushStep

const done = (result: SyncResult): Step => ({ kind: 'done', result })

/**
 * The synchronous section: merge the news and the pulled payload into the CURRENT local doc,
 * commit it and decide what to push, with no await in between, so a local write can never be
 * overwritten by a merge of an older snapshot (F-001).
 */
function mergeStep(code: string, pulled: Pulled | null, reason: CycleReason): Step {
  const port = livePort()
  if (port === null) return done(engineDown())
  const now = Date.now()
  clearPushTimers() // this cycle carries every change made so far
  // What this device knew of the copy's writer before this cycle merged anything (P3-8).
  const writer = writerOf(pulled?.payload)
  const known = writer === null ? undefined : port.doc().devices.get(writer)
  let changedLocal = false
  const take = (applied: RemoteApplied) => {
    changedLocal ||= applied.changedLocal
    if (applied.mass !== null) toastMassRemoval(applied.mass)
    else if (applied.conflicts > 0) toastConflicts(applied.conflicts)
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

  const raw = pulled?.payload
  const missing = pulled === null || raw === null || raw === undefined
  // A joined device that finds no relay copy writes nothing: the code may be mistyped (P3-5).
  if (missing && !established) return done(pause('not-found', syncMessage('not-found')))
  const dec = missing ? MISSING : decodeWire(raw, 'remote', { reuse: port.doc(), at: now })
  if (dec.writer === 'moved') return done(pause('moved', syncMessage('moved')))
  if (dec.writer === 'e2e') return done(pause('update-required', syncMessage('update-required')))
  const repair = dec.writer === 'invalid'
  if (repair) {
    // Kept for the owner (needs attention), never merged; pushed over at most every 10 minutes,
    // so two devices that disagree about the copy cannot overwrite each other in a loop, and
    // never by a device that has not synced with this code (it might not be ours to repair).
    port.quarantine(dec.report.quarantined)
    if (!established || now - port.meta().repairAt < REPAIR_EVERY_MS) {
      throw new InvalidRemoteError()
    }
    // The quarantine entry holds an excerpt; the push over the copy waits until this device
    // keeps all of it (P2-8, P2-16: never overwrite the only copy of something).
    if (!port.keepRelayCopy(raw)) throw new InvalidRemoteError()
  }

  const snapRev = port.localRev()
  const sent = [...port.outbox()]
  // A newer SpendTrack's copy is merged too (its data is ours as well); it is only never pushed over.
  if (!missing && (mergeable(dec.writer) || dec.writer === 'newer')) take(port.applyRemote(dec))
  // An etag pushed ahead of this clock (a token is always after its base) is no write time. The
  // copy last merged here (the relay has not moved since) was judged then: a 0.10.0's if its
  // writer is the one last seen writing as 0.10.0.
  const wroteAt = missing ? null : etagTime(pulled.etag)
  const judged =
    missing || !sameEtag(pulled.etag, etagOf(port, code)) ? null : writer !== port.meta().v5preDev
  noteWriter(
    code,
    writerKind(
      dec,
      writer,
      port.deviceId(),
      judged,
      known,
      wroteAt === null ? null : Math.min(wroteAt, now),
    ),
    port,
    now,
  )
  // A new app version or relay mode is registered before the decision: the digest then differs
  // from a v5 relay's and exactly one push carries it (P3-7). `seen` alone never pushes, nor a
  // name or an older app another tab of this device registered: those ride the next push.
  const me = port.deviceId()
  const entry = entryNow(port, now)
  if (registerFirst(port.doc().devices.get(me), entry)) port.register(me, entry)

  const omitIds = port.omitIds()
  const local = wireDoc(port.doc(), omitIds)
  let decision =
    dec.writer === 'newer'
      ? MERGE_ONLY
      : repair
        ? REPAIR
        : decidePush(
            local,
            dec,
            missing ? null : { etag: pulled.etag },
            reason,
            port.meta().memo,
            now,
          )
  // The memo holds back the push an old device already overwrote, never a change made since:
  // that one gets its push (bounded by the owner's own changes, so it cannot loop).
  if (decision.kind === 'suppressed' && sent.length > 0) {
    decision = { kind: 'push', why: 'adoptable', memoKey: decision.memoKey }
  }
  if (decision.kind !== 'push') {
    const waiting = port.ack(sent, dec, decision)
    if (!missing) {
      if (dec.rev !== null) remember(merged, { rev: dec.rev, digest: digestDoc(dec.doc) })
      // This device holds that copy: until the relay moves on, a HEAD is all a resume needs.
      // Not for an old writer's copy, which may still lack what is here (§11.4).
      if (decision.kind === 'none' && (dec.writer === 'v5' || dec.writer === 'newer')) {
        // A newer writer's copy is never pushed over, so it may lack what is here.
        setEtag(port, code, pulled.etag, dec.writer === 'v5' ? port.localRev() : null)
      }
      establish(code)
    }
    // A newer SpendTrack wrote the relay: its data is merged here, and nothing is pushed over it.
    if (dec.writer === 'newer')
      return done(pause('update-required', syncMessage('update-required')))
    // Held back: an old device overwrote this exact push, so the relay lacks what is here.
    return done(succeed(snapRev, false, changedLocal, waiting, decision.kind === 'suppressed'))
  }

  // The push carries when this device was last seen (excluded from the digest).
  if (port.doc().devices.get(me) !== entry) port.register(me, entry)
  const rev = newRev(() => port.rng())
  const opts = { dev: me, rev, min: PLAIN_MIN, omitIds }
  const chars = wireString(port.doc(), opts).length
  setSize(chars)
  if (chars > WIRE_PUSH_MAX) {
    // Merged, never pushed: polls may HEAD this copy until the relay moves on.
    if (!missing && dec.writer === 'v5') setEtag(port, code, pulled.etag, null)
    return done(pause('too-large', syncMessage('too-large', Math.round(chars / 1024))))
  }
  // Remembered before sending, so our own echo is filtered however early it arrives, and a
  // push that lands although its answer never came back (a timeout) is still known as ours.
  const sentPush: SentPush = { rev, digest: digestDoc(local), answered: false }
  remember(sentPushes, sentPush)
  return {
    kind: 'push',
    wire: encodeWire(port.doc(), opts),
    chars,
    base: missing ? null : pulled.etag,
    sent: sentPush,
    outbox: sent,
    dec,
    decision,
    snapRev,
    changedLocal,
  }
}

/** After a push lands: the memo, the etag, the outbox and the repair stamp (never before, M4). */
function landed(step: PushStep, code: string, etag: string): number {
  const port = livePort()
  if (port === null) return 0
  const now = Date.now()
  const repaired = step.decision.why === 'repair'
  port.setMeta({
    lastRev: step.sent.rev,
    memo: commitPush(port.meta().memo, step.decision, now),
    lastEtag: etag,
    etagFor: fnv36(code),
    ...(repaired ? { repairAt: now } : {}),
  })
  // The push carried the doc as of `snapRev` (the merge section commits nothing local).
  held = { gen: setupGen, port, rev: step.snapRev }
  const waiting = port.ack(step.outbox, step.dec, 'pushed')
  remember(merged, { rev: step.sent.rev, digest: step.sent.digest })
  remember(sentEtags, etag)
  pushedThisSession.add(code)
  establish(code)
  if (repaired && !toastedOnce.has('repair')) {
    toastedOnce.add('repair')
    useUIStore.getState().pushToast({ kind: 'warning', message: REPAIRED_MESSAGE })
  }
  // The other v5 devices hear it at once (best effort: row events and polling still carry it).
  const dev = port.deviceId()
  void topicFor(code).then((t) => {
    announce(t, { rev: step.sent.rev, dev })
  })
  return waiting
}

/** The relay refused the payload (22023): too large once its jsonb text is over the limit. */
function tooLargeForRelay(err: unknown, step: PushStep): boolean {
  if (!(err instanceof SyncTransportError) || err.kind !== 'invalid') return false
  const bytes = new TextEncoder().encode(JSON.stringify(step.wire)).length
  return bytes * JSONB_SLACK > RPC_PAYLOAD_MAX || step.chars > WIRE_PUSH_MAX
}

/** Paused, but still merging what others write (too large, a newer writer): nothing to push. */
function pausedMerging(): boolean {
  const kind = useSyncStore.getState().lastError?.kind
  return kind === 'too-large' || kind === 'update-required'
}

/**
 * A HEAD that finds the same etag may end the cycle (P3-4): a cycle of this setup left the relay
 * at that etag, nothing was committed here since and nothing is unsent (or nothing can be sent:
 * a pause that keeps merging), no news waits, and this device's registry entry is on the relay
 * as it is now.
 */
function headable(port: SyncPort, code: string): boolean {
  if (news.length > 0 || etagOf(port, code) === null) return false
  if (held === null || held.gen !== setupGen || held.port !== port) return false
  if (pausedMerging()) return true
  return (
    held.rev === port.localRev() &&
    port.outbox().size === 0 &&
    quietTimer === null &&
    !entryDue(port, Date.now())
  )
}

/** The relay has not moved since this device last held its copy: nothing to do. */
function unchanged(snapRev: number): SyncResult {
  const prev = useSyncStore.getState().lastError
  if (prev !== null && pausedMerging()) {
    useSyncStore.setState({ cloudStatus: 'paused' })
    return { ok: false, error: prev.kind, message: prev.message }
  }
  return succeed(snapRev, false, false, 0)
}

/** Pull, merge, push: at most six attempts, the fourth forced after three crossings (§11.3). */
async function attempts(
  code: string,
  gen: number,
  reason: CycleReason,
  t: Transport,
): Promise<SyncResult> {
  const port = livePort()
  if (port === null) return engineDown()
  if (HEAD_REASONS.has(reason) && headable(port, code)) {
    const snapRev = port.localRev()
    const head = await t.head(code)
    if (gen !== setupGen) return offResult()
    if (sameEtag(head, etagOf(port, code))) return unchanged(snapRev)
    if (head === null && !established) return pause('not-found', syncMessage('not-found'))
  }
  let conflicts = 0
  for (let attempt = 0; attempt < CYCLE_ATTEMPTS_MAX; attempt++) {
    const pulled = await t.pull(code)
    if (gen !== setupGen) return offResult()
    const step = mergeStep(code, pulled, reason)
    if (step.kind === 'done') return step.result
    let res: PushOutcome
    try {
      res = await t.push(code, step.wire, {
        base: step.base,
        // A forced write never creates: a row that vanished mid-cycle is inserted, not forced.
        force: conflicts >= CAS_FORCE_AFTER && step.base !== null,
        // A hide push outlives the page (pagehide and freeze may come while still 'visible').
        keepalive: reason === 'hide' || hidden(),
      })
    } catch (err) {
      // Kept in sentPushes: a push whose answer was lost may still land (its echo is ours).
      if (gen === setupGen && tooLargeForRelay(err, step)) {
        return pause('too-large', syncMessage('too-large', Math.round(step.chars / 1024)))
      }
      throw err
    }
    step.sent.answered = true
    if (gen !== setupGen) return offResult()
    if (!res.ok) {
      // It never landed: re-pull, and merge the relay's newer copy into the CURRENT doc. A row
      // that vanished is re-created on the next attempt, by an established device only.
      forgetSent(step.sent)
      if (res.reason === 'conflict') conflicts++
      continue
    }
    // The relay received this state, so "Synced" is honest.
    return succeed(step.snapRev, true, step.changedLocal, landed(step, code, res.etag))
  }
  throw new BusyError()
}

function forgetSent(sent: SentPush): void {
  const at = sentPushes.indexOf(sent)
  if (at >= 0) sentPushes.splice(at, 1)
}

const hintOf = (port: SyncPort): ModeHint => {
  const meta = port.meta()
  return { mode: meta.transport, probedAt: meta.probedAt }
}

/** A refusal that a re-probe may answer: 005 applied (table refused), 004 rolled back. */
const reprobeFor = (err: unknown, m: RelayMode): boolean =>
  err instanceof SyncTransportError &&
  ((m === 'table' && err.kind === 'permission') || (m === 'rpc' && err.kind === 'no-rpc'))

async function cycle(code: string, gen: number, reason: CycleReason): Promise<SyncResult> {
  useSyncStore.setState({ cloudStatus: 'syncing' })
  // A refusal the relay's answer to a fresh probe may explain asks again within the cycle.
  let reprobe = false
  for (let probe = 0; ; probe++) {
    const port = livePort()
    if (port === null) return engineDown()
    let t: Transport
    try {
      const hint = hintOf(port)
      const opened = await openTransport(code, hint, Date.now(), reprobe)
      if (gen !== setupGen) return offResult()
      if (opened.hint.mode !== hint.mode || opened.hint.probedAt !== hint.probedAt) {
        port.setMeta({ transport: opened.hint.mode, probedAt: opened.hint.probedAt })
      }
      t = opened.transport
    } catch (err) {
      return gen === setupGen ? fail(err, reason) : offResult()
    }
    mode = t.mode
    try {
      return await attempts(code, gen, reason, t)
    } catch (err) {
      if (gen !== setupGen) return offResult()
      if (RELAY_PIN === 'auto' && reprobeFor(err, t.mode)) {
        // The table refused this device: with detection on, that is migration 005 (the next
        // probe tells), so row events are not armed again. On the table pin a refusal is
        // retried as 0.10.0 does, and realtime stays as it is (it may be a passing fault).
        if (t.mode === 'table') refuseRowEvents()
        // Ask the relay again at once, in this same cycle; still refused after that, pause.
        if (probe === 0) {
          reprobe = true
          continue
        }
        if (t.mode === 'table') return pause('denied', syncMessage('denied'))
      }
      return fail(err, reason)
    }
  }
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
  // A hide push must start before the page is frozen: a lock grant may wait for a later task.
  if (reason === 'hide') return cycle(code, gen, reason)
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
      runningReason = reason
      const gen = setupGen
      let result: SyncResult
      try {
        result = await runCycle(reason)
      } catch (err) {
        result = fail(err, reason)
      }
      lastCycleAt = Date.now()
      if (gen === setupGen) {
        publishPending()
        publishView()
        schedulePoll()
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
    runningReason = null
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
  return digestOf(payload) === sent.digest
}

/** A rev this tab has fully merged, carrying exactly what it merged (§3.6). */
function isMerged(payload: Record<string, unknown>): boolean {
  const x5 = payload.x5
  if (!isRecord(x5)) return false
  const rev = x5.rev
  const known = merged.find((m) => m.rev === rev)
  return known !== undefined && digestOf(payload) === known.digest
}

function digestOf(payload: Record<string, unknown>): string | null {
  const port = getSyncPort()
  if (port === null) return null
  return digestDoc(decodeWire(payload, 'remote', { reuse: port.doc(), at: Date.now() }).doc)
}

function onRowChange(change: RemoteChange) {
  const port = getSyncPort()
  const code = useSyncStore.getState().syncId
  const at = change.updatedAt
  // Our own landed write, or the copy this device already holds (the same etag).
  if (at !== null && port !== null && code !== null && sameEtag(at, etagOf(port, code))) return
  if (at !== null && sentEtags.some((e) => sameEtag(e, at))) return
  const { payload } = change
  if (isRecord(payload)) {
    if (isOwnEcho(payload) || isMerged(payload)) return
    remember(news, payload, NEWS_MEMORY)
  }
  scheduleRemote()
}

function onBroadcast(msg: { readonly rev: string; readonly dev: string }) {
  const port = getSyncPort()
  if (port !== null && (msg.dev === port.deviceId() || msg.rev === port.meta().lastRev)) return
  if (sentPushes.some((p) => p.rev === msg.rev) || merged.some((m) => m.rev === msg.rev)) return
  scheduleRemote()
}

/**
 * More than 20 remote-triggered cycles in 60 s with no local change between them: remote events
 * start nothing for 60 s (polling goes on, and a local change ends it early; P3-14).
 */
function storming(now: number): boolean {
  while (remoteCycles.length > 0 && now - (remoteCycles[0] ?? now) > STORM_WINDOW) {
    remoteCycles.shift()
  }
  if (remoteCycles.length < STORM_CYCLES) {
    remoteCycles.push(now)
    return false
  }
  remoteCycles.length = 0
  stormUntil = now + STORM_WINDOW
  if (import.meta.env.DEV) {
    console.warn('[sync] storm breaker: remote events start no cycle for 60 s (polling continues)')
  }
  if (stormTimer) clearTimeout(stormTimer)
  stormTimer = setTimeout(() => {
    stormTimer = null
    publishLive()
  }, STORM_WINDOW)
  publishLive()
  return true
}

function endStorm(): void {
  remoteCycles.length = 0
  if (stormUntil === 0) return
  stormUntil = 0
  if (stormTimer) clearTimeout(stormTimer)
  stormTimer = null
  publishLive()
}

/** Coalesce a burst into one cycle, and start remote-triggered cycles at least 2 s apart. */
function scheduleRemote() {
  if (remoteTimer || Date.now() < stormUntil) return
  const wait = Math.max(REMOTE_COALESCE, lastRemoteCycleAt + REMOTE_MIN_GAP_MS - Date.now())
  remoteTimer = setTimeout(() => {
    remoteTimer = null
    const now = Date.now()
    if (storming(now)) return
    lastRemoteCycleAt = now
    void requestCycle('remote')
  }, wait)
}

/** A table refusal with detection on (migration 005): row events are not armed again this session. */
function refuseRowEvents(): void {
  if (tableDenied) return
  tableDenied = true
  if (realtimeUnsub !== null && liveRowEvents) {
    stopRealtime()
    publishLive()
    void ensureSubscribed(setupGen)
  }
}

function onRealtimeStatus(status: 'joined' | 'dropped' | 'failed', gen: number): void {
  connecting = false
  if (status === 'joined') {
    joinedNow = true
    publishLive()
    // Events are not replayed after a drop, so every join catches up (a HEAD when nothing
    // changed); a failing streak catches up with its own backoff retry instead.
    if (retryTimer === null) void requestCycle('resubscribe')
    return
  }
  joinedNow = false
  if (status === 'failed') {
    // Row events refused twice: this channel stopped; subscribe again with Broadcast alone.
    rowEventsFailed = true
    realtimeUnsub = null
    void ensureSubscribed(gen)
  }
  publishLive()
}

/** The new subscription takes over; an older one (a race with another join) is closed. */
function replaceRealtime(next: () => void): void {
  const previous = realtimeUnsub
  realtimeUnsub = next
  previous?.()
}

/** Subscribes this tab to the code's topic, when it is visible and not subscribed already. */
async function ensureSubscribed(gen: number): Promise<void> {
  const code = useSyncStore.getState().syncId
  if (code === null || gen !== setupGen || realtimeUnsub !== null || subscribingGen === gen) return
  if (hidden()) return
  subscribingGen = gen
  connecting = true
  publishLive()
  try {
    const rowEvents = !tableDenied && !rowEventsFailed
    const unsubscribe = await subscribeSync(
      { topic: await topicFor(code), row: code, rowEvents },
      {
        onRowChange: (change) => {
          if (gen === setupGen) onRowChange(change)
        },
        onBroadcast: (msg) => {
          if (gen === setupGen) onBroadcast(msg)
        },
        onStatus: (status) => {
          if (gen === setupGen) onRealtimeStatus(status, gen)
        },
      },
    )
    if (gen === setupGen && !hidden()) {
      replaceRealtime(unsubscribe)
      liveRowEvents = rowEvents
      return
    }
    unsubscribe()
  } catch {
    // The SDK could not load (offline): 'online' or the next resume subscribes again.
  } finally {
    if (subscribingGen === gen) subscribingGen = null
  }
  // Nothing is connecting after all (this setup's subscription failed or was dropped while
  // hidden): polling, or off, is what holds.
  if (gen === setupGen) {
    connecting = false
    publishLive()
  }
}

/**
 * The next poll: a HEAD (a full cycle only when something is pending or the relay moved), every
 * 60 s while live updates are not fully on, every 5 min while they are (a socket that died
 * silently). Visible and online tabs only; every cycle starts the wait again.
 */
function schedulePoll(restart = true): void {
  // A failing streak runs on its own backoff; a poll would only add attempts to it.
  if (!configured() || hidden() || isOffline() || retryTimer !== null) {
    stopPolling()
    return
  }
  const live = liveState === 'on' && (liveRowEvents || tableDenied)
  const due = Date.now() + (live ? POLL_LIVE_MS : POLL_VISIBLE)
  // A change of pace never puts off a poll that is due sooner (a storm ending, a join).
  if (!restart && pollTimer !== null && pollDueAt <= due) return
  stopPolling()
  pollDueAt = due
  pollTimer = setTimeout(() => {
    pollTimer = null
    if (retryTimer === null) void requestCycle('poll')
  }, due - Date.now())
}

// ---------------------------------------------------------------------------
// Actions (called through useSyncStore)
// ---------------------------------------------------------------------------

function readConfig() {
  try {
    return storage.getSyncConfig()
  } catch {
    return null
  }
}

/**
 * Connects to `syncId`: saves it, runs the first cycle, then subscribes to realtime. `join`: the
 * code came from another device, so this one may not create its relay copy until a cycle has
 * found it (P3-5).
 */
export async function setupSync(syncId: string, user: boolean, join = false): Promise<SyncResult> {
  // The same code again (start-up with the saved code, Connect with the linked one) keeps
  // what is known about the devices on it.
  const sameCode = useSyncStore.getState().syncId === syncId
  const saved = readConfig()
  const savedHere = saved?.kind === 'plain' && saved.code === syncId ? saved : null
  established = join ? savedHere?.established === true : (savedHere?.established ?? true)
  keepCode(syncId, established)
  const gen = ++setupGen
  stopRealtime()
  clearTimers()
  retryAttempt = 0
  rowEventsFailed = false
  lastView = null
  endStreak()
  if (!sameCode) {
    news.length = 0 // another code's relay copy is no news for this one
    merged.length = 0
  }
  const port = livePort()
  useSyncStore.setState({
    syncId,
    cloudStatus: 'idle',
    lastError: null,
    // Nothing is known to be on this relay until the first cycle.
    pendingLocal: true,
    pending: port?.outbox().size ?? 0,
    waitingForOld: 0,
    legacyWriterAt: sameCode ? useSyncStore.getState().legacyWriterAt : null,
  })
  // The channel is tried right after the first cycle: until it answers, live updates are
  // neither on nor unavailable (offline or hidden, no channel is tried).
  connecting = !isOffline() && !hidden()
  liveState = computeLive()
  publishView()
  // Pull first, then subscribe; the join runs one more cycle (a HEAD) to close the gap between.
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
  rowEventsFailed = false
  news.length = 0
  merged.length = 0
  lastView = null
  liveState = 'off'
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

export type JoinPreview =
  | {
      kind: 'found'
      here: number
      synced: number
      after: number
      removed: number
      unreadable: number
    }
  | { kind: 'not-found' }
  /** A moved marker, a newer schema, or a private (e2e) copy. */
  | { kind: 'newer' }
  /** The relay copy cannot be read at all. */
  | { kind: 'unreadable' }
  | { kind: 'failed'; result: Extract<SyncResult, { ok: false }> }

const failedPreview = (
  error: Extract<SyncResult, { ok: false }>['error'],
  message: string,
): JoinPreview => ({ kind: 'failed', result: { ok: false, error, message } })

/**
 * What joining `input` would do, read-only (P3-5, AC-E21): validates the code, pulls its relay
 * copy, decodes it and counts the merge. Saves nothing, subscribes nothing, writes nothing.
 * `here` and `after` count this device's own live entries (sample rows left out), `synced` the
 * relay copy's, `removed` the entries here the relay has deleted, `unreadable` the relay rows
 * set aside.
 */
export async function previewJoin(input: string): Promise<JoinPreview> {
  const code = normalizeUuid(input)
  if (code === null) return failedPreview('invalid', INVALID_CODE_MESSAGE)
  if (isOffline()) return failedPreview('offline', syncMessage('offline'))
  if (!(await engineReady())) return failedPreview('reload', syncMessage('reload'))
  const port = livePort()
  if (port === null) return failedPreview('reload', syncMessage('reload'))
  let pulled: Pulled | null
  try {
    const { transport } = await openTransport(code, hintOf(port), Date.now(), false)
    pulled = await transport.pull(code)
  } catch (err) {
    const kind = kindOf(err)
    if (kind === 'network' && isOffline()) return failedPreview('offline', syncMessage('offline'))
    const full = err instanceof SyncTransportError && err.kind === 'full'
    return failedPreview(kind, full ? FULL_RELAY_MESSAGE : syncMessage(kind))
  }
  if (pulled === null || pulled.payload === null || pulled.payload === undefined) {
    return { kind: 'not-found' }
  }
  const local = port.doc()
  const dec = decodeWire(pulled.payload, 'remote', { reuse: local, at: Date.now() })
  if (dec.writer === 'moved' || dec.writer === 'e2e' || dec.writer === 'newer') {
    return { kind: 'newer' }
  }
  if (dec.writer === 'invalid') return { kind: 'unreadable' }
  const omit = port.omitIds()
  const m = mergeDoc(local, dec.doc)
  return {
    kind: 'found',
    here: liveCount(local, omit),
    synced: dec.doc.expenses.size,
    after: liveCount(m.doc, omit),
    removed: m.removed.filter((rec) => omit === undefined || !omit(rec.id)).length,
    unreadable: dec.report.quarantined.length,
  }
}

// ---------------------------------------------------------------------------
// Wiring: local commits and app lifecycle → cycles
// ---------------------------------------------------------------------------

function onCommit(source: 'local' | 'tab' | 'remote' | 'boot') {
  if (!configured()) return
  if (source === 'local' || source === 'tab') {
    // A change the relay has not seen: the next cycle pushes it, even over an old device's copy.
    endStorm()
    const pending = getSyncPort()?.outbox().size ?? 0
    const s = useSyncStore.getState()
    if (!s.pendingLocal || s.waitingForOld !== 0 || s.pending !== pending) {
      useSyncStore.setState({ pendingLocal: true, waitingForOld: 0, pending })
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
    publishPending()
  }
}

/** Something not yet on the relay: a change waiting for its push, or the durable outbox. */
function unsent(): boolean {
  if (quietTimer !== null) return true
  const port = getSyncPort()
  return port === null ? useSyncStore.getState().pendingLocal : port.outbox().size > 0
}

/**
 * Hidden, `pagehide` or `freeze`. The local engine has already written the save (its listener
 * runs first, from bootstrap). Anything not yet on the relay is sent now, with keepalive: a
 * backgrounded app may be suspended before the push timer fires. Then the tab goes quiet: no
 * polling, no retry, and its channel closes 30 s later.
 */
function onHide() {
  if (!configured()) return
  if (unsent() && !(running && runningReason === 'hide') && nextReason !== 'hide') {
    clearPushTimers()
    void requestCycle('hide')
  }
  if (retryTimer !== null) {
    clearRetry()
    retryPaused = true
  }
  stopPolling()
  hiddenTimer ??= setTimeout(() => {
    hiddenTimer = null
    if (!hidden()) return
    stopRealtime()
    rowEventsFailed = false
    publishLive()
  }, HIDDEN_UNSUBSCRIBE_MS)
  publishLive()
}

/** Visible, a page restored from the back-forward cache, or the window focused. */
function onShow() {
  if (!configured() || hidden()) return
  if (hiddenTimer) clearTimeout(hiddenTimer)
  hiddenTimer = null
  const due = retryPaused || Date.now() - lastCycleAt > RESUME_AFTER_MS
  retryPaused = false
  if (due) {
    retryAttempt = 0
    void requestCycle('resume')
  }
  void ensureSubscribed(setupGen)
  schedulePoll(false)
  publishLive()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onHide()
  else onShow()
}

function onPageShow(event: Event) {
  if ('persisted' in event && event.persisted === true) onShow()
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
  if (!configured()) return
  goOffline()
  stopPolling()
}

/** Wires local commits and lifecycle events to cycles. Runs once, when the engine loads. */
export function start(): void {
  if (started) return
  started = true
  void whenHydrated().then(() => {
    livePort()
    publishView()
  })
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('freeze', onHide)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('focus', onShow)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  }
}
