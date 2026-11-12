import { useId, useMemo, useRef, useState } from 'react'
import { formatDate } from '../lib/formatDate'
// DatabaseBackup: an icon no Settings module uses, so the card shares no chunk with Settings alone.
import { DatabaseBackup, Download } from 'lucide-react'
import { Button } from '../ui/Button'
import { shieldGesture } from '../ui/pressShield'
import { useToast } from '../hooks/useToast'
import { useToday } from '../hooks/useToday'
import { diffDays, toDayKey, type DayKey } from '../lib/dates'
import { downloadJSON } from '../lib/download'
import { safeSet } from '../services/storage'
import { isOwnRow, useExpenseStore, type ExpenseView } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'

/** When Later was pressed (epoch ms); `spendtrack:*`, so Remove from this device clears it too. */
export const LATER_KEY = 'spendtrack:backup-later'

/** Local calendar days without a backup before the card shows: alone, and with healthy sync. */
const DUE_DAYS = 30
const DUE_DAYS_SYNCED = 60
/** How long Later keeps it away. */
const LATER_DAYS = 7
const LATER_DAYS_SYNCED = 30
/** Sync counts as healthy with no error and a cycle within this many days. */
const HEALTHY_WITHIN_DAYS = 7

const dayOf = (ms: number): DayKey => toDayKey(new Date(ms))

/** The day of the oldest of the owner's own entries (sample rows never count), or null. */
function oldestOwnDay(expenses: readonly ExpenseView[]): DayKey | null {
  let oldest: DayKey | null = null
  for (const e of expenses) {
    if (isOwnRow(e) && (oldest === null || e.day < oldest)) oldest = e.day
  }
  return oldest
}

/** The stored Later press, or null when there is none, it is damaged or storage refused. */
function readLater(): number | null {
  try {
    const at = Number(localStorage.getItem(LATER_KEY))
    return Number.isFinite(at) && at > 0 ? at : null
  } catch {
    return null
  }
}

/** After the card's own button took it away: focus goes to the screen, never to <body>. */
function focusMain(): void {
  document.getElementById('main')?.focus({ preventScroll: true })
}

/**
 * Time for a backup (F-050): the owner's entries have gone 30 local calendar days without a
 * backup file (60 while sync is healthy; never backed up counts from the oldest own entry).
 * Download a backup records "Last backup" only once the browser has the file; Later keeps it
 * away for 7 days (30 with healthy sync), across reloads. It is not a live region: it is seen,
 * never announced at boot.
 */
export function BackupNudge() {
  const expenses = useExpenseStore((s) => s.expenses)
  const local = useExpenseStore((s) => s.local)
  const lastBackupAt = useExpenseStore((s) => s.facts.lastBackupAt)
  const linked = useSyncStore((s) => s.syncId !== null)
  const syncFailing = useSyncStore((s) => s.lastError !== null)
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt)
  const today = useToday()
  const toast = useToast()
  const titleId = useId()
  const [laterAt, setLaterAt] = useState(readLater)
  const downloading = useRef(false)
  // One pass over the entries per change of the list, not per render.
  const oldest = useMemo(() => oldestOwnDay(expenses), [expenses])

  const healthy =
    linked &&
    !syncFailing &&
    lastSyncAt !== null &&
    diffDays(dayOf(lastSyncAt), today) <= HEALTHY_WITHIN_DAYS
  const since = lastBackupAt === null ? oldest : dayOf(lastBackupAt)
  if (local !== 'saved' || oldest === null || since === null) return null
  const days = diffDays(since, today)
  if (days < (healthy ? DUE_DAYS_SYNCED : DUE_DAYS)) return null
  if (laterAt !== null) {
    // A stamp from the future (the clock went back) snoozes nothing.
    const snoozed = diffDays(dayOf(laterAt), today)
    if (snoozed >= 0 && snoozed < (healthy ? LATER_DAYS_SYNCED : LATER_DAYS)) return null
  }

  const download = (e: React.MouseEvent) => {
    if (e.detail > 1 || downloading.current) return
    downloading.current = true
    shieldGesture(e.nativeEvent)
    try {
      downloadJSON(
        `spendtrack-backup-${formatDate(new Date(), 'yyyy-MM-dd')}.json`,
        useExpenseStore.getState().exportBackup(),
      )
      // Recorded only once the browser has the file: a download that throws records nothing.
      useExpenseStore.getState().markBackedUp()
    } catch {
      downloading.current = false
      toast.error("The download couldn't start. Try again.")
      return
    }
    toast.success('Backup downloaded')
    focusMain()
  }

  const later = (e: React.MouseEvent) => {
    if (e.detail > 1) return
    shieldGesture(e.nativeEvent)
    const now = Date.now()
    try {
      safeSet(LATER_KEY, String(now))
    } catch {
      // storage refused: away for this page only
    }
    setLaterAt(now)
    focusMain()
  }

  return (
    <section
      aria-labelledby={titleId}
      className="mb-4 rounded-2xl border border-white/[0.06] bg-surface-1 p-4 md:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent"
        >
          <DatabaseBackup size={16} />
        </span>
        <div className="min-w-0 text-[14px] leading-relaxed text-[var(--text-secondary)]">
          <h2 id={titleId} className="text-[16px] font-semibold leading-snug text-white">
            Time for a backup
          </h2>
          <p className="mt-1">
            {lastBackupAt === null
              ? "You haven't downloaded a backup yet."
              : `Last backup: ${days.toLocaleString()} days ago.`}
          </p>
          <p className="max-w-[60ch]">
            {linked
              ? "Sync keeps your devices alike, but a delete reaches all of them. A backup file doesn't."
              : 'This device holds the only copy of your entries.'}
          </p>
        </div>
      </div>
      {/* Side by side on a phone too: stacked, the card took a third of the screen above every
          list (the Ledger's first entry started below the fold at 320 px). */}
      <div className="mt-4 flex gap-2">
        <Button className="flex-1 max-[359px]:px-3 sm:flex-none" onClick={download}>
          <Download size={14} aria-hidden /> Download a backup
        </Button>
        <Button variant="ghost" className="shrink-0 max-[359px]:px-3" onClick={later}>
          Later
        </Button>
      </div>
    </section>
  )
}
