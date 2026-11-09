import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { holdScrollLock, pressedWhileOnTop, useModalLayer } from './modalLayer'
import { LayerAnnouncer } from './LayerAnnouncer'
import { useHeldWhileClosing, usePresence } from './usePresence'
import { useKeyboardInset } from './keyboardInset'

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
 *
 * Motion is CSS (index.css, "Overlay motion"): the panel slides on framer-motion's old spring
 * and the backdrop fades, keyed on the layer box's `data-state` (usePresence). The panel is
 * placed by transform from its classes alone, never inline, so a drag can take it over.
 *
 * A `footer` (a sheet's Add or Save) stays in sight below the scrolling content, and the panel
 * stands on the on-screen keyboard rather than under it (keyboardInset.ts): on an iPhone the
 * keyboard covers the bottom of the page without resizing it.
 */
export function Sheet({
  open,
  onClose,
  children,
  title,
  side = 'right',
  width = 420,
  returnFocus,
  footer,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** Kept in sight under the scrolling content, above the keyboard and any toast. */
  footer?: React.ReactNode
  title?: string
  side?: 'right' | 'bottom'
  width?: number
  /** Where focus goes on close when the element that opened the sheet is gone. */
  returnFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useModalLayer(open, { ref: panelRef, onEscape: onClose, returnFocus })
  const { mounted, state } = usePresence(open, {
    parts: () => [backdropRef.current, panelRef.current],
  })
  // Closing, the sheet keeps showing what it showed (the entry just added, not a cleared form).
  const content = useHeldWhileClosing(open, children)
  const footerContent = useHeldWhileClosing(open, footer)
  useKeyboardInset(mounted, panelRef)

  const isBottom = side === 'bottom'

  // Portal to document.body so backdrop-filter ancestors (e.g. TopBar's
  // backdrop-blur) don't create a new containing block for position:fixed.
  return createPortal(
    mounted && (
      // One box per open layer, at the one stacking level all layers share: opened later, a
      // sheet or the palette is later in the page and covers this one whole, backdrop and all.
      // Closing, the box lets a new tap through while it animates out (its dialog is inert);
      // the rest of the press that closed it is swallowed (pressShield.ts). Page scroll stays
      // locked while the box is in the page, its exit included (holdScrollLock).
      <div
        ref={holdScrollLock}
        data-state={state}
        className="fixed inset-0 z-[96] [&:has(>[inert])]:pointer-events-none"
      >
        <div
          ref={backdropRef}
          data-sheet-backdrop=""
          aria-hidden="true"
          className="sheet-backdrop fixed inset-0 bg-black/60 backdrop-blur-sm"
          onClick={() => {
            // Not the tap that closed a date picker over the sheet: that would lose the entry.
            if (pressedWhileOnTop(panelRef.current)) onClose()
          }}
        />
        <div
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
            'sheet-panel fixed flex flex-col overflow-hidden border-white/[0.07] bg-surface-1 shadow-[var(--shadow-overlay)] motion-reduce:!transform-none ' +
            (isBottom
              ? 'sheet-panel--bottom left-0 right-0 rounded-t-2xl border-t pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]'
              : 'sheet-panel--right right-0 top-0 border-l pr-[env(safe-area-inset-right,0px)] pt-[env(safe-area-inset-top,0px)]')
          }
          style={!isBottom ? { width: `min(${width}px, 96vw)` } : undefined}
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
              page: WebKit brings a text field's caret line into view, not the field's box.
              The bottom padding grows by what the toast stack covers (--toast-clearance, set
              here by toastClearance.ts while the sheet is open), so the last controls can
              always scroll up out from under a toast. It never transitions (reduced motion
              gives every property a 10 µs one): the scroll to reveal a control needs the room
              laid out at once, or it stops short at the old end. With a footer, the footer
              takes that room instead: its buttons rise above the toast, and the content above
              them stays where it is. */}
          <div
            data-toast-room={footer === undefined ? '' : undefined}
            className={
              'flex-1 scroll-py-6 overflow-y-auto transition-none ' +
              (footer === undefined
                ? 'pb-[calc(env(safe-area-inset-bottom,0px)+var(--toast-clearance,0px))]'
                : '')
            }
          >
            {content}
          </div>
          {footer !== undefined && (
            <div
              data-toast-room=""
              className="sheet-footer flex shrink-0 gap-2 border-t border-white/[0.06] px-4 pt-3 transition-none md:justify-end"
            >
              {footerContent}
            </div>
          )}
          <LayerAnnouncer />
        </div>
      </div>
    ),
    document.body,
  )
}
