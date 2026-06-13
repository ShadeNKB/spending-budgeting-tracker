import { useEffect, useState } from 'react'
import { Check, Loader2, WifiOff, AlertCircle } from 'lucide-react'
import clsx from 'clsx'
import { useExpenseStore } from '../stores/useExpenseStore'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export function SyncPill() {
  const localStatus = useExpenseStore((s) => s.syncStatus)
  const lastSavedAt = useExpenseStore((s) => s.lastSavedAt)
  const isOffline = useExpenseStore((s) => s.isOffline)

  const [tick, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000)
    return () => clearInterval(t)
  }, [])

  let tone = 'text-[var(--text-tertiary)] border-white/[0.06]'
  let Icon = Check
  let label = 'Saved'
  let title: string | undefined

  if (isOffline) {
    tone = 'text-warning border-warning/30 bg-warning/10'
    Icon = WifiOff
    label = 'Offline'
  } else if (localStatus === 'saving') {
    tone = 'text-accent border-accent/30 bg-accent/5'
    Icon = Loader2
    label = 'Saving…'
  } else if (localStatus === 'error') {
    tone = 'text-negative border-negative/30 bg-negative/10'
    Icon = AlertCircle
    label = 'Save failed'
  } else if (localStatus === 'saved' && lastSavedAt) {
    tone = 'text-positive border-positive/25 bg-positive/5'
    Icon = Check
    label = `Saved · ${timeAgo(lastSavedAt)}`
    title = new Date(lastSavedAt).toLocaleTimeString()
  }

  const spinning = Icon === Loader2

  return (
    <div
      key={label + tick}
      role="status"
      aria-live="polite"
      style={{ animation: 'sync-pill-in 0.15s ease both' }}
    >
      <div
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
          tone,
        )}
        title={title}
      >
        <Icon size={12} className={spinning ? 'animate-spin' : ''} />
        <span>{label}</span>
      </div>
    </div>
  )
}
