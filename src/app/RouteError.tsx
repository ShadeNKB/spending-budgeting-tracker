import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom'
import { AlertTriangle, Download, RotateCw, WifiOff } from 'lucide-react'
import { Button } from '../ui/Button'
import { SpendLogo } from '../ui/SpendLogo'
import { STUCK_HINT, isChunkLoadError, openPage, reloadedRecently } from '../lib/chunkReload'
import { downloadRescueFile, type RescueOutcome } from '../lib/rescue'
import { getUpdateController, type UpdateController } from './swUpdate'
import { SAFE_GUTTER_X } from './safeArea'

// Recovery UI for render errors. It must work when the app's own state is what broke, so it
// reads no store: Reload, Go to Pulse and the raw "Download my data" need nothing but the
// router, the service-worker update controller and localStorage.
//
// Reload goes through the update controller: a new build that is already downloaded and
// waiting is installed first, so a crash that the new build fixes does not come straight back.

type Scope = 'app' | 'screen'

const STALE = {
  title: 'SpendTrack was just updated',
  body: "Part of the app couldn't load. This usually happens right after an update or when you're offline. Reloading fixes it.",
}
// A part that was never saved for offline use. Reloading offline would open the browser's
// offline page, a dead end in an installed app.
const OFFLINE = {
  title: "You're offline",
  body: "This part of SpendTrack isn't saved on this device yet. Reconnect, then reload. Your expenses are safe on this device.",
}
const CRASH = {
  title: 'Something went wrong',
  body: (scope: Scope) =>
    `${scope === 'app' ? 'SpendTrack' : 'This screen'} ran into a problem and couldn't be shown. Your expenses are still saved on this device. ${STUCK_HINT}`,
}
const UPDATE_WAITING = 'A new version of SpendTrack is ready. Reload installs it.'
const RESCUE_CAPTION = 'Saves a copy of everything stored in this browser, exactly as it is.'

function rescueMessage(outcome: RescueOutcome): string {
  switch (outcome.kind) {
    case 'downloaded':
      // The page cannot see whether the browser saved the file (iOS asks first), so it points
      // the user at it rather than claiming it is there.
      return `Saving ${outcome.filename}… Check your Downloads.`
    case 'empty':
      return 'Nothing is saved in this browser yet.'
    case 'unavailable':
      return 'This browser blocked access to saved data.'
    case 'failed':
      return "The download couldn't start. Try again, or reload first."
  }
}

function describeError(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  return 'Unknown error'
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** False only while the browser knows it is offline. */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine)
}

function useRescueDownload() {
  const [status, setStatus] = useState('')
  const download = () => {
    setStatus(rescueMessage(downloadRescueFile()))
  }
  return { status, download }
}

