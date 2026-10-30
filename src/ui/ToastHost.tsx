import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react'
import clsx from 'clsx'
import { useUIStore, type Toast } from '../stores/useUIStore'
import { changingNow, noteToastLeft, type Change } from './pressShield'
import { canAnimate, cssMs, cssToken, prefersReducedMotion } from './motion'
import { mergeLeaving, usePresence, type PresentItem } from './usePresence'

const iconFor = (k: Toast['kind']) =>
  k === 'success' ? CheckCircle2 : k === 'error' ? XCircle : k === 'warning' ? AlertTriangle : Info

// The tone is the border and the icon only. The surface is the toast's one background: a tone
// tint as a second `bg-` class won or lost by stylesheet order (warning's won, leaving amber
// toasts 95 % see-through over whatever was under them). Info is neutral grey, as on the sync
// pill and panel: cyan means a sync in progress there.
const TOAST_TONE: Record<Toast['kind'], string> = {
  success: 'border-positive/30 text-positive',
  error: 'border-negative/30 text-negative',
  warning: 'border-warning/30 text-warning',
  info: 'border-white/[0.1] text-[var(--text-secondary)]',
}

/** index.css's --motion-toast-ease where linear() is unsupported (or no stylesheet, in tests). */
const TOAST_EASE_FALLBACK = 'cubic-bezier(0.45, 0.78, 0.04, 1)'

