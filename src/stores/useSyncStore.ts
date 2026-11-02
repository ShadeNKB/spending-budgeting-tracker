// Sync state for the UI, and thin actions. The engine that runs cycles (syncEngine.ts) is a
// lazy chunk loaded on first use, so the main bundle carries only what the pill and the panel
// read. Builds without a relay (`syncEnabled` false) drop the engine entirely.

import { create } from 'zustand'
import { getUpdateController } from '../app/swUpdate'
import { STUCK_HINT, importWithReload, reloadedRecently } from '../lib/chunkReload'
import { storage, type SyncConfig } from '../services/storage'
import { syncEnabled } from '../services/syncConfig'
import { syncPanelShown, useUIStore } from './useUIStore'
import type * as SyncEngineModule from './syncEngine'

export type SyncErrorKind = 'network' | 'server' | 'permission' | 'invalid' | 'busy'
/**
 * Paused until something changes: `reload`, the sync engine's code did not load on this page and
 * only a reload fetches it again; `not-found`, a joined code has no relay copy (yet); `denied`,
 * the relay refused this device even through its sync functions.
 */
export type SyncPauseReason =
  | 'too-large'
  | 'moved'
  | 'update-required'
  | 'reload'
  | 'not-found'
  | 'denied'
export type SyncResult =
  | { ok: true; pushed: boolean; changedLocal: boolean }
  | { ok: false; error: SyncErrorKind | SyncPauseReason | 'off' | 'offline'; message: string }
export type CloudStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'paused'

export interface SyncFailure {
  kind: SyncErrorKind | SyncPauseReason | 'offline'
  /** The engine's words, shown as they are by every surface. */
  message: string
  /** Start of the failure streak: kept across consecutive failures. */
  since: number
  /** When the scheduled retry runs (absent when none is scheduled). */
  retryAt?: number
}

/** One device in Settings › Sync, from the relay copy's registry (the engine builds these). */
export interface DeviceRow {
  readonly id: string
  /** "iPhone · Safari"; a device on an older release that never registers: "Older SpendTrack (0.9.2)". */
  readonly name: string
  /** "0.11.0", "0.9.2". */
  readonly app: string
  readonly mode: 'table' | 'rpc'
  readonly me: boolean
  /** Its last push, epoch ms; 0 = unknown. */
  readonly seen: number
  /** When it first reported RPC mode, epoch ms; 0 = not in RPC mode. */
  readonly rpcSince: number
  /** Not seen for 60 days: greyed, and left out of readiness. */
  readonly stale: boolean
  /** Runs an older SpendTrack than this one. */
  readonly older: boolean
  /** A device on a release that never registers itself (0.9.2's writer stamp, a 0.10.0 seen writing). */
  readonly legacy: boolean
}

/** What Settings › Sync shows beyond the status (published by the engine; stable while unchanged). */
export interface SyncView {
  /** `••••-…-1a2b`; null without a code. */
  readonly codeMasked: string | null
  readonly transport: 'table' | 'rpc'
  /** Joined · joining · not joined, storm or blocked (polling instead) · hidden. */
  readonly live: 'on' | 'connecting' | 'polling' | 'off'
  /** This device first, then by last seen. */
  readonly devices: readonly DeviceRow[]
  readonly legacy: {
    readonly v084At: number | null
    readonly v085At: number | null
    readonly v5preAt: number | null
  }
  /** round(100 × wire chars / the push limit); null until measured. */
  readonly sizePct: number | null
  readonly allCurrent: boolean
  /** Null unless this device uses the relay's sync functions. */
  readonly lockdown: { readonly ready: boolean; readonly reason: string | null } | null
}

interface SyncState {
  syncId: string | null
  cloudStatus: CloudStatus
  /** Last successful cycle. */
  lastSyncAt: number | null
  lastError: SyncFailure | null
  /** Something not known to be on the relay (also before the first cycle). */
  pendingLocal: boolean
  /** Changes in the outbox, not yet known to be on the relay (0 with sync off). */
  pending: number
  /**
   * Changes an older device on the relay has not taken yet (0 = none); a push held back for
   * such a device with no change of its own counts 1.
   */
  waitingForOld: number
  /** When a v0.8.4-or-older device last wrote over this device's push. */
  legacyWriterAt: number | null
  /**
   * The sync engine's code failed to load on this page. The next resume, 'online' or Sync now
   * loads it again, which may fail again (WebKit keeps a failed load for the life of the tab),
   * so nothing promises a sync meanwhile.
   */
  engineFailed: boolean
  view: SyncView | null

