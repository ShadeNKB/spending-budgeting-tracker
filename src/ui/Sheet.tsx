import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { pressedWhileOnTop, useModalLayer } from './modalLayer'
import { LayerAnnouncer } from './LayerAnnouncer'

/**
 * A modal side or bottom sheet on the shared layer stack (modalLayer.ts).
 *
 * Focus starts on a field inside that takes it as it mounts (`autoFocus`), else on the dialog
 * itself, never on Close: a typed key or Enter must not land on Close. Escape (when this is the
 * top layer), Close and a backdrop tap call `onClose`; Tab stays inside; on close focus goes
 * back to what opened the sheet, else to `returnFocus()` (a ledger row deleted from the Edit
 * sheet), else to the screen heading. `onClose` may be a fresh function on every render.
 * Sheets, the palette and the date picker share one stacking level and portal to the end of
 * <body> as they open, so the one opened last is drawn on top.
 */
export function Sheet({
  open,
  onClose,
  children,
  title,
  side = 'right',
  width = 420,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
  side?: 'right' | 'bottom'
  width?: number
  /** Where focus goes on close when the element that opened the sheet is gone. */
  returnFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  // Reduced motion: the panel fades instead of sliding, so it never moves on screen. framer reads
  // the setting once per component, so the panel's motion-reduce:!transform-none also holds it
  // still when Reduce Motion is switched on while the app is open.
  const still = useReducedMotion() === true
  useModalLayer(open, { ref: panelRef, onEscape: onClose, returnFocus, lockScroll: true })

  const isBottom = side === 'bottom'
  const offScreen = isBottom ? { y: '100%' } : { x: '100%' }
  const onScreen = isBottom ? { y: 0 } : { x: 0 }

  // Portal to document.body so backdrop-filter ancestors (e.g. TopBar's
  // backdrop-blur) don't create a new containing block for position:fixed.
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          // One box per open layer, at the one stacking level all layers share: opened later, a
          // sheet or the palette is later in the page and covers this one whole, backdrop and
          // all. Closing, the box lets a new tap through while it animates out (its dialog is
          // inert); the rest of the press that closed it is swallowed (pressShield.ts).
          <div key="layer" className="fixed inset-0 z-[96] [&:has(>[inert])]:pointer-events-none">
            <motion.div
              data-sheet-backdrop=""
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => {
                // Not the tap that closed a date picker over the sheet: that would lose the entry.
                if (pressedWhileOnTop(panelRef.current)) onClose()
              }}
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title !== undefined ? titleId : undefined}
              aria-label={title === undefined ? 'Sheet' : undefined}
              tabIndex={-1}
              // Safe-area padding: an installed iPhone app in landscape draws under the side
              // notches, and an iPad app under the status bar (viewport-fit=cover). The content
              // keeps its own padding inside it.
              className={
                'fixed flex flex-col overflow-hidden border-white/[0.07] bg-surface-1 shadow-[var(--shadow-overlay)] motion-reduce:!transform-none ' +
                (isBottom
                  ? 'bottom-0 left-0 right-0 max-h-[85dvh] rounded-t-2xl border-t pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]'
                  : 'bottom-0 right-0 top-0 border-l pr-[env(safe-area-inset-right,0px)] pt-[env(safe-area-inset-top,0px)]')
              }
              style={!isBottom ? { width: `min(${width}px, 96vw)` } : undefined}
              initial={still ? { opacity: 0 } : offScreen}
              animate={still ? { opacity: 1 } : onScreen}
              exit={still ? { opacity: 0 } : offScreen}
              transition={
                still ? { duration: 0.15 } : { type: 'spring', stiffness: 380, damping: 40 }
              }
            >
              {isBottom && (
                <div className="flex shrink-0 justify-center pb-1 pt-3">
                  <div className="h-1 w-10 rounded-full bg-white/20" />
                </div>
              )}
              {title !== undefined && (
                <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
                  <h2 id={titleId} className="text-[15px] font-semibold text-white">
                    {title}
                  </h2>
                  <button
                    type="button"
                    onClick={onClose}
                    className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white"
                    aria-label="Close"
                  >
                    <X size={16} aria-hidden />
                  </button>
                </div>
              )}
              {/* Scroll padding: a control tabbed to at the scroller's edge is scrolled clear of
                  it, focus ring included (the scroller would cut the ring off). 24 px, as on the
                  page: WebKit brings a text field's caret line into view, not the field's box. */}
              <div className="flex-1 scroll-py-6 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]">
                {children}
              </div>
              <LayerAnnouncer />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </MotionConfig>,
    document.body,
  )
}
