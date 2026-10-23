import { useState } from 'react'
import { Check, Cloud, Loader2, WifiOff, AlertCircle, Info, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { useExpenseStore } from '../stores/useExpenseStore'
import {
  OLD_DEVICE_WAITING,
  clockTime,
  failureSeverity,
  isFailing,
  isPaused,
  pausedDetail,
  useSyncStore,
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

type Tone = 'neutral' | 'info' | 'saved' | 'accent' | 'warn' | 'error'

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
  /** Fixed for the state: the live region speaks it, so a ticking clock never does. */
  label: string
  /** Shown after the label as "· 2m ago" (visual only) and as the local time in the tooltip. */
  at?: number
  /** Why: the tooltip, and read after the label. */
  reason?: string
}

/**
 * Local save state and cloud sync state in one pill; the worst state wins. "Synced" shows only
 * when the last cycle succeeded and nothing local is waiting for the relay.
 */
function usePillView(): PillView {
  const localStatus = useExpenseStore((s) => s.syncStatus)
  const lastSavedAt = useExpenseStore((s) => s.lastSavedAt)
  const isOffline = useExpenseStore((s) => s.isOffline)
  const syncId = useSyncStore((s) => s.syncId)
  const lastError = useSyncStore((s) => s.lastError)
  const pendingLocal = useSyncStore((s) => s.pendingLocal)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const configured = syncEnabled && syncId !== null
  const cloudError = configured ? lastError : null

  if (localStatus === 'error') {
    return { state: 'save-failed', tone: 'error', icon: AlertCircle, label: 'Save failed' }
  }
  if (cloudError && isPaused(cloudError.kind)) {
    return {
      state: 'paused',
      // The same colour as Settings › Sync: amber for a reload, red for too large.
      tone: failureSeverity(cloudError) === 'warning' ? 'warn' : 'error',
      icon: AlertCircle,
      label: 'Sync paused',
      reason: pausedDetail(cloudError.message),
    }
  }
  if (cloudError && cloudError.kind !== 'offline') {
    const tone = failureSeverity(cloudError) === 'warning' ? 'warn' : 'error'
    if (isFailing(cloudError)) {
      return {
        state: 'failing',
        tone,
        icon: AlertCircle,
        label: `Sync failing since ${clockTime(cloudError.since)}`,
        reason: cloudError.message,
      }
    }
    return {
      state: 'retrying',
      tone,
      icon: AlertCircle,
      label: 'Sync retrying',
      reason: cloudError.message,
    }
  }
  if (isOffline || cloudError?.kind === 'offline') {
    return {
      state: 'offline',
      tone: 'warn',
      icon: WifiOff,
      label: configured && pendingLocal ? 'Offline · not synced' : 'Offline',
    }
  }
  if (localStatus === 'saving') {
    return { state: 'saving', tone: 'accent', icon: Loader2, label: 'Saving…' }
  }
  // Before pending: a held-back push is pending too, but no push is due until something
  // changes here (which clears waitingForOld), so a spinner would spin over nothing.
  if (configured && waitingForOld) {
    // Short: the pill shares the top bar with quick add. The tooltip tells the whole story.
    return {
      state: 'waiting-for-old',
      tone: 'info',
      icon: Info,
      label: 'Update old device',
      reason: OLD_DEVICE_WAITING,
    }
  }
  if (configured && pendingLocal) {
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

/** States that need the owner: announced as they happen. */
const ALERTS: ReadonlySet<string> = new Set([
  'save-failed',
  'paused',
  'failing',
  'retrying',
  'offline',
  'waiting-for-old',
])
/** States on the way somewhere: never announced, and no recovery yet. */
const PASSING: ReadonlySet<string> = new Set(['saving', 'syncing'])

const spoken = (view: PillView): string =>
  view.reason ? `${view.label}. ${view.reason}` : view.label

/**
 * What the live region says: each problem as it starts, then the settled state that ends it
 * (a recovery). Saving and syncing come and go many times a minute and are never spoken. While
 * Settings is open on Sync (`muted`), its status row and banners speak for sync: the pill
 * follows along silently, so one event is announced once.
 */
function useAnnouncement(view: PillView, muted: boolean): string {
  const [said, setSaid] = useState(() => ({
    state: view.state,
    text: ALERTS.has(view.state) ? spoken(view) : '',
    recovering: ALERTS.has(view.state),
  }))
  if (view.state !== said.state) {
    if (muted) {
      setSaid({ ...said, state: view.state, recovering: ALERTS.has(view.state) })
    } else if (ALERTS.has(view.state)) {
      setSaid({ state: view.state, text: spoken(view), recovering: true })
    } else if (PASSING.has(view.state)) {
      setSaid({ ...said, state: view.state })
    } else {
      setSaid({
        state: view.state,
        text: said.recovering ? spoken(view) : said.text,
        recovering: false,
      })
    }
  }
  return said.text
}

export function SyncPill() {
  const view = usePillView()
  const muted = useUIStore(syncPanelShown)
  const announcement = useAnnouncement(view, muted)
  // Re-render every 15 s so the relative times stay current and a failure turns red on time.
  useTick(15_000)

  const Icon = view.icon
  const title =
    view.reason ?? (view.at === undefined ? undefined : new Date(view.at).toLocaleTimeString())
  // Screen readers hear the live region, which stays mounted (a change inside it is announced,
  // a region inserted with its content often is not). The pill they skip carries the ticking
  // "2m ago", which would otherwise be read out every 15 s.
  return (
    <div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <div
        key={view.state}
        aria-hidden="true"
        style={{ animation: 'sync-pill-in 0.15s ease both' }}
        className={clsx(
          'inline-flex max-w-52 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
          TONES[view.tone],
        )}
        title={title}
      >
        <Icon
          size={12}
          className={clsx('shrink-0', Icon === Loader2 && 'animate-spin')}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">
          {view.label}
          {view.at !== undefined && ` · ${timeAgo(view.at)}`}
        </span>
      </div>
    </div>
  )
}
