import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { OverlayError } from './RouteError'
import { useLatch } from '../hooks/useLatch'

interface Props {
  open: boolean
  /**
   * The app has loaded and gone idle: mount now, closed, so the first open is instant.
   * Left out, the overlay mounts on its first open only.
   */
  idle?: boolean
  /** The overlay's store setter. Without it a failure shows no card (the toast host). */
  setOpen?: (open: boolean) => void
  /**
   * Runs once each time the overlay fails while it has no card to show. The toast host uses
   * it to drop the toasts it could not show: their dismiss timers died with it, and while
   * they stay queued the boundary never resets, so every later toast would vanish too.
   */
  onFail?: () => void
  /**
   * For an overlay that reads its open flag from the store and settles its layout in a mount
   * effect (SettingsDrawer picks a side or a bottom sheet there). Opened before it has ever
   * mounted, it would slide in with the wrong layout, so it is mounted closed first and
   * opened right after.
   */
  mountClosed?: boolean
  loading?: ReactNode
  children: ReactNode
}

/**
 * One hidden overlay: mounted on its first open or once the app is idle, whichever comes
 * first (lazy() alone would still fetch it, and framer-motion, before first paint), behind its
 * own error boundary. A failure shows a small recovery card while the overlay is wanted and
 * nothing while it is closed: an idle-mounted overlay never surfaces an error nobody asked for.
 */
export function OverlaySlot({
  open,
  idle = false,
  setOpen,
  onFail,
  mountClosed = false,
  loading = null,
  children,
}: Props) {
  const mounted = useLatch(open || idle)
  const [committed, setCommitted] = useState(false)
  const [held, setHeld] = useState(false)
  // Opened before its first commit: keep the children out of this render (a chunk that has
  // just landed would render open, with the wrong layout) and hold the open...
  const holding = mountClosed && setOpen !== undefined && !committed && open

  useEffect(() => {
    if (!holding) return
    setHeld(true)
    setOpen(false)
  }, [holding, setOpen])

  // ...then release it one render after the closed mount, once the layout its mount effect
  // chose has rendered. Reopening in the same effect pass can render the store update first
  // (measured in Chromium: the sheet slid in sideways and stayed off-screen).
  useEffect(() => {
    if (!committed || !held || !setOpen) return
    setHeld(false)
    setOpen(true)
  }, [committed, held, setOpen])

  const markCommitted = useCallback(() => {
    setCommitted(true)
  }, [])

  if (!mounted) return null
  const wanted = open || held
  return (
    <ErrorBoundary
      resetKey={open}
      fallback={(error) =>
        wanted && setOpen ? (
          <OverlayError
            error={error}
            onClose={() => {
              setHeld(false)
              setOpen(false)
            }}
          />
        ) : onFail ? (
          <OnMount run={onFail} />
        ) : null
      }
    >
      <Suspense fallback={loading}>
        {!holding && (
          <>
            {children}
            {mountClosed && <AfterCommit onCommit={markCommitted} />}
          </>
        )}
      </Suspense>
    </ErrorBoundary>
  )
}

/** Runs `run` once after it mounts. */
function OnMount({ run }: { run: () => void }) {
  const [first] = useState(() => run)
  useEffect(() => {
    first()
  }, [first])
  return null
}

/** Its effect runs right after the overlay's own mount effects, in the same commit. */
function AfterCommit({ onCommit }: { onCommit: () => void }) {
  useEffect(onCommit, [onCommit])
  return null
}
