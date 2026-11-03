import { useState } from 'react'
import { Check, Cloud, Loader2, WifiOff, AlertCircle, Info, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { useExpenseStore, type LocalStatus } from '../stores/useExpenseStore'
import {
  OLD_DEVICE_WAITING,
  clockTime,
  failureSeverity,
  isFailing,
  isPaused,
  needsReload,
  pausedDetail,
  useSyncStore,
  type SyncPauseReason,
} from '../stores/useSyncStore'
import { syncPanelShown, useUIStore } from '../stores/useUIStore'
import { syncEnabled } from '../services/syncConfig'
import { useTick } from '../hooks/useTick'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

/** "· 30 s" to the next retry, rounded up to 5 s; nothing once it is due. */
function retryIn(at: number): string {
  const s = Math.ceil((at - Date.now()) / 5000) * 5
  return s > 0 ? ` · ${s} s` : ''
}

type Tone = 'neutral' | 'info' | 'saved' | 'accent' | 'warn' | 'error'

/** Why nothing is being saved, in the tooltip. */
const NOT_SAVED: Record<LocalStatus, string | undefined> = {
  saved: undefined,
  'error-quota': 'Storage on this device is full.',
  'error-storage': 'This browser is blocking storage.',
  'memory-only': "Saved data couldn't be read, so nothing is written over it.",
}

/** What a pause asks of the owner, in the few words the top bar has room for. */
const PAUSED: Record<SyncPauseReason, string> = {
  'too-large': 'too large',
  denied: 'refused',
  'not-found': 'code not found',
  moved: 'reload to update',
  'update-required': 'reload to update',
  reload: 'reload to update',
}

// In the light theme the global amber-700 and green-700 text measured under 4.5:1 on these
// tinted pills; the 800s clear it.
const TONES: Record<Tone, string> = {
  neutral: 'text-[var(--text-tertiary)] border-white/[0.06]',
  info: 'text-[var(--text-secondary)] border-white/[0.1] bg-white/[0.03]',
  saved: 'text-positive border-positive/25 bg-positive/5 [[data-theme=light]_&]:text-[#166534]',
  accent: 'text-accent border-accent/30 bg-accent/5',
  warn: 'text-warning border-warning/30 bg-warning/10 [[data-theme=light]_&]:text-[#92400e]',
  error: 'text-negative border-negative/30 bg-negative/10',
}

interface PillView {
  /** Identifies the state; the entrance animation replays only when it changes. */
  state: string
  tone: Tone
  icon: LucideIcon
  /** Fixed for the state: the live region speaks it, so a ticking clock or count never does. */
  label: string
  /** Shown after the label only (" · 3 to sync"). */
  more?: string
  /** Shown after the label as "· 2m ago" (visual only) and as the local time in the tooltip. */
  at?: number
  /** Shown after the label as "· 30 s" to the next retry (visual only). */
  retryAt?: number
  /** Why: read after the label, and the tooltip unless `title` says more. */
  reason?: string
  title?: string
  /** The words a toast says this in, if one does. */
  news?: string
  /** A sync problem: the pill is a button that opens Settings › Sync, which says what to do. */
  opens?: boolean
}

const waitingTitle = (n: number): string =>
  `${n.toLocaleString()} ${n === 1 ? 'change waits' : 'changes wait'} for your other device to update. Everything is saved here.`

/**
 * Local save state and cloud sync state in one pill; the worst state wins (track spec §3.11).
 * "Synced" shows only when the last cycle succeeded and nothing local is waiting for the relay.
 */
function usePillView(): PillView {
  const localStatus = useExpenseStore((s) => s.syncStatus)
  const local = useExpenseStore((s) => s.local)
  const bootError = useExpenseStore((s) => s.bootError)
  const lastSavedAt = useExpenseStore((s) => s.lastSavedAt)
  const isOffline = useExpenseStore((s) => s.isOffline)
  const syncId = useSyncStore((s) => s.syncId)
  const cloudStatus = useSyncStore((s) => s.cloudStatus)
  const lastError = useSyncStore((s) => s.lastError)
  const pendingLocal = useSyncStore((s) => s.pendingLocal)
  const pending = useSyncStore((s) => s.pending)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  // A sync set up by a newer SpendTrack is paused with no code this build can read.
  const configured = syncEnabled && (syncId !== null || cloudStatus === 'paused')
  const cloudError = configured ? lastError : null

  // The data engine never loaded: nothing was read, so nothing can be called saved (the screen
  // says so itself, so the pill is not announced).
  if (bootError !== null) {
    return {
      state: 'not-loaded',
      tone: 'error',
      icon: AlertCircle,
      label: 'Not loaded',
      reason: "SpendTrack couldn't start. Your data is still saved on this device.",
    }
  }
  if (localStatus === 'error') {
    return {
      state: 'save-failed',
      tone: 'error',
      icon: AlertCircle,
      label: 'Not saved',
      reason: NOT_SAVED[local],
    }
  }
  if (cloudError && cloudError.kind !== 'offline') {
    // The same colour as Settings › Sync: amber to wait out or reload, red when it needs you.
    const tone = failureSeverity(cloudError) === 'warning' ? 'warn' : 'error'
    const problem = {
      tone,
      icon: AlertCircle,
      reason: cloudError.message,
      news: cloudError.message,
      opens: true,
    } as const
    if (isPaused(cloudError.kind)) {
      return {
        ...problem,
        state: `paused:${needsReload(cloudError.kind) ? 'reload' : cloudError.kind}`,
        label: `Sync paused · ${PAUSED[cloudError.kind]}`,
        // Said once: the label already says "Sync paused".
        reason: pausedDetail(cloudError.message),
      }
    }
    if (isFailing(cloudError)) {
      return {
        ...problem,
        state: 'failing',
        label: `Sync failing since ${clockTime(cloudError.since)}`,
      }
    }
    // Red says "needs you": a refusal is not something to wait out.
    if (cloudError.kind === 'permission') {
      return { ...problem, state: 'refused', label: 'Sync refused' }
    }
    return { ...problem, state: 'retrying', label: 'Sync retrying', retryAt: cloudError.retryAt }
  }
  if (isOffline || cloudError?.kind === 'offline') {
    return {
      state: 'offline',
      tone: 'warn',
      icon: WifiOff,
      label: 'Offline',
      more: configured && pending > 0 ? ` · ${pending.toLocaleString()} to sync` : undefined,
    }
  }
  if (localStatus === 'saving') {
    return { state: 'saving', tone: 'accent', icon: Loader2, label: 'Saving…' }
  }
  // Before pending: a held-back push is pending too, but no push is due until something
  // changes here (which clears waitingForOld), so a spinner would spin over nothing.
  if (configured && waitingForOld > 0) {
    // Short: the pill shares the top bar with quick add. The tooltip tells the whole story.
    return {
      state: 'waiting-for-old',
      tone: 'info',
      icon: Info,
      label: 'Update other device',
      reason: OLD_DEVICE_WAITING,
      title: waitingTitle(waitingForOld),
      news: OLD_DEVICE_WAITING,
      opens: true,
    }
  }
  if (configured && (pending > 0 || pendingLocal)) {
    // Waiting for its debounce: counted, not spun. A cycle carrying it, or the first cycle
    // (nothing is known to be on the relay yet), spins.
    if (pending > 0 && cloudStatus !== 'syncing') {
      return {
        state: 'to-sync',
        tone: 'accent',
        icon: Cloud,
        label: `${pending.toLocaleString()} to sync`,
      }
    }
    return { state: 'syncing', tone: 'accent', icon: Loader2, label: 'Syncing…' }
  }
  if (configured && lastSyncAt !== null) {
    return { state: 'synced', tone: 'saved', icon: Cloud, label: 'Synced', at: lastSyncAt }
  }
  if (localStatus === 'saved' && lastSavedAt) {
    return { state: 'saved', tone: 'saved', icon: Check, label: 'Saved', at: lastSavedAt }
  }
  return { state: 'idle', tone: 'neutral', icon: Check, label: 'Saved' }
}

/** States that need the owner: announced as they happen. Every pause (`paused:<kind>`) too. */
const ALERTS: ReadonlySet<string> = new Set([
  'save-failed',
  'failing',
  'refused',
  'retrying',
  'offline',
  'waiting-for-old',
])
const isAlert = (state: string): boolean => ALERTS.has(state) || state.startsWith('paused:')
/** States on the way somewhere: never announced, and no recovery yet. */
const PASSING: ReadonlySet<string> = new Set(['saving', 'syncing', 'to-sync'])

const spoken = (view: PillView): string =>
  view.reason ? `${view.label}. ${view.reason}` : view.label

interface Said {
  /** The pill state the region last followed. */
  state: string
  /** What the region holds: never a claim the pill no longer makes ('' is always true). */
  text: string
  /** A problem was open: the next settled state is a recovery, and is said. */
  recovering: boolean
  muted: boolean
}

/**
 * What the live region says: each problem as it starts, then the settled state that ends it
 * (a recovery). Saving and syncing come and go many times a minute and are never spoken.
 *
 * Another voice can say a change instead: Settings open on Sync (`muted`), a modal whose banners
 * (a live region) announce each problem, or a toast already on screen with the same words
 * (`toasted`). Then the region empties instead (a removal is not announced), so one event is
 * heard once and the region never keeps a claim that is no longer true. When the panel closes,
 * a problem the region does not hold yet is said then.
 */
function useAnnouncement(view: PillView, muted: boolean, toasted: boolean): string {
  const [said, setSaid] = useState<Said>(() => ({
    state: view.state,
    text: isAlert(view.state) ? spoken(view) : '',
    recovering: isAlert(view.state),
    muted,
  }))
  if (view.state === said.state && muted === said.muted) return said.text
  const alert = isAlert(view.state)
  const passing = PASSING.has(view.state)
  let next: Said
  if (view.state === said.state) {
    // Only the panel opened or closed.
    const tell = !muted && alert && said.text === ''
    next = { ...said, muted, text: tell ? spoken(view) : said.text }
  } else if (muted || (alert && toasted)) {
    next = {
      state: view.state,
      text: '',
      recovering: passing ? said.recovering : alert,
      muted,
    }
  } else if (alert) {
    next = { state: view.state, text: spoken(view), recovering: true, muted }
  } else if (passing) {
    next = { ...said, state: view.state, muted }
  } else {
    next = {
      state: view.state,
      text: said.recovering ? spoken(view) : said.text,
      recovering: false,
      muted,
    }
  }
  setSaid(next)
  return next.text
}

/**
 * Settings › Sync, with focus on Sync now beside the status row that says what is wrong (one
 * Tab from the problem, not five). A sync a newer SpendTrack set up has no Sync now: its view
 * opens as it is.
 */
function openSyncSettings(): void {
  const ui = useUIStore.getState()
  if (useSyncStore.getState().syncId === null) ui.setSettingsTab('sync')
  else ui.focusSettings('sync', 'sync-now')
  ui.setSettingsOpen(true)
}

export function SyncPill() {
  const view = usePillView()
  const muted = useUIStore(syncPanelShown)
  const toasted = useUIStore(
    (s) => view.news !== undefined && s.toasts.some((t) => t.message === view.news),
  )
  // A failed save is said by its strip under the top bar (DataNotices), on every screen size;
  // this pill is hidden on phones. The region still says the save that ends it.
  const announcement = useAnnouncement(view, muted, toasted || view.state === 'save-failed')
  // Re-render so the relative times stay current, a failure turns red on time and the retry
  // countdown moves in its 5 s steps.
  useTick(view.retryAt === undefined ? 15_000 : 5_000)

  const Icon = view.icon
  const title =
    view.title ??
    view.reason ??
    (view.at === undefined ? undefined : new Date(view.at).toLocaleTimeString())
  const className = clsx(
    // display: none below 1280 px, so the pill is never an invisible focus stop on a phone.
    'hidden min-h-6 max-w-52 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium xl:inline-flex',
    TONES[view.tone],
    isAlert(view.state) && 'sync-pill-in',
  )
  const content = (
    <>
      <Icon
        size={12}
        className={clsx('shrink-0', Icon === Loader2 && 'animate-spin')}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {view.label}
        {view.more}
        {view.at !== undefined && ` · ${timeAgo(view.at)}`}
        {view.retryAt !== undefined && retryIn(view.retryAt)}
      </span>
    </>
  )
  // Screen readers hear the live region, which stays mounted at every width (a change inside it
  // is announced, a region inserted with its content often is not). The pill carries the ticking
  // "2m ago" and the countdown, which would otherwise be read out every few seconds: a plain
  // pill is hidden from them, and a problem pill is a button named by its fixed label.
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {view.opens ? (
        <button
          key={view.state}
          type="button"
          onClick={openSyncSettings}
          aria-label={`${view.label}. Opens Settings, Sync.`}
          title={title}
          className={clsx(className, 'tap-target transition hover:brightness-110')}
        >
          {content}
        </button>
      ) : (
        <div key={view.state} aria-hidden="true" title={title} className={className}>
          {content}
        </div>
      )}
    </>
  )
}
