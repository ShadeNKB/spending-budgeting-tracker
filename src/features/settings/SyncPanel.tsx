import { useEffect, useId, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  Cloud,
  CloudOff,
  Link2,
  Link2Off,
  RefreshCw,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Info,
  Download,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { shieldGesture } from '../../ui/pressShield'
import {
  FAILING_AFTER_MS,
  OLD_DEVICE_WAITING,
  failingSinceMessage,
  failureSeverity,
  isFailing,
  isPaused,
  needsReload,
  pausedDetail,
  reloadSpendTrack,
  syncsWhenOnline,
  useSyncStore,
  type CloudStatus,
  type SyncFailure,
  type SyncResult,
} from '../../stores/useSyncStore'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { syncEnabled } from '../../services/syncConfig'
import { useTick } from '../../hooks/useTick'
import { useToast } from '../../hooks/useToast'
import { ARIA_DISABLED, DemoQuestion, JoinSync } from './JoinSync'
import { SyncCode } from './SyncCode'
import { SyncDevices } from './SyncDevices'
import {
  forgetPrevious,
  keepPrevious,
  maskCode,
  readPrevious,
  spokenEnd,
  timeAgo,
} from './previousCode'
import clsx from 'clsx'

const LEGACY_BANNER_MS = 24 * 60 * 60_000

const CODE_SAFETY =
  'Share the code only with your own devices: anyone with it can change your synced data.'

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
  'update-required': 'Sync paused',
  reload: 'Sync paused',
  'not-found': 'Sync paused',
  denied: 'Sync paused',
}

type Tone = 'muted' | 'accent' | 'positive' | 'info' | 'warning' | 'negative'

/** The row colour of a failure: the same meaning as on the pill and in the toasts. */
const failureTone = (failure: SyncFailure): Extract<Tone, 'warning' | 'negative'> =>
  failureSeverity(failure) === 'warning' ? 'warning' : 'negative'

/**
 * A failure in the banner's words (the engine's own). The status row above it already says
 * "Sync paused", and once a retried failure has lasted 10 minutes the banner says since when.
 */
const bannerText = (failure: SyncFailure): string =>
  isFailing(failure) ? failingSinceMessage(failure.since) : pausedDetail(failure.message)

/** What the banners say about a failure (offline has no banner: the status row says it). */
const failureBanner = (failure: SyncFailure | null): string | null =>
  !failure || failure.kind === 'offline' ? null : bannerText(failure)

/**
 * Re-renders once when a retried failure reaches 10 minutes, so its colour and words turn then
 * and not at the next retry.
 */
function useFailingTurn(failure: SyncFailure | null): void {
  const [, setTurned] = useState(0)
  useEffect(() => {
    if (!failure || isFailing(failure)) return undefined
    const at = failure.since + FAILING_AFTER_MS
    if (!isFailing(failure, at)) return undefined // offline or paused: never turns
    const timer = setTimeout(() => setTurned((n) => n + 1), at - Date.now())
    return () => clearTimeout(timer)
  }, [failure])
}

const ROW_TEXT: Record<Tone, string> = {
  muted: 'text-[var(--text-tertiary)]',
  accent: 'text-accent',
  positive: 'text-positive',
  info: 'text-[var(--text-secondary)]',
  warning: 'text-warning',
  negative: 'text-negative',
}