  initSync: () => void
  /** `join`: not established until a cycle finds the relay copy, so it never creates one. */
  setupSync: (syncId: string, opts?: { join?: boolean }) => Promise<SyncResult>
  disconnectSync: () => void
  triggerSync: (opts?: { resetBackoff?: boolean }) => Promise<SyncResult>
  scheduleSyncPush: () => void
}

// ---------------------------------------------------------------------------
// Copy the eager code needs (the engine's own words live in syncEngine.ts, a lazy chunk)
// ---------------------------------------------------------------------------

export const SYNC_OFF_MESSAGE = "Sync isn't set up on this device."
export const SYNC_RELOAD_MESSAGE =
  "Sync couldn't start on this page. Reload SpendTrack to sync. Your changes are saved on this device."

const PAUSES: readonly string[] = [
  'too-large',
  'moved',
  'update-required',
  'reload',
  'not-found',
  'denied',
]

/** Paused until the owner acts or the relay changes: no retry, and offline ends nothing. */
export function isPaused(kind: SyncFailure['kind']): kind is SyncPauseReason {
  return PAUSES.includes(kind)
}

/** Paused until SpendTrack is reloaded: the relay moved to a newer version, or sync's code did not load. */
export function needsReload(kind: SyncFailure['kind']): boolean {
  return kind === 'moved' || kind === 'update-required' || kind === 'reload'
}

/** Where TopBar shows the sync pill (Tailwind `xl`); below it the pill is not rendered. */
export const SYNC_PILL_MEDIA = '(min-width: 1280px)'

/** The sync pill is on screen, so it shows (and announces) what sync is doing. */
export function syncPillShown(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(SYNC_PILL_MEDIA).matches
  )
}

const PAUSED_PREFIX = 'Sync paused: '

/**
 * A message as a surface that already says "Sync paused" shows it (the pill's tooltip and
 * announcement, the panel's banner): without the prefix a standalone toast needs.
 */
export function pausedDetail(message: string): string {
  if (!message.startsWith(PAUSED_PREFIX)) return message
  const detail = message.slice(PAUSED_PREFIX.length)
  return detail.charAt(0).toUpperCase() + detail.slice(1)
}

/** Shown when an older device keeps overwriting the relay copy (pill tooltip, panel, toast). */
export const OLD_DEVICE_WAITING =
  "Your other device keeps overwriting the synced copy until it's updated. Everything is saved here."

/** A failure streak this old is "failing since HH:mm", in red, on every surface. */
export const FAILING_AFTER_MS = 10 * 60_000

/** The pill, the panel and the one background toast say this once a streak is failing. */
export function failingSinceMessage(since: number): string {
  return `Sync has been failing since ${clockTime(since)}. Your changes are saved on this device.`
}

/** A failure the engine keeps retrying (not offline, not paused) that has lasted 10 minutes. */
export function isFailing(failure: Pick<SyncFailure, 'kind' | 'since'>, now = Date.now()): boolean {
  switch (failure.kind) {
    case 'network':
    case 'server':
    case 'invalid':
    case 'permission':
    case 'busy':
      return now - failure.since >= FAILING_AFTER_MS
    default:
      return false
  }
}

/**
 * One meaning per colour on every sync surface (pill, status row, banner, toast), decided here
 * only: amber for what the owner waits out (offline, a retry still young) or fixes with a
 * reload; red for what needs them (refused access, too large) and for a retry that has been
 * failing for 10 minutes.
 */
export function failureSeverity(
  failure: Pick<SyncFailure, 'kind' | 'since'>,
  now = Date.now(),
): 'warning' | 'error' {
  switch (failure.kind) {
    case 'offline':
    case 'moved':
    case 'update-required':
    case 'reload':
      return 'warning'
    case 'network':
    case 'server':
    case 'invalid':
    case 'busy':
      return isFailing(failure, now) ? 'error' : 'warning'
    case 'permission':
    case 'too-large':
    case 'not-found':
    case 'denied':
      return 'error'
  }
}

/**
 * A failure that is not about this device's connection: a pause, refused access, or a retry
 * that has been failing for 10 minutes. Going offline keeps it (its words stay true), and
 * coming back online does not end it by itself.
 */
