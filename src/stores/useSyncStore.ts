// Sync state for the UI, and thin actions. The engine that runs cycles (syncEngine.ts) is a
// lazy chunk loaded on first use, so the main bundle carries only what the pill and the panel
// read. Builds without a relay (`syncEnabled` false) drop the engine entirely.

import { create } from 'zustand'
import { getUpdateController } from '../app/swUpdate'
import { STUCK_HINT, importWithReload, reloadedRecently } from '../lib/chunkReload'
import { storage } from '../services/storage'
import { syncEnabled } from '../services/syncConfig'
import { syncPanelShown, useUIStore } from './useUIStore'
import type * as SyncEngineModule from './syncEngine'

export type SyncErrorKind = 'network' | 'server' | 'permission' | 'invalid'
/** `reload`: the sync engine's code did not load on this page, and only a reload fetches it again. */
export type SyncPauseReason = 'too-large' | 'moved' | 'update-required' | 'reload'
export type SyncResult =
  | { ok: true; pushed: boolean; changedLocal: boolean }
  | { ok: false; error: SyncErrorKind | SyncPauseReason | 'off' | 'offline'; message: string }
export type CloudStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'paused'

export interface SyncFailure {
  kind: SyncErrorKind | SyncPauseReason | 'offline'
  message: string
  /** Start of the failure streak: kept across consecutive failures. */
  since: number
}

interface SyncState {
  syncId: string | null
  cloudStatus: CloudStatus
  /** Last successful cycle. */
  lastSyncAt: number | null
  lastError: SyncFailure | null
  /** Local changes not yet known to be on the relay. */
  pendingLocal: boolean
  /** The last cycle held back a push because an older device keeps overwriting the relay. */
  waitingForOld: boolean
  /** When a v0.8.4-or-older device last wrote over this device's push. */
  legacyWriterAt: number | null
  /**
   * The sync engine's code failed to load on this page. The next resume, 'online' or Sync now
   * loads it again, which may fail again (WebKit keeps a failed load for the life of the tab),
   * so nothing promises a sync meanwhile.
   */
  engineFailed: boolean

  initSync: () => void
  setupSync: (syncId: string) => Promise<SyncResult>
  disconnectSync: () => void
  triggerSync: (opts?: { resetBackoff?: boolean }) => Promise<SyncResult>
  scheduleSyncPush: () => void
}

// ---------------------------------------------------------------------------
// Copy (single source for the panel, the pill and the toasts)
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
    case 'too-large':
      return `Sync paused: your data${kb === undefined ? '' : ` (${String(kb)} KB)`} is too large for the sync server. It's still saved here — export a backup.`
    case 'moved':
    case 'update-required':
      return 'Sync moved to a newer version. Reload SpendTrack to update.'
    case 'reload':
      return "Sync couldn't start on this page. Reload SpendTrack to sync. Your changes are saved on this device."
    case 'off':
      return "Sync isn't set up on this device."
  }
}

/** Paused until the owner acts (reload, or export and trim): no retry, and offline ends nothing. */
export function isPaused(kind: SyncFailure['kind']): kind is SyncPauseReason {
  return kind === 'too-large' || kind === 'moved' || kind === 'update-required' || kind === 'reload'
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
      return isFailing(failure, now) ? 'error' : 'warning'
    case 'permission':
    case 'too-large':
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

function savedCode(): string | null {
  try {
    return storage.getSyncId()
  } catch {
    return null
  }
}

let codeWarned = false

/**
 * Saves the sync code. When storage refuses it (full), the code still works for this session,
 * but this device forgets it when SpendTrack closes: the owner hears that, once.
 */
export function keepCode(syncId: string): void {
  try {
    storage.saveSyncId(syncId)
  } catch {
    // Checked below: the code may already be there (start-up re-saves the saved code).
  }
  if (savedCode() === syncId || codeWarned) return
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

const offResult = (): SyncResult => ({ ok: false, error: 'off', message: syncMessage('off') })

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
      ? `${syncMessage('reload')} ${STUCK_HINT}`
      : syncMessage('reload')
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

async function setup(syncId: string, user: boolean): Promise<SyncResult> {
  const ticket = ++setupTicket
  let loaded: SyncEngine
  try {
    loaded = await loadSyncEngine()
  } catch {
    if (ticket !== setupTicket) return offResult()
    // Keep the code, as a failed first sync does, and set up again on the next resume,
    // 'online' or Sync now.
    keepCode(syncId)
    return engineMissing(syncId, user)
  }
  if (ticket !== setupTicket) return offResult()
  if (useSyncStore.getState().engineFailed) useSyncStore.setState({ engineFailed: false })
  return loaded.setupSync(syncId, user)
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncId: null,
  cloudStatus: 'off',
  lastSyncAt: null,
  lastError: null,
  pendingLocal: false,
  waitingForOld: false,
  legacyWriterAt: null,
  engineFailed: false,

  initSync: () => {
    if (!syncEnabled) return
    const saved = savedCode()
    if (!saved) return
    // Linked from the first frame: while the engine chunk loads, the panel shows this code, not
    // the unlinked view with its Generate button. Nothing is known to be on the relay until the
    // first cycle, so a change made meanwhile reads "Syncing…", never "Saved".
    if (get().syncId === null) set({ syncId: saved, cloudStatus: 'idle', pendingLocal: true })
    void setup(saved, false)
  },

  setupSync: (syncId) => (syncEnabled ? setup(syncId, true) : Promise.resolve(offResult())),

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
      waitingForOld: false,
      legacyWriterAt: null,
      engineFailed: false,
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