// 'info' is neutral grey, as on the pill: cyan means a sync in progress, and nothing is.
const ROW_DOT: Record<Tone, string> = {
  muted: 'bg-white/20',
  accent: 'bg-accent',
  positive: 'bg-positive',
  info: 'bg-[var(--text-tertiary)]',
  warning: 'bg-warning',
  negative: 'bg-negative',
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

interface StatusView {
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
function statusView(s: StatusInput): StatusView {
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

type BannerTone = 'error' | 'warning' | 'info'

type SetupLead = 'generated' | 'connected'

/**
 * A failed first sync after Generate, Join or Reconnect, led by what did happen: the code was
 * created or saved, never "connected" (the relay may have refused it). A pause promises no sync
 * "yet": it lasts until the owner acts, and so does refused access. When a banner now says why
 * (`bannerSaysWhy`), the toast leaves the why to it, so the same sentence is not said twice.
 */
function setupFailure(
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

/** Controls that take focus after a view swap (see `focusNext`). */
type FocusTarget = 'sync-now' | 'generate' | 'reconnect' | 'disconnect'

const BANNER_TONE: Record<BannerTone, string> = {
  error: 'border-negative/20 bg-negative/10 text-negative',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  info: 'border-white/[0.1] bg-white/[0.03] text-[var(--text-secondary)]',
}

const ACTION_TONE: Record<Exclude<BannerTone, 'info'>, string> = {
  error: 'border-negative/30 text-negative hover:bg-negative/10',
  warning: 'border-warning/30 text-warning hover:bg-warning/10',
}

interface BannerView {
  key: 'reload' | 'failing' | 'old-device' | 'size'
  tone: BannerTone
  icon: LucideIcon
  text: string
  action?: { icon: LucideIcon; label: string; onClick: () => void }
}

const UNTIL_UPDATED =
  "Until then, don't rename categories, restore backups or delete everything on it."

/** What the old-device banner says: one sentence, the oldest writer seen first. */
function oldDeviceText(
  seen: { v084: boolean; v085: boolean; v5pre: boolean },
  waiting: boolean,
): string | null {
  if (seen.v084) {
    return `${
      waiting
        ? 'An older SpendTrack (0.8.4 or earlier) on your other device keeps overwriting the synced copy. Open it and reload; everything is saved here.'
        : 'A device still runs an old SpendTrack (0.8.4 or earlier). Open it and reload.'
    } ${UNTIL_UPDATED}`
  }
  if (waiting) return OLD_DEVICE_WAITING
  const version = seen.v085 ? '0.9.2' : seen.v5pre ? '0.10.0' : null
  return version === null
    ? null
    : `Your other device runs SpendTrack ${version}. Open it and reload to update.`
}

/** What the owner must know about sync right now, worst first. */
function useBanners(): BannerView[] {
  const lastError = useSyncStore((s) => s.lastError)
  const legacyWriterAt = useSyncStore((s) => s.legacyWriterAt)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const view = useSyncStore((s) => s.view)
  const focusSettings = useUIStore((s) => s.focusSettings)
  const banners: BannerView[] = []
  if (lastError && needsReload(lastError.kind)) {
    banners.push({
      key: 'reload',
      tone: 'warning',
      icon: AlertCircle,
      text: bannerText(lastError),
      // A new build that is already waiting takes over first; a plain reload would come back
      // on the old one, to the same pause.
      action: { icon: RefreshCw, label: 'Reload', onClick: reloadSpendTrack },
    })
  } else if (lastError && lastError.kind !== 'offline') {
    banners.push({
      key: 'failing',
      tone: failureSeverity(lastError) === 'warning' ? 'warning' : 'error',
      icon: AlertCircle,
      text: bannerText(lastError),
      // The message says to export a backup: one tap to the button that does it.
      action:
        lastError.kind === 'too-large'
          ? {
              icon: Download,
              label: 'Export backup',
              onClick: () => focusSettings('backup', 'backup-download'),
            }
          : undefined,
    })
  }
  const now = Date.now()
  const recent = (at: number | null | undefined) =>
    at !== null && at !== undefined && now - at < LEGACY_BANNER_MS
  const old = oldDeviceText(
    {
      v084: recent(legacyWriterAt) || recent(view?.legacy.v084At),
      v085: recent(view?.legacy.v085At),
      v5pre: recent(view?.legacy.v5preAt),
    },
    waitingForOld > 0,
  )
  if (old !== null) banners.push({ key: 'old-device', tone: 'info', icon: Info, text: old })
  const pct = view?.sizePct ?? null
  // Over 100 % the too-large pause says it already, with the size.
  if (pct !== null && pct >= 70 && lastError?.kind !== 'too-large') {
    banners.push({
      key: 'size',
      tone: pct >= 90 ? 'warning' : 'info',
      icon: pct >= 90 ? AlertCircle : Info,
      text: `Sync uses ${String(pct)} % of the relay limit. At 100 % sync pauses; your data stays on this device.`,
    })
  }
  return banners
}

/**
 * The banners, and one live region that is always mounted (empty when all is well), so a
 * banner that appears while the panel is open is announced: screen readers read what is added
 * to a region, not a region added with it. The region holds the sentences only, as the pill's
 * does: a button inside it would be read as part of the sentence ("…to update. Reload"). The
 * banner shows the same words to the eye, and its button is described by them.
 */
function SyncBanners({ flush = false }: { flush?: boolean }) {
  const banners = useBanners()
  const idBase = useId()
  const textId = (key: BannerView['key']) => `${idBase}-${key}`
  return (
    <>
      <div role="status" className="sr-only">
        {banners.map((b) => (
          <p key={b.key} id={textId(b.key)}>
            {b.text}
          </p>
        ))}
      </div>
      {/* Empty, it takes no space; with a banner, the margin stands in for the card's gap. */}
      <div className={clsx('flex flex-col gap-2', !flush && '[&:not(:empty)]:mt-3')}>
        {banners.map(({ key, tone, icon: Icon, text, action }) => (
          <div
            key={key}
            className={clsx(
              'flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-2 text-[13px] leading-relaxed md:text-[11px]',
              BANNER_TONE[tone],
            )}
          >
            <Icon size={12} className="shrink-0" aria-hidden="true" />
            <span aria-hidden="true" className="min-w-0 flex-1 basis-40">
              {text}
            </span>
            {action && tone !== 'info' && (
              <button
                type="button"
                onClick={action.onClick}
                aria-describedby={textId(key)}
                className={clsx(
                  'tap-target inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition md:h-8',
                  ACTION_TONE[tone],
                )}
              >
                <action.icon size={12} aria-hidden="true" /> {action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

export function SyncPanel() {
  if (!syncEnabled) return <NotConfigured />
  return <SyncContent />
}

function NotConfigured() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <CloudOff size={14} className="text-[var(--text-tertiary)]" />
          Cloud sync not configured
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          To enable cross-device sync, add Supabase credentials to your environment. Your data stays
          local-first — Supabase is only used as a relay.
        </p>
        <ol className="mt-1 flex flex-col gap-1.5 text-[12px] text-[var(--text-tertiary)]">
          <li className="flex gap-2">
            <span className="font-mono text-accent">1.</span>
            Create a free project at <span className="font-mono text-white/60">supabase.com</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">2.</span>
            Run the SQL migration from{' '}
            <span className="font-mono text-white/60">supabase/migrations/001_sync.sql</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">3.</span>
            Add <span className="font-mono text-white/60">VITE_SUPABASE_URL</span> and{' '}
            <span className="font-mono text-white/60">VITE_SUPABASE_ANON_KEY</span> to Vercel and
            your local <span className="font-mono text-white/60">.env.local</span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-accent">4.</span>
            Redeploy — sync activates automatically
          </li>
        </ol>
      </div>
    </div>
  )
}

type SetupRequest =
  | { kind: 'generate' }
  | { kind: 'join'; code: string }
  | { kind: 'reconnect'; code: string; established: boolean }

function SyncContent() {
  const syncId = useSyncStore((s) => s.syncId)
  const cloudStatus = useSyncStore((s) => s.cloudStatus)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const lastError = useSyncStore((s) => s.lastError)
  const pendingLocal = useSyncStore((s) => s.pendingLocal)
  const pending = useSyncStore((s) => s.pending)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const resumes = useSyncStore(syncsWhenOnline)
  const setupSync = useSyncStore((s) => s.setupSync)
  const disconnectSync = useSyncStore((s) => s.disconnectSync)
  const triggerSync = useSyncStore((s) => s.triggerSync)
  const toast = useToast()

  // The setup this panel is running, if any: every setup control waits for it.
  const [connecting, setConnecting] = useState<SetupRequest['kind'] | null>(null)
  const [manualSyncing, setManualSyncing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // Generate while this device remembers a code it left (F-050): one sync or two?
  const [askSeparate, setAskSeparate] = useState(false)
  // Generate or Reconnect asked while the demo's sample rows are here (P2-22): they never
  // sync, so the owner decides first whether to keep them on this device. (Join asks in its
  // own row.)
  const [askDemo, setAskDemo] = useState<SetupRequest | null>(null)
  // Join is checking a code or asking its own question: Generate and Reconnect wait, and Join
  // waits while they ask, so one question is on screen at a time.
  const [joinActive, setJoinActive] = useState(false)
  // Each request this panel starts takes a number, and Disconnect moves past it: a request
  // still on the wire then (a hung first sync) keeps no button busy and reports nothing.
  const requestGen = useRef(0)
  // A press that swaps the view unmounts the pressed control. Its successor takes focus when
  // it mounts, so keyboard and screen-reader focus stays in the panel, never on <body>.
  const focusNext = useRef<FocusTarget | null>(null)
  const statusId = useId()
  const reconnectHintId = useId()
  useFailingTurn(lastError)
  // "Synced · 2m ago" ages while the panel stays open, as on the pill; a retry counts down.
  useTick(lastError?.retryAt === undefined ? 15_000 : 5_000)

  /** A ref that focuses its element on mount when it is the successor asked for. */
  const focusWhenShown = (target: FocusTarget) => (element: HTMLElement | null) => {
    if (element && focusNext.current === target) {
      focusNext.current = null
      element.focus()
    }
  }

  /** Forgets a successor that never mounted (the request failed before the view changed). */
  const dropFocusRequest = (target: FocusTarget) => {
    if (focusNext.current === target) focusNext.current = null
  }

  /** Runs one panel request; `report` sees its result only if no Disconnect came between. */
  const runRequest = async (
    setBusy: (busy: boolean) => void,
    request: () => Promise<SyncResult>,
    report: (result: SyncResult) => void,
  ) => {
    const gen = ++requestGen.current
    setBusy(true)
    try {
      const result = await request()
      if (gen === requestGen.current) report(result)
    } finally {
      if (gen === requestGen.current) setBusy(false)
    }
  }

  /**
   * A failed result in its colour: the streak it belongs to decides (a retried failure turns red
   * after 10 minutes). 'off' means sync was switched off meanwhile: no toast.
   */
  const reportFailure = (result: SyncResult, message?: string) => {
    if (result.ok || result.error === 'off') return
    const streak = useSyncStore.getState().lastError
    const since = streak?.kind === result.error ? streak.since : Date.now()
    const text = message ?? result.message
    if (failureSeverity({ kind: result.error, since }) === 'warning') toast.warning(text)
    else toast.error(text)
  }

  /**
   * The banners now say something about the last failure that they did not say before the
   * request (`before`): their live region announces it, so a toast must not say it again.
   */
  const bannerNowSays = (before: string | null): boolean => {
    const shown = failureBanner(useSyncStore.getState().lastError)
    return shown !== null && shown !== before
  }

  /** Held back for an old device: saved here, but the relay does not hold this copy. */
  const heldBack = () => useSyncStore.getState().waitingForOld > 0

  /** Runs one setup, then says how it went: `done` on success. */
  const link = async (
    kind: SetupRequest['kind'],
    request: () => Promise<SyncResult>,
    done: string,
    after?: (result: SyncResult) => void,
  ) => {
    focusNext.current = 'sync-now'
    const lead: SetupLead = kind === 'generate' ? 'generated' : 'connected'
    const before = failureBanner(useSyncStore.getState().lastError)
    const setBusy = (busy: boolean) => {
      setConnecting(busy ? kind : null)
    }
    await runRequest(setBusy, request, (result) => {
      after?.(result)
      if (!result.ok) reportFailure(result, setupFailure(lead, result, bannerNowSays(before)))
      else if (heldBack()) toast.info(OLD_DEVICE_WAITING)
      else toast.success(done)
    })
    dropFocusRequest('sync-now')
  }

  const run = (request: SetupRequest) => {
    switch (request.kind) {
      case 'generate': {
        const code = crypto.randomUUID()
        void link(
          'generate',
          () => setupSync(code),
          'Sync code created. Join it on your other device.',
        )
        return
      }
      case 'join':
        void link(
          'join',
          () => setupSync(request.code, { join: true }),
          'Joined. This device is synced.',
        )
        return
      case 'reconnect':
        void link(
          'reconnect',
          // Not established when it left (a join that never found its copy): a join again.
          () => setupSync(request.code, { join: !request.established }),
          'Reconnected. This device is synced.',
          (result) => {
            // The code is this device's again (saved with the setup): the slot is spent.
            if (result.ok || result.error !== 'off') forgetPrevious()
          },
        )
    }
  }

  /** Sets up now, or first asks about the demo's sample rows while they are here. */
  const setUp = (request: SetupRequest) => {
    if (useExpenseStore.getState().demo !== 'sample') {
      run(request)
      return
    }
    // The question takes the pressed control's place: a double tap's second tap must not
    // answer it.
    shieldGesture()
    setAskDemo(request)
  }

  const answerDemo = (remove: boolean) => {
    const request = askDemo
    if (request === null) return
    setAskDemo(null)
    // The question's place goes back to the control that asked it until the linked view mounts.
    focusNext.current = request.kind === 'reconnect' ? 'reconnect' : 'generate'
    if (remove) {
      try {
        useExpenseStore.getState().clearSampleData()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't remove the sample data.")
        return
      }
    }
    run(request)
  }

  const backOutOfDemo = () => {
    if (askDemo === null) return
    focusNext.current = askDemo.kind === 'reconnect' ? 'reconnect' : 'generate'
    setAskDemo(null)
  }

  const handleManualSync = () => {
    // aria-disabled, not disabled, while it runs: the button keeps keyboard focus.
    if (manualSyncing) return
    // A result that puts a new banner up is said by the banner (its live region announces it); a
    // toast would say the same sentence a second time. A result the banners already showed
    // changes nothing there, so the toast is what tells the owner the tap was answered.
    const before = useSyncStore.getState()
    const shownBefore = {
      failure: failureBanner(before.lastError),
      waiting: before.waitingForOld > 0,
    }
    void runRequest(
      setManualSyncing,
      () => triggerSync({ resetBackoff: true }),
      (result) => {
        if (!result.ok) {
          if (!bannerNowSays(shownBefore.failure)) reportFailure(result)
        } else if (heldBack()) {
          if (shownBefore.waiting) toast.info(OLD_DEVICE_WAITING)
        } else toast.success('Synced')
      },
    )
  }

  /** Stops syncing here. A plain code is remembered for 30 days for a one-tap Reconnect. */
  const handleDisconnect = (code: string | null) => {
    if (code !== null) keepPrevious(code, Date.now())
    focusNext.current = readPrevious(Date.now()) === null ? 'generate' : 'reconnect'
    requestGen.current++
    setConnecting(null)
    setManualSyncing(false)
    disconnectSync()
    setConfirmDisconnect(false)
    toast.info('Sync disconnected')
  }

  const disconnect = (code: string | null, detail: string) =>
    // The shared confirmation: Cancel takes focus, Escape takes back the question (not
    // Settings), and neither a double tap on "Disconnect sync" nor a held Enter can answer it.
    // Cancel hands focus back to "Disconnect sync".
    confirmDisconnect ? (
      <InlineConfirm
        tone="warning"
        question="Disconnect sync on this device?"
        detail={detail}
        confirmLabel="Disconnect"
        onConfirm={() => {
          handleDisconnect(code)
        }}
        onCancel={() => {
          focusNext.current = 'disconnect'
          setConfirmDisconnect(false)
        }}
      />
    ) : (
      <Button
        ref={focusWhenShown('disconnect')}
        onClick={() => {
          // The question takes this button's place: a double tap's second tap must not
          // answer it.
          shieldGesture()
          setConfirmDisconnect(true)
        }}
        variant="ghost"
        className="w-full text-[var(--text-tertiary)] hover:text-white"
      >
        <Link2Off size={14} /> Disconnect sync
      </Button>
    )

  // A newer SpendTrack set sync up on this device: this build cannot read it, so it offers no
  // Generate or Join (either would overwrite it), only a reload or an explicit Disconnect.
  if (syncId === null && cloudStatus === 'paused') {
    return (
      <div className="flex flex-col gap-3">
        <SyncBanners flush />
        <div className="border-t border-white/[0.06] pt-3">
          {disconnect(
            null,
            'This device forgets the sync a newer SpendTrack set up here. Your data stays on this device and on your other devices.',
          )}
        </div>
        <AppVersion />
      </div>
    )
  }

  if (!syncId) {
    const prev = readPrevious(Date.now())
    // aria-disabled, not disabled, while another setup runs or Join asks: focus stays put.
    // Generate also waits while Reconnect asks about the sample data.
    const waiting = connecting !== null || joinActive
    const generateWaits = waiting || askDemo !== null
    const generateButton = (
      <Button
        ref={focusWhenShown('generate')}
        onClick={() => {
          if (generateWaits) return
          if (prev === null) {
            setUp({ kind: 'generate' })
            return
          }
          shieldGesture()
          setAskSeparate(true)
        }}
        variant={prev === null ? 'primary' : 'ghost'}
        aria-disabled={generateWaits}
        className={ARIA_DISABLED}
      >
        {connecting === 'generate' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Cloud size={14} />
        )}
        {connecting === 'generate' ? 'Setting up…' : 'Generate sync code for this device'}
      </Button>
    )
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-lg border border-accent/15 bg-accent/[0.04] p-4">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Cloud size={14} className="text-accent" aria-hidden />
            Link your devices
          </h3>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Generate a sync code here, then join it on your other device. There&apos;s no account:
            the code links them. The synced copy isn&apos;t encrypted yet, so anyone with this
            app&apos;s public key could read it.
          </p>
        </div>

        {prev !== null &&
          (askDemo?.kind === 'reconnect' ? (
            <DemoQuestion onAnswer={answerDemo} onBackOut={backOutOfDemo} />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Button
                ref={focusWhenShown('reconnect')}
                onClick={() => {
                  if (waiting) return
                  // "Reconnect instead" answers Generate's question about a separate sync.
                  setAskSeparate(false)
                  setUp({ kind: 'reconnect', code: prev.code, established: prev.established })
                }}
                aria-disabled={waiting}
                aria-label={`Reconnect to the code ending in ${spokenEnd(prev.code)}`}
                aria-describedby={reconnectHintId}
                className={ARIA_DISABLED}
              >
                {connecting === 'reconnect' ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Link2 size={14} aria-hidden />
                )}
                Reconnect to <span className="font-mono">{maskCode(prev.code)}</span>
              </Button>
              <p
                id={reconnectHintId}
                className="text-center text-[12px] text-[var(--text-tertiary)]"
              >
                This device remembers the code until {format(prev.until, 'd MMM')}.
              </p>
            </div>
          ))}

        {askDemo?.kind === 'generate' ? (
          <DemoQuestion onAnswer={answerDemo} onBackOut={backOutOfDemo} />
        ) : askSeparate ? (
          <InlineConfirm
            tone="warning"
            question="Start a separate sync?"
            detail="Your other devices stay on the old code. Reconnect instead to keep one sync."
            confirmLabel="Make a new code"
            onConfirm={() => {
              setAskSeparate(false)
              focusNext.current = 'generate'
              setUp({ kind: 'generate' })
            }}
            onCancel={() => {
              focusNext.current = 'generate'
              setAskSeparate(false)
            }}
          />
        ) : (
          generateButton
        )}

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/[0.06]" />
          <span className="text-[11px] text-[var(--text-tertiary)]">or join an existing one</span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>

        <JoinSync
          busy={connecting !== null || askSeparate || askDemo !== null}
          joining={connecting === 'join'}
          onJoin={(code) => {
            run({ kind: 'join', code })
          }}
          onActiveChange={setJoinActive}
        />

        <CodeSafety />
        <AppVersion />
      </div>
    )
  }

  const status = statusView({
    status: cloudStatus,
    lastSyncAt,
    pendingLocal,
    pending,
    lastError,
    waitingForOld,
    manual: manualSyncing,
    resumes,
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={clsx(
                  'h-2 w-2 shrink-0 rounded-full',
                  ROW_DOT[status.tone],
                  status.busy && 'animate-pulse',
                )}
              />
              <span
                id={statusId}
                className={clsx('text-[12px] font-medium', ROW_TEXT[status.tone])}
              >
                {status.label}
              </span>
            </div>
            <button
              ref={(element) => {
                focusWhenShown('sync-now')(element)
                // The pill that opened Settings asked for it.
                if (element && useUIStore.getState().takeSettingsFocus('sync-now')) element.focus()
              }}
              type="button"
              onClick={handleManualSync}
              aria-disabled={manualSyncing}
              aria-describedby={statusId}
              aria-label="Sync now"
              title="Sync now"
              className="tap-target inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-[var(--text-tertiary)] md:h-8 md:w-8"
            >
              <RefreshCw size={13} className={manualSyncing ? 'animate-spin' : ''} />
            </button>
          </div>
          <SyncBanners />
        </div>
        <SyncCode code={syncId} />
        <CodeSafety />
      </div>

      <SyncDevices />

      <div className="border-t border-white/[0.06] pt-3">
        {disconnect(
          syncId,
          'This device stops syncing. Your data stays on this device, on your other devices and in the relay.',
        )}
      </div>
      <AppVersion />
    </div>
  )
}

/** Who may see the code: said beside every place it can be copied or typed. */
function CodeSafety() {
  return (
    <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
      <ShieldCheck size={12} className="mt-0.5 shrink-0 text-positive/70" aria-hidden />
      <span>{CODE_SAFETY}</span>
    </p>
  )
}

/** Which SpendTrack this device runs: after an update, both devices should show the same. */
function AppVersion() {
  return (
    <p className="text-center text-[11px] text-[var(--text-tertiary)]">
      This device runs SpendTrack {__APP_VERSION__}
    </p>
  )
}
