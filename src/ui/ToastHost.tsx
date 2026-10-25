import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react'
import clsx from 'clsx'
import { useUIStore, type Toast } from '../stores/useUIStore'
import { changingNow, noteToastLeft, type Change } from './pressShield'

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

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUIStore((s) => s.dismissToast)
  const duration = toast.duration ?? 4000
  // duration <= 0 means sticky: no timer and no countdown bar, only the close button.
  const sticky = duration <= 0
  // Reduced motion: toasts fade in place, and the shrinking countdown bar is left out (and
  // motion-reduce:!transform-none holds a toast still if the setting changes while it shows).
  const still = useReducedMotion() === true

  useEffect(() => {
    if (sticky) return undefined
    const t = setTimeout(() => dismiss(toast.id), duration)
    return () => clearTimeout(t)
  }, [toast.id, dismiss, duration, sticky])

  // A toast comes and goes under the pointer. Appearing where a double click on Add was, its
  // second press must not undo the entry just added: a press made before the toast had been on
  // screen for a moment was aimed at what was there before it. Gone (by itself, as a finger
  // reached for its ×), it leaves its spot noted for a moment: the row's trash beneath ignores
  // a press there.
  const box = useRef<HTMLDivElement>(null)
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
    <motion.div
      ref={box}
      data-toast=""
      layout={!still}
      initial={still ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
      animate={still ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
      transition={still ? { duration: 0.15 } : { type: 'spring', stiffness: 420, damping: 32 }}
      className={clsx(
        'pointer-events-auto relative flex w-full min-w-0 max-w-[380px] items-start gap-3 overflow-hidden rounded-xl border bg-surface-1/95 px-4 py-3 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md motion-reduce:!transform-none',
        TOAST_TONE[toast.kind],
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex-1 text-sm text-white">{toast.message}</div>
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
      {!sticky && !still && (
        <motion.div
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: duration / 1000, ease: 'linear' }}
          style={{ transformOrigin: 'left' }}
          className="absolute bottom-0 left-0 right-0 h-[2px] bg-current opacity-40"
        />
      )}
    </motion.div>
  )
}

/**
 * The visible toasts. Screen readers hear them through ToastAnnouncer's persistent regions
 * (inserting a toast together with its text is often not announced), so this is a plain named
 * region. It is exempt from the modal focus guard: Undo stays usable while a sheet is open.
 */
export function ToastHost() {
  const toasts = useUIStore((s) => s.toasts)
  return (
    <MotionConfig reducedMotion="user">
      <div
        role="region"
        aria-label="Notifications"
        data-layer-exempt=""
        className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] left-4 right-4 z-[100] flex flex-col-reverse gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:max-w-sm"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} />
          ))}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}
