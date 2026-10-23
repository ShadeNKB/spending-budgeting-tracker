// Sync state for the UI, and thin actions. The engine that runs cycles (syncEngine.ts) is a
// lazy chunk loaded on first use, so the main bundle carries only what the pill and the panel
// read. Builds without a relay (`syncEnabled` false) drop the engine entirely.

import { create } from 'zustand'
import { importWithReload } from '../lib/chunkReload'
import { storage } from '../services/storage'
import { syncEnabled } from '../services/syncConfig'
import { clearPendingEdits } from './useExpenseStore'
import type * as SyncEngineModule from './syncEngine'

export type SyncErrorKind = 'network' | 'server' | 'permission' | 'invalid'
export type SyncPauseReason = 'too-large' | 'moved' | 'update-required'
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
      return 'The sync server had a problem. Retrying automatically.'
    case 'permission':
      return 'The sync server refused access. Your data is safe on this device.'
    case 'invalid':
      return "The synced copy couldn't be read, so nothing was merged. Your data is safe on this device."
    case 'too-large':
      return `Sync paused: your data${kb === undefined ? '' : ` (${String(kb)} KB)`} is too large for the sync server. It's still saved here — export a backup.`
    case 'moved':
    case 'update-required':
      return 'Sync moved to a newer version. Reload SpendTrack to update.'
    case 'off':
      return "Sync isn't set up on this device."
  }
}

/** Paused until the owner acts (reload, or export and trim): no retry, and offline ends nothing. */
export function isPaused(kind: SyncFailure['kind']): kind is SyncPauseReason {
  return kind === 'too-large' || kind === 'moved' || kind === 'update-required'
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

// The code this device synced with before a Disconnect. Pending field edits are relative to
// it, so connecting to it again keeps them; another code clears them (see `lastSyncCode`).
let disconnectedCode: string | null = null

function savedCode(): string | null {
  try {
    return storage.getSyncId()
  } catch {
    return null
  }
}

/**
 * The code this device synced with last. The store holds none until the first setup of a
 * session, so a code saved by an earlier session counts as the same code, not a switch; after
 * a Disconnect it is the code disconnected from.
 */
export function lastSyncCode(): string | null {
  return useSyncStore.getState().syncId ?? savedCode() ?? disconnectedCode
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

async function setup(syncId: string, user: boolean): Promise<SyncResult> {
  const ticket = ++setupTicket
  let loaded: SyncEngine
  try {
    loaded = await loadSyncEngine()
  } catch {
    if (ticket !== setupTicket) return offResult()
    // The chunk did not load (offline before it was cached): keep the code, as a failed first
    // sync does, and set up again on the next resume, 'online' or Sync now.
    const previous = lastSyncCode()
    try {
      storage.saveSyncId(syncId)
    } catch {
      // Not persisted (storage full): the code still works for this session.
    }
    if (previous !== syncId) clearPendingEdits()
    const message = syncMessage('network')
    useSyncStore.setState({
      syncId,
      cloudStatus: 'error',
      pendingLocal: true,
      lastError: { kind: 'network', message, since: Date.now() },
    })
    return { ok: false, error: 'network', message }
  }
  return ticket === setupTicket ? loaded.setupSync(syncId, user) : offResult()
}

export const useSyncStore = create<SyncState>((set, get) => ({
  syncId: null,
  cloudStatus: 'off',
  lastSyncAt: null,
  lastError: null,
  pendingLocal: false,
  waitingForOld: false,
  legacyWriterAt: null,

  initSync: () => {
    if (!syncEnabled) return
    const saved = savedCode()
    if (!saved) return
    // Linked from the first frame: while the engine chunk loads, the panel shows this code, not
    // the unlinked view with its Generate button.
    if (get().syncId === null) set({ syncId: saved, cloudStatus: 'idle' })
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
    // Pending field edits stay: reconnecting to this code still rebases them. Setting up a
    // different code clears them (they are relative to this code's relay copy).
    disconnectedCode = get().syncId ?? disconnectedCode
    set({
      syncId: null,
      cloudStatus: 'off',
      lastSyncAt: null,
      lastError: null,
      pendingLocal: false,
      waitingForOld: false,
      legacyWriterAt: null,
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
