import { useSyncExternalStore } from 'react'
import { todayKey, type DayKey } from '../lib/dates'

// One shared "today" for every screen. A session left open overnight (a pinned PWA, a laptop
// tab) must roll over to the new day without a reload, so the key is re-read on a timer set for
// the next local midnight and whenever the app comes back (visibility, focus, bfcache restore),
// and subscribers re-render only when the day actually changes.

const listeners = new Set<() => void>()
let current: DayKey = todayKey()
let timer: ReturnType<typeof setTimeout> | undefined

function refresh(): void {
  const next = todayKey()
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

function scheduleMidnight(): void {
  clearTimeout(timer)
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0) // next local midnight, DST-safe
  timer = setTimeout(
    () => {
      refresh()
      scheduleMidnight()
    },
    midnight.getTime() - now.getTime() + 250,
  )
}

function wake(): void {
  if (document.visibilityState === 'hidden') return
  refresh()
  scheduleMidnight() // timers do not run while a phone sleeps; re-arm from the real clock
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    current = todayKey()
    scheduleMidnight()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('pageshow', wake)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    clearTimeout(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
    window.removeEventListener('pageshow', wake)
  }
}

// With nobody subscribed nothing keeps `current` fresh, so read the clock directly.
const getSnapshot = (): DayKey => (listeners.size === 0 ? todayKey() : current)

/** Today's local day key, updated across midnight and on return to the app. */
export function useToday(): DayKey {
  return useSyncExternalStore(subscribe, getSnapshot)
}
