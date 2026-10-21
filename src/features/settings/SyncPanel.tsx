import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
  OLD_DEVICE_WAITING,
  failureSeverity,
  syncMessage,
  useSyncStore,
  type CloudStatus,
  type SyncFailure,
  type SyncResult,
} from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'
import { syncEnabled } from '../../services/syncConfig'
import { useToast } from '../../hooks/useToast'
import clsx from 'clsx'

const LEGACY_BANNER_MS = 24 * 60 * 60_000

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
}

type Tone = 'muted' | 'accent' | 'positive' | 'info' | 'warning' | 'negative'

/** The row colour of a failure: the same meaning as on the pill and in the toasts. */
const failureTone = (kind: SyncFailure['kind']): Extract<Tone, 'warning' | 'negative'> =>
  failureSeverity(kind) === 'warning' ? 'warning' : 'negative'

const ROW_TEXT: Record<Tone, string> = {
  muted: 'text-[var(--text-tertiary)]',
  accent: 'text-accent',
  positive: 'text-positive',
  info: 'text-[var(--text-secondary)]',
  warning: 'text-warning',
  negative: 'text-negative',
}

const ROW_DOT: Record<Tone, string> = {
  muted: 'bg-white/20',
  accent: 'bg-accent',
  positive: 'bg-positive',
  info: 'bg-accent/50',
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
  if (s.status === 'off' || s.status === 'idle') {
    return { label: 'Ready', tone: 'muted', busy: false }
  }
  if (s.status === 'offline') return { label: ERROR_LABEL.offline, tone: 'warning', busy: false }
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
    return { label: ERROR_LABEL[failure.kind], tone: failureTone(failure.kind), busy }
  }
  if (busy && (s.pendingLocal || s.lastSyncAt === null)) {
    return { label: 'Syncing…', tone: 'accent', busy }
  }
  if (s.pendingLocal) return { label: 'Saved here · syncing soon', tone: 'accent', busy }
  // The relay holds the old device's copy, not this one: saved, but not "Synced".
  if (s.waitingForOld) {
    return { label: 'Saved here · other device needs update', tone: 'info', busy }
  }
  const ago = s.lastSyncAt === null ? '' : ` · ${timeAgo(s.lastSyncAt)}`
  return { label: `Synced${ago}`, tone: 'positive', busy }
}

type BannerTone = 'error' | 'warning' | 'info'

/** Controls that take focus after a view swap (see `focusNext`). */
type FocusTarget = 'sync-now' | 'generate' | 'cancel' | 'disconnect'

const BANNER_TONE: Record<BannerTone, string> = {
  error: 'border-negative/20 bg-negative/10 text-negative',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  info: 'border-accent/15 bg-accent/[0.04] text-[var(--text-secondary)]',
}

function SyncBanner({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: BannerTone
  icon: LucideIcon
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed',
        BANNER_TONE[tone],
      )}
    >
      <Icon size={12} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-40">{children}</span>
      {action}
    </div>
  )
}

const ACTION_TONE: Record<Exclude<BannerTone, 'info'>, string> = {
  error: 'border-negative/30 text-negative hover:bg-negative/10',
  warning: 'border-warning/30 text-warning hover:bg-warning/10',
}

function BannerAction({
  tone,
  icon: Icon,
  label,
  onClick,
}: {
  tone: Exclude<BannerTone, 'info'>
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition md:h-8',
        ACTION_TONE[tone],
      )}
    >
      <Icon size={12} aria-hidden="true" /> {label}
    </button>
  )
}

/**
 * What the owner must know about sync right now, worst first. One live region that is always
 * mounted (empty when all is well), so a banner that appears while the panel is open is
 * announced: screen readers read what is added to a region, not a region added with it.
 */
function SyncBanners() {
  const lastError = useSyncStore((s) => s.lastError)
  const legacyWriterAt = useSyncStore((s) => s.legacyWriterAt)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const fenced = lastError?.kind === 'moved' || lastError?.kind === 'update-required'
  const legacySeen = legacyWriterAt !== null && Date.now() - legacyWriterAt < LEGACY_BANNER_MS
  const failing = lastError !== null && lastError.kind !== 'offline' && !fenced

  return (
    // Empty, it takes no space; with a banner, the margin stands in for the card's gap.
    <div role="status" className="flex flex-col gap-2 [&:not(:empty)]:mt-3">
      {fenced && (
        <SyncBanner
          tone="warning"
          icon={AlertCircle}
          action={
            <BannerAction
              tone="warning"
              icon={RefreshCw}
              label="Reload"
              onClick={() => window.location.reload()}
            />
          }
        >
          {syncMessage('moved')}
        </SyncBanner>
      )}
      {failing && (
        <SyncBanner
          tone="error"
          icon={AlertCircle}
          action={
            // The message says to export a backup: one tap to the place that does it.
            lastError.kind === 'too-large' ? (
              <BannerAction
                tone="error"
                icon={Download}
                label="Export backup"
                onClick={() => setSettingsTab('backup')}
              />
            ) : undefined
          }
        >
          {lastError.message}
        </SyncBanner>
      )}
      {(legacySeen || waitingForOld) && (
        <SyncBanner tone="info" icon={Info}>
          {legacySeen &&
            'Another device runs an older SpendTrack (0.8.4 or earlier). Open it and reload.'}
          {legacySeen && waitingForOld && ' '}
          {waitingForOld && OLD_DEVICE_WAITING}
        </SyncBanner>
      )}
    </div>
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

  /** A failed result in its own colour; 'off' means sync was switched off meanwhile: no toast. */
  const reportFailure = (result: SyncResult, prefix = '') => {
    if (result.ok || result.error === 'off') return
    const message = `${prefix}${result.message}`
    if (failureTone(result.error) === 'warning') toast.warning(message)
    else toast.error(message)
  }

  const handleGenerate = async () => {
    focusNext.current = 'sync-now'
    await runRequest(
      setConnecting,
      () => setupSync(crypto.randomUUID()),
      (result) => {
        if (result.ok) toast.success('Sync code generated — enter it on your other device')
        else reportFailure(result, "Sync code created, but the first sync didn't finish: ")
      },
    )
    dropFocusRequest('sync-now')
  }

  const handleConnect = async () => {
    const trimmed = codeInput.trim().toLowerCase()
    if (!trimmed) return
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (!uuidRegex.test(trimmed)) {
      toast.error('Invalid sync code — paste the full code from your other device')
      return
    }
    // The code is saved either way; a failed first sync keeps retrying in the background.
    focusNext.current = 'sync-now'
    await runRequest(
      setConnecting,
      () => setupSync(trimmed),
      (result) => {
        if (result.ok) toast.success('Connected — data synced')
        else reportFailure(result, "Connected, but couldn't sync yet: ")
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
    void runRequest(
      setManualSyncing,
      () => triggerSync({ resetBackoff: true }),
      (result) => {
        if (!result.ok) reportFailure(result)
        // Held back for an old device: saved here, but the relay does not hold this copy.
        else if (useSyncStore.getState().waitingForOld) toast.info(OLD_DEVICE_WAITING)
        else toast.success('Synced')
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
          disabled={connecting}
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
                if (e.key === 'Enter') void handleConnect()
              }}
              className="min-w-0"
            />
          </div>
          <Button
            onClick={handleConnect}
            disabled={!codeInput.trim() || connecting}
            className="mt-0 shrink-0 self-end"
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

      {!lastSyncAt && (
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
