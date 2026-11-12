import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatDate } from '../../lib/formatDate'
import { ChevronLeft, Download, FileDown, HardDrive } from 'lucide-react'
import { Button } from '../../ui/Button'
import { useToast } from '../../hooks/useToast'
import { downloadJSON } from '../../lib/download'
import { downloadRescueFile, type RescueOutcome } from '../../lib/rescue'
import {
  useExpenseStore,
  type AttentionItem,
  type ChangeItem,
  type RecoveryApi,
  type SnapshotInfo,
} from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'
import { RecoveryAttention } from './RecoveryAttention'
import { RecoveryChanges } from './RecoveryChanges'
import { RecoverySection } from './RecoveryRow'
import { RecoverySnapshots } from './RecoverySnapshots'

// Settings › Backup › Recovery (DATA-ENGINE-SPEC §15.5, PR-4 track spec §3.2; F-004, F-014,
// F-050): everything SpendTrack keeps so nothing is lost for good, in one place. It replaces
// Backup's content (a drill-in, not a fifth tab) and loads only when opened. Every restore is a
// dated change that syncs and never deletes; Discard asks first; memory-only, nothing is written.

interface Lists {
  readonly attention: readonly AttentionItem[]
  readonly changes: readonly ChangeItem[]
  readonly snapshots: readonly SnapshotInfo[]
  readonly canWrite: boolean
}

const listsOf = (api: RecoveryApi): Lists => ({
  attention: api.attention(),
  changes: api.changes(),
  snapshots: api.snapshots(),
  canWrite: api.summary().canWrite,
})

const TEXT = 'text-[12px] leading-relaxed text-[var(--text-secondary)]'

/** A raw download's outcome as a toast (the file has no sync code in it). */
function rescueToast(toast: ReturnType<typeof useToast>, outcome: RescueOutcome): void {
  switch (outcome.kind) {
    case 'downloaded':
      toast.success('Raw data downloaded')
      return
    case 'empty':
      toast.info('Nothing is saved in this browser yet.')
      return
    case 'unavailable':
      toast.error('This browser blocked access to saved data.')
      return
    case 'failed':
      toast.error("The download couldn't start. Try again.")
  }
}

export function RecoveryCentre({
  onBack,
  onDownloadBackup,
}: {
  /** Back to Backup's main view (focus goes back to the Recovery row). */
  onBack: () => void
  /** Backup's own download (it records "Last backup"): offered when a restore is refused. */
  onDownloadBackup: () => void
}) {
  const toast = useToast()
  const memoryOnly = useExpenseStore((s) => s.local === 'memory-only')
  // A merge, another tab or an action here changes these: the lists read again.
  const expenses = useExpenseStore((s) => s.expenses)
  const attention = useExpenseStore((s) => s.attention)
  const synced = useSyncStore((s) => s.syncId !== null)
  const wanted = useUIStore((s) => s.settingsFocus)
  const [api, setApi] = useState<RecoveryApi | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [lists, setLists] = useState<Lists | null>(null)
  const [reads, setReads] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const attentionRef = useRef<HTMLHeadingElement>(null)
  const changesRef = useRef<HTMLHeadingElement>(null)

  const reread = useCallback(() => {
    setReads((n) => n + 1)
  }, [])

  useLayoutEffect(() => {
    headingRef.current?.focus()
  }, [])

  useEffect(() => {
    const run = { live: true }
    void (async () => {
      try {
        const loaded = await useExpenseStore.getState().recovery()
        if (run.live) setApi(loaded)
      } catch (err) {
        if (run.live) setFailed(err instanceof Error ? err.message : "Recovery couldn't open.")
      }
    })()
    return () => {
      run.live = false
    }
  }, [])

  useEffect(() => {
    if (api !== null) setLists(listsOf(api))
  }, [api, expenses, attention, memoryOnly, reads])

  // Another tab, or the other device while this one slept: read again when it is looked at.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reread])

  // "Review" (a toast, the Needs attention card) lands on its section once the lists are read;
  // with nothing set aside any more, or no lists to read, on the view's heading. Taken either
  // way, so a later Settings opens on Backup's main view again.
  useLayoutEffect(() => {
    if (lists === null && failed === null) return
    if (wanted !== 'recovery-changes' && wanted !== 'recovery-attention') return
    if (!useUIStore.getState().takeSettingsFocus(wanted)) return
    const section =
      wanted === 'recovery-changes'
        ? changesRef.current
        : (lists?.attention.length ?? 0) > 0
          ? attentionRef.current
          : null
    const target = section ?? headingRef.current
    target?.focus()
  }, [lists, failed, wanted])

  /** The entries held in memory, as a backup file: no "Last backup", nothing is written. */
  const downloadHeld = () => {
    try {
      downloadJSON(
        `spendtrack-backup-${formatDate(new Date(), 'yyyy-MM-dd')}.json`,
        useExpenseStore.getState().exportBackup(),
      )
    } catch {
      toast.error("The download couldn't start. Try again.")
      return
    }
    toast.success('Backup downloaded')
  }

  const downloadRaw = () => {
    rescueToast(toast, downloadRescueFile())
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-start gap-2">
        <Button variant="subtle" className="-ml-2 px-2" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden /> Back to Backup
        </Button>
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="focus-inset text-[15px] font-semibold text-white"
        >
          Recovery
        </h3>
        <p className={TEXT}>
          What SpendTrack keeps so nothing is lost for good. Restoring adds entries back; it never
          removes one.
        </p>
      </div>

      {memoryOnly && (
        <section
          aria-label="Not saving"
          className="flex flex-col gap-2.5 rounded-lg border border-warning/25 bg-warning/10 p-3"
        >
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--text-primary)]">
            <HardDrive size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
            This device isn&apos;t saving. Your saved data couldn&apos;t be read and there&apos;s no
            room for a safety copy, so nothing is written. Download your entries before you close
            SpendTrack.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" onClick={downloadHeld}>
              <Download size={14} aria-hidden /> Download a backup
            </Button>
            <Button variant="ghost" className="sm:flex-1" onClick={downloadRaw}>
              <FileDown size={14} aria-hidden /> Download raw data
            </Button>
          </div>
        </section>
      )}

      {failed !== null && (
        <p role="alert" className={TEXT}>
          {failed}
        </p>
      )}
      {api === null || lists === null ? (
        failed === null && (
          <p role="status" className={TEXT}>
            Reading what this device keeps…
          </p>
        )
      ) : (
        <>
          <RecoveryAttention
            api={api}
            items={lists.attention}
            canWrite={lists.canWrite}
            headingRef={attentionRef}
            fallbackRef={headingRef}
            onChanged={reread}
          />
          <RecoveryChanges
            api={api}
            items={lists.changes}
            canWrite={lists.canWrite}
            synced={synced}
            headingRef={changesRef}
            onChanged={reread}
          />
          <RecoverySnapshots
            api={api}
            items={lists.snapshots}
            canWrite={lists.canWrite}
            onDownloadBackup={onDownloadBackup}
            onChanged={reread}
          />
        </>
      )}

      {!memoryOnly && (
        <RecoverySection title="Raw data">
          <p className={TEXT}>
            Everything SpendTrack saved in this browser, exactly as stored. Your sync code
            isn&apos;t included.
          </p>
          <Button variant="ghost" className="w-full sm:w-auto sm:self-start" onClick={downloadRaw}>
            <FileDown size={14} aria-hidden /> Download raw data
          </Button>
        </RecoverySection>
      )}
    </div>
  )
}