function ToastItem({
  toast,
  present,
  appear,
  onLeft,
}: {
  toast: Toast
  /** False once dismissed: it plays its exit in place, then `onLeft` drops it. */
  present: boolean
  appear: boolean
  onLeft: (id: string, box: HTMLElement | null) => void
}) {
  const dismiss = useUIStore((s) => s.dismissToast)
  const duration = toast.duration ?? 4000
  // duration <= 0 means sticky: no timer and no countdown bar, only the close button.
  const sticky = duration <= 0
  // Reduced motion: no shrinking countdown bar (motion-reduce:hidden also hides it if the
  // setting changes while the toast shows, as index.css then holds the toast still).
  const [countdown] = useState(() => !prefersReducedMotion())

  // A leaving toast has been dismissed already: its own timer is done with.
  useEffect(() => {
    if (sticky || !present) return undefined
    const t = setTimeout(() => dismiss(toast.id), duration)
    return () => clearTimeout(t)
  }, [toast.id, dismiss, duration, sticky, present])

  const box = useRef<HTMLDivElement>(null)
  const { state } = usePresence(present, {
    parts: () => [box.current],
    appear,
    onExitComplete: () => {
      onLeft(toast.id, box.current)
    },
  })

  // A toast comes and goes under the pointer. Appearing where a double click on Add was, its
  // second press must not undo the entry just added: a press made before the toast had been on
  // screen for a moment was aimed at what was there before it. Gone (once its exit has played,
  // having timed out, or as a finger reached for its ×), it leaves its spot noted for a moment:
  // the row's trash beneath ignores a press there.
  const appeared = useRef<Change | null>(null)
  useLayoutEffect(() => {
    appeared.current = changingNow()
    const el = box.current
    return () => {
      if (el) noteToastLeft(el.getBoundingClientRect())
    }
  }, [])

  const Icon = iconFor(toast.kind)
  const { action } = toast

  return (
    <div
      ref={box}
      data-toast=""
      data-state={state}
      className={clsx(
        'toast-box pointer-events-auto relative flex w-full min-w-0 max-w-[380px] items-start gap-3 overflow-hidden rounded-xl border bg-surface-1/95 px-4 py-3 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md motion-reduce:!transform-none',
        TOAST_TONE[toast.kind],
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      {/* A long word wraps rather than pushing Undo and Dismiss out of the box, which clips. */}
      <div className="min-w-0 flex-1 break-words text-sm text-white">{toast.message}</div>
      {/* 32 px buttons pulled into the 20 px text line, each with a 44 px hit area on touch
          screens; the 12 px gap keeps the two hit areas apart. */}
      {action && (
        <button
          type="button"
          onClick={(e) => {
            // A press (not a key) as the toast appears belongs to what was there before it.
            if (e.detail > 0 && appeared.current?.includes(e.nativeEvent) === true) return
            action.onClick()
            dismiss(toast.id)
          }}
          className="tap-target -my-1.5 h-8 shrink-0 rounded-lg px-2 text-xs font-semibold text-accent transition hover:text-accent-hover"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
        className="tap-target -my-1.5 -mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:text-white"
      >
        <X size={14} aria-hidden />
      </button>
      {!sticky && countdown && (
        <div
          className="toast-countdown absolute bottom-0 left-0 right-0 h-[2px] bg-current opacity-40 motion-reduce:hidden"
          style={{ animationDuration: `${String(duration)}ms` }}
        />
      )}
    </div>
  )
}

/** A slide a box is playing: from `from` px above (or below) its place, to its place. */
interface Slide {
  readonly animation: Animation
  readonly from: number
}

/** The slide each box is playing, so a new one starts from where it has got to. */
const slides = new WeakMap<Element, Slide>()

/**
 * Where a slide has the box now, in px from its place: from the slide's own eased progress, not
 * from computed style (which WebKit can report stale while an animation runs on the compositor).
 */
function slideOffset(slide: Slide | undefined): number {
  const progress = slide?.animation.effect?.getComputedTiming().progress
  return slide && typeof progress === 'number' ? slide.from * (1 - progress) : 0
}

/**
 * FLIP for the toasts that stay when one leaves: each box starts where it was (`tops`: its
 * layout top before the removal, by element, plus where a running slide had it) and slides to
 * its new place on the individual `translate` property, which composes with the box's own CSS
 * transform transition instead of being outranked by it. Layout positions ignore transforms:
 * the region's top plus the box's offset in it (the region is anchored at its bottom and grows
 * upwards).
 */
function slideIntoPlace(region: HTMLElement, tops: ReadonlyMap<HTMLElement, number>): void {
  const regionTop = region.getBoundingClientRect().top + region.clientTop
  const moves: { box: HTMLElement; dy: number }[] = []
  for (const [box, top] of tops) {
    if (!box.isConnected) continue
    moves.push({ box, dy: top + slideOffset(slides.get(box)) - (regionTop + box.offsetTop) })
  }
  const duration = cssMs('--motion-toast-ms', 350)
  const easing = cssToken('--motion-toast-ease') || TOAST_EASE_FALLBACK
  for (const { box, dy } of moves) {
    slides.get(box)?.animation.cancel()
    slides.delete(box)
    if (Math.abs(dy) < 0.5) continue
    const animation = box.animate([{ translate: `0 ${String(dy)}px` }, { translate: '0 0' }], {
      duration,
      easing,
    })
    slides.set(box, { animation, from: dy })
  }
}

/** Layout tops of the region's boxes other than `leaving`, by element. */
function layoutTops(region: HTMLElement, leaving: HTMLElement | null): Map<HTMLElement, number> {
  const regionTop = region.getBoundingClientRect().top + region.clientTop
  const tops = new Map<HTMLElement, number>()
  for (const child of region.children) {
    if (child instanceof HTMLElement && child !== leaving) {
      tops.set(child, regionTop + child.offsetTop)
    }
  }
  return tops
}

/**
 * The visible toasts. Screen readers hear them through ToastAnnouncer's persistent regions
 * (inserting a toast together with its text is often not announced), so this is a plain named
 * region. It is exempt from the modal focus guard: Undo stays usable while a sheet is open.
 *
 * A dismissed toast stays where it was while it plays its exit (still pressable), then leaves,
 * and the toasts above it slide down into place. Toasts already there when the host first
 * shows (it loads lazily) appear without an entrance.
 */
export function ToastHost() {
  const toasts = useUIStore((s) => s.toasts)
  const [shown, setShown] = useState<readonly PresentItem<Toast>[]>(() =>
    mergeLeaving([], toasts, false),
  )
  const [toastsSeen, setToastsSeen] = useState(toasts)
  if (toasts !== toastsSeen) {
    setToastsSeen(toasts)
    setShown(mergeLeaving(shown, toasts))
  }

  const regionRef = useRef<HTMLDivElement>(null)
  /** Layout tops of the staying toasts, taken as one finished leaving, before it is dropped. */
  const before = useRef<Map<HTMLElement, number> | null>(null)
  const onLeft = useCallback((id: string, box: HTMLElement | null) => {
    const region = regionRef.current
    if (region && canAnimate() && !prefersReducedMotion()) {
      // Two leaving in one go: the first reading stands (nothing has moved since).
      const tops = before.current ?? layoutTops(region, box)
      if (box) tops.delete(box)
      before.current = tops
    }
    setShown((list) => list.filter((t) => t.item.id !== id))
  }, [])

  useLayoutEffect(() => {
    const tops = before.current
    const region = regionRef.current
    before.current = null
    if (tops && region) slideIntoPlace(region, tops)
  }, [shown])

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Notifications"
      data-layer-exempt=""
      className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] left-4 right-4 z-[100] flex flex-col-reverse gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:max-w-sm"
    >
      {shown.map(({ item, present, appear }) => (
        <ToastItem key={item.id} toast={item} present={present} appear={appear} onLeft={onLeft} />
      ))}
    </div>
  )
}