export function keptOffline(
  failure: Pick<SyncFailure, 'kind' | 'since'>,
  now = Date.now(),
): boolean {
  return isPaused(failure.kind) || failure.kind === 'permission' || isFailing(failure, now)
}

/**
 * Offline, sync will run by itself once the device is back: it is set up, its code loaded, and
 * nothing it already knows stands in the way. Only then may a surface promise a sync.
 */
export function syncsWhenOnline(
  s: Pick<SyncState, 'syncId' | 'lastError' | 'engineFailed'>,
): boolean {
  return s.syncId !== null && !s.engineFailed && !(s.lastError && keptOffline(s.lastError))
}

/** Reloads SpendTrack. A new build that is already waiting takes over first. */
export function reloadSpendTrack(): void {
  getUpdateController().reloadToLatest()
}

/** Sync's state says a new build is out (the relay moved on, or a stale chunk): look for it now. */
export function lookForNewBuild(): void {
  getUpdateController().checkNow()
}

const SYNC_TOAST_MS = 12_000

/** A sync toast. One that asks for a reload carries the Reload, as the panel's banner does. */
export function syncToast(kind: 'error' | 'warning', message: string, withReload = false): void {
  useUIStore.getState().pushToast({
    kind,
    message,
    duration: SYNC_TOAST_MS,
    ...(withReload ? { action: { label: 'Reload', onClick: reloadSpendTrack } } : {}),
  })
}

/**
 * Nothing on screen says what sync is doing: the pill is desktop-only and Settings › Sync is
 * closed, so a toast is the only way the owner hears it.
 */
export const noSyncSurface = (): boolean =>
  !syncPillShown() && !syncPanelShown(useUIStore.getState())

function savedConfig(): SyncConfig | null {
  try {
    return storage.getSyncConfig()
  } catch {
    return null
  }
}

let codeWarned = false

/**
 * Saves the sync code (`established` as storage.saveSyncId takes it). When storage refuses it
 * (full), the code still works for this session, but this device forgets it when SpendTrack
 * closes: the owner hears that, once.
 */
export function keepCode(syncId: string, established?: boolean): void {
  try {
    storage.saveSyncId(syncId, established)
  } catch {
    // Checked below: the code may already be there (start-up re-saves the saved code).
  }
  const saved = savedConfig()
  if ((saved?.kind === 'plain' && saved.code === syncId) || codeWarned) return
  codeWarned = true
  syncToast(
    'warning',
    "This device couldn't save the sync code, so it forgets it when SpendTrack closes. Free up space, then connect again.",
  )
}

/** Local wall-clock time as HH:mm. */
export function clockTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// The lazy engine
// ---------------------------------------------------------------------------

type SyncEngine = typeof SyncEngineModule

let engine: SyncEngine | null = null
let loading: Promise<SyncEngine> | null = null
// Bumped by every setup and disconnect: a setup still waiting for the engine chunk when a
// newer setup or a disconnect happens does nothing.
let setupTicket = 0
let installed = false

const offResult = (): SyncResult => ({ ok: false, error: 'off', message: SYNC_OFF_MESSAGE })

/** Loads the sync engine chunk once (a failed load is retried on the next use) and starts it. */
export function loadSyncEngine(): Promise<SyncEngine> {
  if (!loading) {
    // A stale chunk after a deploy reloads the page once (online, nothing typed); otherwise the
    // error reaches the caller, which keeps the code and sets up again on the next trigger.
    const attempt = importWithReload(() => import('./syncEngine')).then((loaded) => {
      loaded.start()
      engine = loaded
      return loaded
    })
    loading = attempt
    attempt.catch(() => {
      if (loading === attempt) loading = null
    })
  }
  return loading
}

const isOffline = () => typeof navigator !== 'undefined' && !navigator.onLine

let reloadToasted = false

/**
 * The engine chunk did not load. Nothing retries on a timer here, so the state never says
 * "retrying", and nothing promises a sync: WebKit never fetches a failed chunk again in that
 * tab. Offline, the next 'online' or resume sets up again. Online, the browser keeps the
 * failed import for the life of the page (a stale chunk it could not reload for, with a
 * dialog open), so only a reload fetches it again, and the state says so; after an automatic
 * reload that did not help, it also says how to get unstuck.
 */
