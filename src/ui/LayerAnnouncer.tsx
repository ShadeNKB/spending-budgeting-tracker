import { useLiveRegions } from './announce'

/**
 * A layer's own live regions, rendered inside its `aria-modal` dialog: while the layer is open,
 * announcements (toasts included) are spoken from here, since the app-wide regions outside the
 * dialog are hidden from assistive tech. When the layer closes its dialog turns inert, and the
 * layer below speaks again.
 */
export function LayerAnnouncer() {
  const { polite, assertive } = useLiveRegions(true)
  return (
    <div className="sr-only">
      <div ref={polite} role="status" />
      <div ref={assertive} role="alert" />
    </div>
  )
}
