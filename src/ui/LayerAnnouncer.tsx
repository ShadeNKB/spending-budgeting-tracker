import { useUIStore } from '../stores/useUIStore'
import { useLiveRegions } from './announce'

/**
 * A layer's own live regions, rendered inside its `aria-modal` dialog: while the layer is open,
 * announcements (toasts included) are spoken from here, since the app-wide regions outside the
 * dialog are hidden from assistive tech. When the layer closes its dialog turns inert, and the
 * layer below speaks again.
 *
 * The toasts' actions are here too, for a screen reader: the Undo of a delete or an import made
 * in Settings is in the toast stack, outside the dialog, which a touch screen reader cannot reach
 * while it is open. Each runs and dismisses its toast as the toast's own button does. They are
 * out of the Tab order: Tab reaches the toast's own Undo (modalLayer's borrowed stops), so no
 * keyboard stop is doubled, nor ever invisible. Named by a label, not by text, so the dialog's
 * own text (what a search or a find on the page reads) never repeats the toast's.
 */
export function LayerAnnouncer() {
  const { polite, assertive } = useLiveRegions(true)
  const toasts = useUIStore((s) => s.toasts)
  const dismiss = useUIStore((s) => s.dismissToast)
  return (
    <div className="sr-only">
      <div ref={polite} role="status" />
      <div ref={assertive} role="alert" />
      {toasts.map(({ id, message, action }) =>
        action === undefined ? null : (
          <button
            key={id}
            type="button"
            tabIndex={-1}
            aria-label={`${action.label}: ${message}`}
            onClick={() => {
              action.onClick()
              dismiss(id)
            }}
          />
        ),
      )}
    </div>
  )
}
