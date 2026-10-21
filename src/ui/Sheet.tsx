import { AnimatePresence, motion } from 'framer-motion'
import { useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function Sheet({
  open,
  onClose,
  children,
  title,
  side = 'right',
  width = 420,
  initialFocus = 'close',
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
  side?: 'right' | 'bottom'
  width?: number
  /**
   * Where focus goes as the sheet opens. 'close' (default) focuses the Close button, so a sheet
   * never pops the keyboard up uninvited. 'content' keeps focus on a field inside that took it
   * as it mounted (autoFocus), so typing can start at once; without one it falls back to Close.
   */
  initialFocus?: 'close' | 'content'
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  // Parents pass a fresh onClose on every render. Reading it through a ref keeps the effect
  // below tied to `open` alone: re-running it on a parent re-render (the app going idle, a
  // toast) used to pull focus out of the field being typed in and onto Close.
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  // A layout effect, so focus is settled before the sheet is first painted: a sheet that mounts
  // already open (lazy, on its first tap) runs its plain effects only after it is on screen,
  // and a later focus move could land in the middle of the first keystrokes.
  useLayoutEffect(() => {
    if (!open) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // React has already run the content's autoFocus: children commit before this effect.
    const contentHasFocus =
      initialFocus === 'content' && panelRef.current?.contains(document.activeElement) === true
    if (!contentHasFocus) closeButtonRef.current?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }

      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        e.preventDefault()
        panelRef.current.focus()
        return
      }

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [open, initialFocus])

  const isBottom = side === 'bottom'

  // Portal to document.body so backdrop-filter ancestors (e.g. TopBar's
  // backdrop-blur) don't create a new containing block for position:fixed.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-[96] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            ref={panelRef}
            key="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title !== undefined ? titleId : undefined}
            aria-label={title === undefined ? 'Sheet' : undefined}
            tabIndex={-1}
            // Safe-area padding: an installed iPhone app in landscape draws under the side
            // notches, and an iPad app under the status bar (viewport-fit=cover). The content
            // keeps its own padding inside it.
            className={
              'fixed z-[97] flex flex-col overflow-hidden border-white/[0.07] bg-surface-1 shadow-[var(--shadow-overlay)] ' +
              (isBottom
                ? 'bottom-0 left-0 right-0 max-h-[85dvh] rounded-t-2xl border-t pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]'
                : 'bottom-0 right-0 top-0 border-l pr-[env(safe-area-inset-right,0px)] pt-[env(safe-area-inset-top,0px)]')
            }
            style={!isBottom ? { width: `min(${width}px, 96vw)` } : undefined}
            initial={isBottom ? { y: '100%' } : { x: '100%' }}
            animate={isBottom ? { y: 0 } : { x: 0 }}
            exit={isBottom ? { y: '100%' } : { x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 40 }}
          >
            {isBottom && (
              <div className="flex shrink-0 justify-center pb-1 pt-3">
                <div className="h-1 w-10 rounded-full bg-white/20" />
              </div>
            )}
            {title !== undefined && (
              <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
                <h2 id={titleId} className="text-[15px] font-semibold text-white">
                  {title}
                </h2>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </header>
            )}
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]">
              {children}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
