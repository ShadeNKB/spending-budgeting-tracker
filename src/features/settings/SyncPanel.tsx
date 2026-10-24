import { useEffect, useId, useRef, useState } from 'react'
import {
  Cloud,
  CloudOff,
  Copy,
  Check,
  Link2,
  Link2Off,
  RefreshCw,
  AlertCircle,
  Loader2,
  Smartphone,
  Monitor,
  ShieldCheck,
  Info,
  Download,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import {
  FAILING_AFTER_MS,
  OLD_DEVICE_WAITING,
  failingSinceMessage,
  failureSeverity,
  isFailing,
  needsReload,
  pausedDetail,
  reloadSpendTrack,
  syncMessage,
  syncsWhenOnline,
  useSyncStore,
  type CloudStatus,
  type SyncFailure,
  type SyncResult,
} from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'
import { syncEnabled } from '../../services/syncConfig'
import { useTick } from '../../hooks/useTick'
import { useToast } from '../../hooks/useToast'
import clsx from 'clsx'

const LEGACY_BANNER_MS = 24 * 60 * 60_000

// The code generated on this device in this session: the "Link your phone" steps are for it,
// not for a device that joined a code or reloaded.
let generatedCode: string | null = null

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

// Short status-row labels; the banner under the row carries the full sentence.
const ERROR_LABEL: Record<SyncFailure['kind'], string> = {
  network: "Can't reach the sync server",
  server: 'Sync server error',
  permission: 'Sync server refused access',
  // Never a red label that starts with "Synced".
  invalid: "Couldn't read the synced copy",
  offline: "Offline — will sync when you're back",
  'too-large': 'Sync paused',
  moved: 'Sync paused',
  'update-required': 'Sync paused',
  reload: 'Sync paused',
}

type Tone = 'muted' | 'accent' | 'positive' | 'info' | 'warning' | 'negative'

/** The row colour of a failure: the same meaning as on the pill and in the toasts. */
const failureTone = (failure: SyncFailure): Extract<Tone, 'warning' | 'negative'> =>
  failureSeverity(failure) === 'warning' ? 'warning' : 'negative'

/**
 * A failure in the banner's words. The status row above it already says "Sync paused", and
 * once a retried failure has lasted 10 minutes the banner says since when.
 */
const bannerText = (failure: SyncFailure): string =>
  isFailing(failure) ? failingSinceMessage(failure.since) : pausedDetail(failure.message)

const isFence = (failure: SyncFailure | null): boolean =>
  failure?.kind === 'moved' || failure?.kind === 'update-required'

/** What the banners say about a failure (offline has no banner: the status row says it). */
function failureBanner(failure: SyncFailure | null): string | null {
  if (!failure || failure.kind === 'offline') return null
  return isFence(failure) ? syncMessage('moved') : bannerText(failure)
}

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
  lastError: SyncFailure | null
  waitingForOld: boolean
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
    return {
      label: s.resumes ? ERROR_LABEL.offline : 'Offline · not synced',
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
    return { label: ERROR_LABEL[failure.kind], tone: failureTone(failure), busy }
  }
  // The relay holds the old device's copy, not this one: saved, but not "Synced". Before
  // pending, which a held-back push leaves set: nothing is due until something changes here.
  if (s.waitingForOld) {
    return { label: 'Saved here · other device needs update', tone: 'info', busy }
  }
  if (busy && (s.pendingLocal || s.lastSyncAt === null)) {
    return { label: 'Syncing…', tone: 'accent', busy }
  }
  if (s.pendingLocal) return { label: 'Saved here · syncing soon', tone: 'accent', busy }
  const ago = s.lastSyncAt === null ? '' : ` · ${timeAgo(s.lastSyncAt)}`
  return { label: `Synced${ago}`, tone: 'positive', busy }
}

type BannerTone = 'error' | 'warning' | 'info'

/** A busy button that keeps keyboard focus: it looks and acts disabled, but is not `disabled`. */
const ARIA_DISABLED = 'aria-disabled:pointer-events-none aria-disabled:opacity-40'