function ErrorCard({
  scope,
  error,
  controller,
}: {
  scope: Scope
  error: unknown
  controller: UpdateController
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const captionId = useId()
  const { status, download } = useRescueDownload()
  const online = useOnline()
  const update = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

  // Announce the problem and give keyboard users a starting point.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const stale = isChunkLoadError(error)
  const offline = stale && !online
  const title = offline ? OFFLINE.title : stale ? STALE.title : CRASH.title
  const body = offline
    ? OFFLINE.body
    : stale
      ? reloadedRecently()
        ? `${STALE.body} ${STUCK_HINT}`
        : STALE.body
      : CRASH.body(scope)
  const onPulse = pathname === '/' || pathname === '/pulse'
  const Heading = scope === 'app' ? 'h1' : 'h2'
  const Icon = offline ? WifiOff : stale ? RotateCw : AlertTriangle
  // Inside the shell the update banner says this; after a shell crash nothing else can.
  const updateWaiting = scope === 'app' && (update === 'ready' || update === 'updated-elsewhere')

  const reload = () => {
    controller.reloadToLatest()
  }
  const goToPulse = () => {
    // Inside the shell the router can recover; after a shell crash a fresh document is safer.
    if (scope === 'screen') void navigate('/pulse')
    else
      controller.reloadToLatest(() => {
        openPage('/pulse')
      })
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-5 md:p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
        <Icon size={18} aria-hidden />
      </div>
      <Heading
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-[19px] font-semibold tracking-tight text-white focus:outline-none"
      >
        {title}
      </Heading>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      {scope === 'app' && (
        <div role="status">
          {updateWaiting && (
            <p className="mt-3 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-[13px] leading-snug text-[var(--text-primary)]">
              {UPDATE_WAITING}
            </p>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <Button size="lg" className="w-full md:w-auto" onClick={reload}>
          <RotateCw size={16} aria-hidden />
          Reload
        </Button>
        {!onPulse && (
          <Button variant="ghost" size="lg" className="w-full md:w-auto" onClick={goToPulse}>
            Go to Pulse
          </Button>
        )}
        <Button
          variant="ghost"
          size="lg"
          className="w-full md:w-auto"
          aria-describedby={captionId}
          onClick={download}
        >
          <Download size={16} aria-hidden />
          Download my data
        </Button>
      </div>
      <p id={captionId} className="mt-2.5 text-[12px] text-[var(--text-tertiary)]">
        {RESCUE_CAPTION}
      </p>
      <p aria-live="polite" className="mt-1 min-h-[18px] text-[12px] text-[var(--text-secondary)]">
        {status}
      </p>

      <details className="mt-4 border-t border-white/[0.06] md:pt-3">
        {/* 44 px tall on phones (padding, so the disclosure marker stays), compact on desktop. */}
        <summary className="cursor-pointer select-none py-3.5 text-[12px] text-[var(--text-tertiary)] transition hover:text-white md:py-0">
          Technical details
        </summary>
        <code className="mt-2 block whitespace-pre-wrap break-words font-mono text-[12px] text-[var(--text-secondary)]">
          {describeError(error)}
        </code>
      </details>
    </div>
  )
}

/**
 * Router errorElement. `screen` renders inside the app shell (TopBar, TabBar and the
 * overlays stay usable, and React Router clears it on the next navigation); `app` replaces
 * the whole page when the shell itself fails.
 */
export function RouteError({
  scope,
  controller = getUpdateController(),
}: {
  scope: Scope
  controller?: UpdateController
}) {
  const error = useRouteError()

  if (scope === 'screen') {
    return (
      <section className="mx-auto w-full max-w-[560px] py-4 md:py-8">
        <ErrorCard scope="screen" error={error} controller={controller} />
      </section>
    )
  }

  return (
    <main
      className={`flex min-h-dvh items-center justify-center bg-surface-0 pb-[calc(env(safe-area-inset-bottom,0px)+24px)] pt-[calc(env(safe-area-inset-top,0px)+24px)] text-[var(--text-primary)] ${SAFE_GUTTER_X}`}
    >
      <div className="w-full max-w-[560px]">
        <div className="mb-5 flex items-center gap-2">
          <SpendLogo size={28} />
          <span className="text-[15px] font-semibold tracking-tight text-white">SpendTrack</span>
        </div>
        <ErrorCard scope="app" error={error} controller={controller} />
      </div>
    </main>
  )
}

/** Fallback for a single overlay (Settings, palette, add sheet, shortcuts) that failed. */
export function OverlayError({
  error,
  onClose,
  controller = getUpdateController(),
}: {
  error: unknown
  onClose: () => void
  controller?: UpdateController
}) {
  const titleId = useId()
  const reloadRef = useRef<HTMLButtonElement>(null)
  const { status, download } = useRescueDownload()
  const online = useOnline()
  const message = !isChunkLoadError(error)
    ? "This panel couldn't open."
    : online
      ? "This panel couldn't open because a new version was just released."
      : "This panel isn't saved on this device yet. Reconnect, then reload."

  // The card stands in for the panel the user just opened, so it takes focus the way the panel
  // would have (keyboard users would otherwise tab through the whole page to reach it), closes
  // on Escape, and hands focus back to whatever opened it.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  )
  const close = useCallback(() => {
    onClose()
    if (opener?.isConnected) opener.focus()
  }, [onClose, opener])

  useEffect(() => {
    reloadRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close])

  return (
    // Above the toast layer (z-[100]), which shares this anchor over the tab bar.
    <section
      aria-labelledby={titleId}
      className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] z-[101] mx-auto max-w-[420px] rounded-2xl border border-white/[0.06] bg-surface-1 p-4 shadow-[var(--shadow-overlay)] md:inset-x-auto md:bottom-6 md:right-6 md:w-[380px]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <AlertTriangle size={16} aria-hidden />
        </div>
        <p id={titleId} role="alert" className="min-w-0 flex-1 pt-1.5 text-[15px] text-white">
          {message}
        </p>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          ref={reloadRef}
          size={null}
          className="h-11 flex-1 px-4 text-sm md:h-9"
          onClick={() => {
            controller.reloadToLatest()
          }}
        >
          <RotateCw size={15} aria-hidden />
          Reload
        </Button>
        <Button
          variant="ghost"
          size={null}
          className="h-11 flex-1 px-4 text-sm md:h-9"
          onClick={close}
        >
          Close
        </Button>
      </div>
      <Button
        variant="subtle"
        size={null}
        className="mt-1 h-11 w-full px-3 text-[13px] md:h-8"
        onClick={download}
      >
        <Download size={14} aria-hidden />
        Download my data
      </Button>
      <p
        aria-live="polite"
        className="min-h-[18px] text-center text-[12px] text-[var(--text-secondary)]"
      >
        {status}
      </p>
    </section>
  )
}
