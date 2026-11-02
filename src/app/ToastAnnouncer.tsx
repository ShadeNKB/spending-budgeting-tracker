import { useEffect } from 'react'
import { announce, useLiveRegions } from '../ui/announce'
import { useUIStore, type Toast } from '../stores/useUIStore'

/** A mouse or trackpad: a laptop's keyboard is there, so its undo key is worth saying. */
const hasKeyboard = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches

const undoKey = (): string => (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘Z' : 'Ctrl+Z')

/** A sheet or the palette is open (a closing one has turned inert by the time this speaks). */
const inLayer = (): boolean => document.querySelector('[aria-modal="true"]:not([inert])') !== null

/**
 * "Added "kopi" · S$4.50. Undo available." A toast that answers the undo stack (it has an
 * `undoId`) and shows while a sheet is open also names the key, where there is a keyboard: the
 * toast's Undo is then reached last in the sheet's Tab order, and the key works at once.
 */
function spoken(toast: Toast): string {
  if (!toast.action) return toast.message
  const said = `${toast.message.replace(/\.$/, '')}. ${toast.action.label} available`
  return toast.undoId !== undefined && inLayer() && hasKeyboard()
    ? `${said}, or press ${undoKey()}.`
    : `${said}.`
}

/**
 * The app-wide live regions, mounted with the shell and never re-created, and the one place
 * toasts are announced from (the toast host itself loads lazily and comes and goes). Each new
 * toast is spoken once: errors assertively, the rest politely. A sheet or the palette that is
 * open speaks it through its own regions (see announce.ts).
 */
export function ToastAnnouncer() {
  const { polite, assertive } = useLiveRegions(true)

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (state.toasts === previous.toasts) return
      const known = new Set(previous.toasts.map((t) => t.id))
      for (const toast of state.toasts) {
        if (known.has(toast.id)) continue
        // After the commit the toast arrived with: a sheet that closed in it ("Added …" on
        // Save) has turned inert by then, so the toast is not spoken into a closing dialog.
        const timer = setTimeout(() => {
          timers.delete(timer)
          announce(spoken(toast), toast.kind === 'error' ? 'assertive' : 'polite')
        }, 0)
        timers.add(timer)
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])

  return (
    <div className="sr-only">
      <div ref={polite} role="status" />
      <div ref={assertive} role="alert" />
    </div>
  )
}