type SetupLead = 'generated' | 'connected'

/**
 * A failed first sync after Generate or Connect, led by what did happen: the code was created
 * or saved, never "connected" (the relay may have refused it). A pause promises no sync "yet":
 * it lasts until the owner acts, and so does refused access. When a banner now says why
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
type FocusTarget = 'sync-now' | 'generate' | 'cancel' | 'disconnect'

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
  key: 'reload' | 'failing' | 'old-device'
  tone: BannerTone
  icon: LucideIcon
  text: string
  action?: { icon: LucideIcon; label: string; onClick: () => void }
}

/** What the old-device banner says: one sentence when both apply. */
function oldDeviceText(seen: boolean, waiting: boolean): string | null {
  if (seen && waiting) {
    return 'An older SpendTrack (0.8.4 or earlier) on your other device keeps overwriting the synced copy. Open it and reload; everything is saved here.'
  }
  if (seen) return 'Another device runs an older SpendTrack (0.8.4 or earlier). Open it and reload.'
  return waiting ? OLD_DEVICE_WAITING : null
}

/** What the owner must know about sync right now, worst first. */
function useBanners(): BannerView[] {
  const lastError = useSyncStore((s) => s.lastError)
  const legacyWriterAt = useSyncStore((s) => s.legacyWriterAt)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const focusSettings = useUIStore((s) => s.focusSettings)
  const banners: BannerView[] = []
  if (lastError && needsReload(lastError.kind)) {
    banners.push({
      key: 'reload',
      tone: 'warning',
      icon: AlertCircle,
      text: failureBanner(lastError) ?? '',
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
  const legacySeen = legacyWriterAt !== null && Date.now() - legacyWriterAt < LEGACY_BANNER_MS
  const old = oldDeviceText(legacySeen, waitingForOld)
  if (old !== null) banners.push({ key: 'old-device', tone: 'info', icon: Info, text: old })
  return banners
}

/**
 * The banners, and one live region that is always mounted (empty when all is well), so a
 * banner that appears while the panel is open is announced: screen readers read what is added
 * to a region, not a region added with it. The region holds the sentences only, as the pill's
 * does: a button inside it would be read as part of the sentence ("…to update. Reload"). The
 * banner shows the same words to the eye, and its button is described by them.
 */
function SyncBanners() {
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
      <div className="flex flex-col gap-2 [&:not(:empty)]:mt-3">
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
                  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition md:h-8',
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

function SyncContent() {
  const syncId = useSyncStore((s) => s.syncId)
  const cloudStatus = useSyncStore((s) => s.cloudStatus)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const lastError = useSyncStore((s) => s.lastError)
  const pendingLocal = useSyncStore((s) => s.pendingLocal)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const resumes = useSyncStore(syncsWhenOnline)
  const setupSync = useSyncStore((s) => s.setupSync)
  const disconnectSync = useSyncStore((s) => s.disconnectSync)
  const triggerSync = useSyncStore((s) => s.triggerSync)
  const toast = useToast()

  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [manualSyncing, setManualSyncing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Each request this panel starts takes a number, and Disconnect moves past it: a request
  // still on the wire then (a hung first sync) keeps no button busy and reports nothing.
  const requestGen = useRef(0)
  // A press that swaps the view unmounts the pressed control. Its successor takes focus when
  // it mounts, so keyboard and screen-reader focus stays in the panel, never on <body>.
  const focusNext = useRef<FocusTarget | null>(null)
  const statusId = useId()
  useFailingTurn(lastError)
  // "Synced · 2m ago" ages while the panel stays open, as on the pill.
  useTick(15_000)

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

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    },
    [],
  )

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
  const heldBack = () => useSyncStore.getState().waitingForOld

  const handleGenerate = async () => {
    // aria-disabled, not disabled, while setting up: the button keeps keyboard focus.
    if (connecting) return
    focusNext.current = 'sync-now'
    const code = crypto.randomUUID()
    generatedCode = code
    const before = failureBanner(useSyncStore.getState().lastError)
    await runRequest(
      setConnecting,
      () => setupSync(code),
      (result) => {
        if (!result.ok)
          reportFailure(result, setupFailure('generated', result, bannerNowSays(before)))
        else if (heldBack()) toast.info(OLD_DEVICE_WAITING)
        else toast.success('Sync code generated — enter it on your other device')
      },
    )
    dropFocusRequest('sync-now')
  }

  const handleConnect = async () => {
    const trimmed = codeInput.trim().toLowerCase()
    if (!trimmed || connecting) return
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (!uuidRegex.test(trimmed)) {
      toast.error('Invalid sync code — paste the full code from your other device')
      return
    }
    // The code is saved either way; a failed first sync keeps retrying in the background.
    focusNext.current = 'sync-now'
    const before = failureBanner(useSyncStore.getState().lastError)
    await runRequest(
      setConnecting,
      () => setupSync(trimmed),
      (result) => {
        if (!result.ok)
          reportFailure(result, setupFailure('connected', result, bannerNowSays(before)))
        else if (heldBack()) toast.info(OLD_DEVICE_WAITING)
        else toast.success('Connected — data synced')
      },
    )
    dropFocusRequest('sync-now')
    setCodeInput('')
  }

  const handleCopy = async () => {
    if (!syncId) return
    try {
      await navigator.clipboard.writeText(syncId)
    } catch {
      // Clipboard access is denied or unavailable (insecure context) — the code stays selectable.
      toast.error('Could not copy — select the code and copy it manually')
      return
    }
    setCopied(true)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => {
      setCopied(false)
      copyResetTimer.current = null
    }, 2000)
  }

  const handleManualSync = () => {
    // aria-disabled, not disabled, while it runs: the button keeps keyboard focus.
    if (manualSyncing) return
    // A result that puts a new banner up is said by the banner (its live region announces it); a
    // toast would say the same sentence a second time. A result the banners already showed
    // changes nothing there, so the toast is what tells the owner the tap was answered.
    const before = useSyncStore.getState()
    const shownBefore = { failure: failureBanner(before.lastError), waiting: before.waitingForOld }
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

  const handleDisconnect = () => {
    focusNext.current = 'generate'
    requestGen.current++
    setConnecting(false)
    setManualSyncing(false)
    disconnectSync()
    setConfirmDisconnect(false)
    toast.info('Sync disconnected')
  }

  const status = statusView({
    status: cloudStatus,
    lastSyncAt,
    pendingLocal,
    lastError,
    waitingForOld,
    manual: manualSyncing,
    resumes,
  })

  if (!syncId) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-lg border border-accent/15 bg-accent/[0.04] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Cloud size={14} className="text-accent" />
            Link your devices
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Generate a sync code on one device, then paste it on every other device you want to keep
            in sync. There are no accounts and no passwords — the code itself is the shared secret.
          </p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-surface-1 p-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                1
              </span>
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-white">On this device</div>
                <div className="text-[10px] leading-snug text-[var(--text-tertiary)]">
                  Generate a sync code
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-surface-1 p-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                2
              </span>
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-white">On other devices</div>
                <div className="text-[10px] leading-snug text-[var(--text-tertiary)]">
                  Settings → Sync → paste it
                </div>
              </div>
            </div>
          </div>
        </div>

        <Button
          ref={focusWhenShown('generate')}
          onClick={handleGenerate}
          variant="primary"
          aria-disabled={connecting}
          className={ARIA_DISABLED}
        >
          {connecting ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
          {connecting ? 'Setting up…' : 'Generate sync code for this device'}
        </Button>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/[0.06]" />
          <span className="text-[11px] text-[var(--text-tertiary)]">or join an existing one</span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>

        <div className="flex gap-2">
          {/* min-w-0 lets the field shrink, so Connect stays on screen at 320 px. */}
          <div className="min-w-0 flex-1">
            <Input
              label=""
              placeholder="Paste sync code from another device"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                // Without this, the Enter's own activation (keypress) lands on Sync now, which
                // the connected view focuses as it mounts, and runs a second cycle.
                e.preventDefault()
                void handleConnect()
              }}
              className="min-w-0"
            />
          </div>
          <Button
            onClick={handleConnect}
            disabled={!codeInput.trim()}
            aria-disabled={connecting}
            className={clsx('mt-0 shrink-0 self-end', ARIA_DISABLED)}
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
            Connect
          </Button>
        </div>

        <div className="flex items-start gap-2 pt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          <ShieldCheck size={12} className="mt-0.5 shrink-0 text-positive/70" />
          <span>
            Treat the sync code like a password. Anyone with it can read &amp; write your synced
            data. Don&apos;t share it in chats or screenshots.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
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
              ref={focusWhenShown('sync-now')}
              type="button"
              onClick={handleManualSync}
              aria-disabled={manualSyncing}
              aria-describedby={statusId}
              aria-label="Sync now"
              title="Sync now"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-[var(--text-tertiary)] md:h-8 md:w-8"
            >
              <RefreshCw size={13} className={manualSyncing ? 'animate-spin' : ''} />
            </button>
          </div>
          <SyncBanners />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-tertiary)]">Your sync code</span>
            <button
              type="button"
              onClick={handleCopy}
              className="-mr-2 inline-flex min-h-11 items-center gap-1 px-2 text-[11px] text-accent/80 transition hover:text-accent md:mr-0 md:min-h-0 md:px-0"
            >
              {copied ? (
                <>
                  <Check size={11} /> Copied
                </>
              ) : (
                <>
                  <Copy size={11} /> Copy
                </>
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex min-h-11 items-center gap-2 rounded-md border border-white/[0.06] bg-surface-2 px-3 py-2 text-left transition hover:border-accent/30 md:min-h-0"
            title="Tap to copy"
          >
            <span className="flex-1 select-all truncate font-mono text-[11px] text-white/80">
              {syncId}
            </span>
          </button>
        </div>
      </div>

      {syncId === generatedCode && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-accent/15 bg-accent/[0.04] p-3.5">
          <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white">
            <Smartphone size={12} className="text-accent" /> Link your phone in 3 steps
          </div>
          <ol className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                1
              </span>{' '}
              Open{' '}
              <span className="font-mono text-white/80">
                {typeof window !== 'undefined' ? window.location.host : 'this site'}
              </span>{' '}
              on your phone browser.
            </li>
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                2
              </span>{' '}
              Go to Settings → <strong className="text-white/90">Sync</strong>.
            </li>
            <li className="flex gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
                3
              </span>{' '}
              Paste the code above into <strong className="text-white/90">Connect</strong>.
            </li>
          </ol>
          <div className="mt-1 inline-flex items-center gap-1.5 border-t border-white/[0.04] pt-1 text-[10px] text-[var(--text-tertiary)]">
            <Monitor size={10} /> Same flow on any other laptop, tablet, or browser profile.
          </div>
        </div>
      )}

      <div className="border-t border-white/[0.06] pt-3">
        {confirmDisconnect ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/[0.07] p-3">
            <p className="text-[12px] text-[var(--text-tertiary)]">
              This device stops syncing. Your data stays on this device, on your other devices and
              in the relay.
            </p>
            <div className="flex gap-2">
              {/* No fill: on the amber-tinted card one drops amber text under AA in light. */}
              <Button
                onClick={handleDisconnect}
                variant="primary"
                className="flex-1 border border-warning/30 !bg-transparent !text-warning hover:!bg-warning/5"
              >
                Disconnect
              </Button>
              <Button
                ref={focusWhenShown('cancel')}
                onClick={() => {
                  focusNext.current = 'disconnect'
                  setConfirmDisconnect(false)
                }}
                variant="ghost"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            ref={focusWhenShown('disconnect')}
            onClick={() => {
              focusNext.current = 'cancel'
              setConfirmDisconnect(true)
            }}
            variant="ghost"
            className="w-full text-[var(--text-tertiary)] hover:text-white"
          >
            <Link2Off size={14} /> Disconnect sync
          </Button>
        )}
      </div>
    </div>
  )
}
