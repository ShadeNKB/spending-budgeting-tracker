import { format } from 'date-fns'
import { diffDays, toDayKey } from '../../lib/dates'

// Text the Recovery view's sections share (PR-4 track spec §3.2, §4).

/** "Today, 14:02", "Yesterday, 09:15", "19 Oct, 14:02", "19 Oct 2025, 14:02" (local time). */
export function whenText(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const days = diffDays(toDayKey(d), toDayKey(now))
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : format(d, d.getFullYear() === now.getFullYear() ? 'd MMM' : 'd MMM yyyy')
  return `${day}, ${format(d, 'HH:mm')}`
}
