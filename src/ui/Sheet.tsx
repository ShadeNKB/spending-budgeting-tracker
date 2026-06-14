import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function Sheet({
  open,
  onClose,
  children,
  title,
  side = 'right',
  width = 420,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
  side?: 'right' | 'bottom'
  width?: number
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus({ preventScroll: true })
    }, 0)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)

      if (focusable.length === 0) {
        e.preventDefault()
        panelRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
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
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [open, onClose])

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
            className={
              'fixed z-[97] flex flex-col overflow-hidden border-white/[0.07] bg-surface-1 shadow-[var(--shadow-overlay)] ' +
              (isBottom
                ? 'bottom-0 left-0 right-0 max-h-[85dvh] rounded-t-2xl border-t'
                : 'bottom-0 right-0 top-0 border-l')
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
