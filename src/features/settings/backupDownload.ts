import { useCallback } from 'react'
import { useToast } from '../../hooks/useToast'
import { diffDays, toDayKey, todayKey } from '../../lib/dates'
import { downloadJSON } from '../../lib/download'
import { formatDate } from '../../lib/formatDate'
import { useExpenseStore } from '../../stores/useExpenseStore'

/**
 * Downloads the JSON backup and says so. One action for every place that offers it (Backup,
 * Recovery, Clear data, and the question of "Make sync private").
 */
export function useBackupDownload(): () => void {
  const toast = useToast()
  return useCallback(() => {
    downloadJSON(
      `spendtrack-backup-${formatDate(new Date(), 'yyyy-MM-dd')}.json`,
      useExpenseStore.getState().exportBackup(),
    )
    // "Last backup" here, only once the browser has the file: a download that throws records
    // nothing (ClearData catches it and removes nothing).
    useExpenseStore.getState().markBackedUp()
    toast.success('Backup downloaded')
  }, [toast])
}

/** "Last backup: today", "Last backup: 3 days ago" (local calendar days). */
export function lastBackupLine(lastBackupAt: number | null, today = todayKey()): string {
  if (lastBackupAt === null) return 'No backup downloaded yet'
  const days = Math.max(0, diffDays(toDayKey(new Date(lastBackupAt)), today))
  if (days === 0) return 'Last backup: today'
  return `Last backup: ${String(days)} ${days === 1 ? 'day' : 'days'} ago`
}