function engineMissing(syncId: string, user: boolean): Extract<SyncResult, { ok: false }> {
  const prev = useSyncStore.getState().lastError
  const offline = isOffline()
  const kind = offline ? 'offline' : 'reload'
  const message = offline
    ? "You're offline. Changes are saved on this device."
    : reloadedRecently()
      ? `${SYNC_RELOAD_MESSAGE} ${STUCK_HINT}`
      : SYNC_RELOAD_MESSAGE
  useSyncStore.setState({
    syncId,
    cloudStatus: offline ? 'offline' : 'paused',
    pendingLocal: true,
    engineFailed: true,
    lastError: { kind, message, since: prev?.kind === kind ? prev.since : Date.now() },
  })
  if (!offline) {
    // A stale engine chunk usually means a new build is out: the Reload then runs it.
    if (prev?.kind !== 'reload') lookForNewBuild()
    // Once per session, where nothing else says it (the owner's own request reports itself).
    if (!reloadToasted) {
      reloadToasted = true
      if (!user && noSyncSurface()) syncToast(failureSeverity({ kind, since: 0 }), message, true)
    }
  }
  return { ok: false, error: kind, message }
}

async function setup(syncId: string, user: boolean, join = false): Promise<SyncResult> {
  const ticket = ++setupTicket
  let loaded: SyncEngine
  try {
    loaded = await loadSyncEngine()
  } catch {
    if (ticket !== setupTicket) return offResult()
    // Keep the code, as a failed first sync does, and set up again on the next resume,
    // 'online' or Sync now. A joined code stays unestablished: it never creates a relay copy.
    keepCode(syncId, join ? false : undefined)
    return engineMissing(syncId, user)
  }
  if (ticket !== setupTicket) return offResult()
  if (useSyncStore.getState().engineFailed) useSyncStore.setState({ engineFailed: false })
  return loaded.setupSync(syncId, user, join)
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncId: null,
  cloudStatus: 'off',
  lastSyncAt: null,
  lastError: null,
  pendingLocal: false,
  pending: 0,
  waitingForOld: 0,
  legacyWriterAt: null,
  engineFailed: false,
  view: null,

  initSync: () => {
    if (!syncEnabled) return
    const saved = savedConfig()
    if (saved?.kind === 'newer') {
      // A newer SpendTrack set sync up here (then this build came back): it cannot read that
      // setup, so it pauses, makes no request, and never overwrites it (only Disconnect does).
      set({
        cloudStatus: 'paused',
        lastError: {
          kind: 'update-required',
          message:
            'Sync on this device was set up by a newer SpendTrack. Reload SpendTrack to update. Your data is safe here.',
          since: Date.now(),
        },
      })
      return
    }
    if (!saved) return
    // Linked from the first frame: while the engine chunk loads, the panel shows this code, not
    // the unlinked view with its Generate button. Nothing is known to be on the relay until the
    // first cycle, so a change made meanwhile reads "Syncing…", never "Saved".
    if (get().syncId === null) set({ syncId: saved.code, cloudStatus: 'idle', pendingLocal: true })
    void setup(saved.code, false)
  },

  setupSync: (syncId, opts) =>
    syncEnabled ? setup(syncId, true, opts?.join === true) : Promise.resolve(offResult()),

  disconnectSync: () => {
    setupTicket++
    engine?.stop()
    try {
      storage.saveSyncId(null)
    } catch {
      // Storage unavailable: the code is forgotten for this session anyway.
    }
    set({
      syncId: null,
      cloudStatus: 'off',
      lastSyncAt: null,
      lastError: null,
      pendingLocal: false,
      pending: 0,
      waitingForOld: 0,
      legacyWriterAt: null,
      engineFailed: false,
      view: null,
    })
  },

  triggerSync: (opts) => {
    const { syncId } = get()
    if (!syncEnabled || syncId === null) return Promise.resolve(offResult())
    // No engine yet: its chunk failed to load during setup, so set up again.
    return engine ? engine.triggerSync(opts) : setup(syncId, true)
  },

  scheduleSyncPush: () => {
    engine?.scheduleSyncPush()
  },
}))

/** Starts sync for a saved code. Idempotent. The engine wires its own triggers when it loads. */
export function installSync(): void {
  if (installed || !syncEnabled) return
  installed = true
  // Until the engine has loaded, a saved code whose engine chunk failed to load is set up
  // again when the app comes back online or into view.
  if (typeof window !== 'undefined') {
    const resume = () => {
      const { syncId } = useSyncStore.getState()
      if (!engine && !loading && syncId !== null && document.visibilityState === 'visible') {
        void setup(syncId, false)
      }
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
  }
  useSyncStore.getState().initSync()
}
