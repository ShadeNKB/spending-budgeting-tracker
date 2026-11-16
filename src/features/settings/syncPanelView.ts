import { useEffect, useState } from 'react'
import {
  FAILING_AFTER_MS,
  failingSinceMessage,
  failureSeverity,
  isFailing,
  isPaused,
  pausedDetail,
  type CloudStatus,
  type SyncFailure,
  type SyncResult,
} from '../../stores/useSyncStore'
import { timeAgo } from './previousCode'

// What the Sync panel says about the sync's state: the status row, a failure in the banners'
// words, and the toast after a setup. Pure, so the panel and its banners read the same words.

// Short status-row labels; the banner under the row carries the full sentence.
const ERROR_LABEL: Record<SyncFailure['kind'], string> = {
  network: "Can't reach the sync server",
  server: 'Sync server error',
  permission: 'Sync server refused access',
  // Never a red label that starts with "Synced".
  invalid: "Couldn't read the synced copy",
  busy: 'Devices synced at the same moment',
  offline: "Offline — will sync when you're back",
  'too-large': 'Sync paused',
  moved: 'Sync paused',
  'moved-private': 'Sync paused',
  'no-cas': 'Sync paused',
  'update-required': 'Sync paused',
  reload: 'Sync paused',
  'not-found': 'Sync paused',
  denied: 'Sync paused',
}

export type Tone = 'muted' | 'accent' | 'positive' | 'info' | 'warning' | 'negative'

/** The row colour of a failure: the same meaning as on the pill and in the toasts. */
const failureTone = (failure: SyncFailure): Extract<Tone, 'warning' | 'negative'> =>
  failureSeverity(failure) === 'warning' ? 'warning' : 'negative'

/**
 * A failure in the banner's words (the engine's own). The status row above it already says
 * "Sync paused", and once a retried failure has lasted 10 minutes the banner says since when.
 */
export const bannerText = (failure: SyncFailure): string =>
  isFailing(failure) ? failingSinceMessage(failure.since) : pausedDetail(failure.message)

/** What the banners say about a failure (offline has no banner: the status row says it). */
export const failureBanner = (failure: SyncFailure | null): string | null =>
  !failure || failure.kind === 'offline' ? null : bannerText(failure)

/**
 * Re-renders once when a retried failure reaches 10 minutes, so its colour and words turn then
 * and not at the next retry.
 */
export function useFailingTurn(failure: SyncFailure | null): void {
  const [, setTurned] = useState(0)
  useEffect(() => {
    if (!failure || isFailing(failure)) return undefined
    const at = failure.since + FAILING_AFTER_MS
    if (!isFailing(failure, at)) return undefined // offline or paused: never turns
    const timer = setTimeout(() => setTurned((n) => n + 1), at - Date.now())
    return () => clearTimeout(timer)
  }, [failure])
}

interface StatusInput {
  status: CloudStatus
  lastSyncAt: number | null
  pendingLocal: boolean
  pending: number
  lastError: SyncFailure | null
  waitingForOld: number
  /** The owner's own Sync now is on the wire. */
  manual: boolean
  /** Offline, sync runs by itself once the device is back (`syncsWhenOnline`). */
  resumes: boolean
}

export interface StatusView {
  label: string
  tone: Tone
  /** A cycle is running (the dot pulses). */
  busy: boolean
}

/** " · retry in 30 s" (rounded up to 5 s) while a retry is scheduled. */
function retryIn(failure: SyncFailure): string {
  if (failure.retryAt === undefined || isPaused(failure.kind)) return ''
  const s = Math.ceil((failure.retryAt - Date.now()) / 5000) * 5
  return s > 0 ? ` · retry in ${String(s)} s` : ''
}

/**
 * The status row. "Synced" only when the last cycle succeeded with nothing left to send and
 * nothing held back. A background cycle keeps the last result on screen (no flicker), so a
 * retry after a failure keeps showing the failure, never an older "Synced".
 */
export function statusView(s: StatusInput): StatusView {
  // Linked, before the first cycle (the engine's code may still be loading): nothing is known
  // to be on the relay yet.
  if (s.status === 'off' || s.status === 'idle') {
    return { label: 'Starting sync…', tone: 'accent', busy: true }
  }
  if (s.status === 'offline') {
    // The promise only when sync will run by itself: not when its code failed to load here.
    const waiting = s.pending > 0 ? ` · ${s.pending.toLocaleString()} to sync` : ''
    return {
      label: s.resumes ? `${ERROR_LABEL.offline}${waiting}` : 'Offline · not synced',
      tone: 'warning',
      busy: false,
    }
  }
  if (s.manual) return { label: 'Syncing…', tone: 'accent', busy: true }
  const busy = s.status === 'syncing'
  const failure = s.lastError
  if (s.status === 'error' || s.status === 'paused' || (failure && failure.kind !== 'offline')) {
    if (!failure) {
      return {
        label: s.status === 'paused' ? 'Sync paused' : 'Sync failed',
        tone: 'negative',
        busy,
      }
    }
    return {
      label: ERROR_LABEL[failure.kind] + retryIn(failure),
      tone: failureTone(failure),
      busy,
    }
  }
  // The relay holds the old device's copy, not this one: saved, but not "Synced". Before
  // pending, which a held-back push leaves set: nothing is due until something changes here.
  if (s.waitingForOld > 0) {
    return { label: 'Saved here · other device needs update', tone: 'info', busy }
  }
  if (busy && (s.pendingLocal || s.pending > 0 || s.lastSyncAt === null)) {
    return { label: 'Syncing…', tone: 'accent', busy }
  }
  if (s.pending > 0) {
    return { label: `Saved here · ${s.pending.toLocaleString()} to sync`, tone: 'accent', busy }
  }
  if (s.pendingLocal) return { label: 'Saved here · syncing soon', tone: 'accent', busy }
  const ago = s.lastSyncAt === null ? '' : ` · ${timeAgo(s.lastSyncAt)}`
  return { label: `Synced${ago}`, tone: 'positive', busy }
}

export type SetupLead = 'generated' | 'connected'

/**
 * A failed first sync after Generate, Join or Reconnect, led by what did happen: the code was
 * created or saved, never "connected" (the relay may have refused it). A pause promises no sync
 * "yet": it lasts until the owner acts, and so does refused access. When a banner now says why
 * (`bannerSaysWhy`), the toast leaves the why to it, so the same sentence is not said twice.
 */
export function setupFailure(
  lead: SetupLead,
  result: Extract<SyncResult, { ok: false }>,
  bannerSaysWhy: boolean,
): string {
  const done = lead === 'generated' ? 'Sync code created' : 'Code saved'
  switch (result.error) {
    case 'too-large':
    case 'not-found':
    case 'denied':
      return bannerSaysWhy
        ? `${done}. Sync is paused.`
        : `${done}. Sync is paused: ${pausedDetail(result.message)}`
    case 'moved':
    case 'update-required':
    case 'reload':
      return bannerSaysWhy ? `${done}. Sync is paused.` : `${done}. ${result.message}`
    case 'permission':
      return `${done}, but the sync server refused access.`
  }
  const but =
    lead === 'generated'
      ? `${done}, but the first sync didn't finish`
      : `${done}, but couldn't sync yet`
  return bannerSaysWhy ? `${but}.` : `${but}: ${result.message}`
}

export type SetupRequest =
  | { kind: 'generate' }
  | { kind: 'join'; code: string }
  | { kind: 'reconnect'; code: string; established: boolean }
