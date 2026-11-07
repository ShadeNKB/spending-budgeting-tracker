import { useRef } from 'react'
import { format } from 'date-fns'
import { Download, RotateCcw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { shieldGesture } from '../../ui/pressShield'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useToast } from '../../hooks/useToast'
import { downloadJSON } from '../../lib/download'
import type {
  ImportPreview as Preview,
  RecoveryApi,
  SnapshotInfo,
  SnapshotReason,
} from '../../stores/useExpenseStore'
import { ImportPreview } from './ImportPreview'
import { PagedList, ROW_ACTION, RecoveryRow, RecoverySection, When } from './RecoveryRow'
import { whenText } from './recoveryText'

// Snapshots, in Recovery (PR-4 track spec §3.2, F-004, F-050): the copies SpendTrack keeps on this
// device, newest first. Restore previews in the row and brings back what the copy holds that is
// missing now (a removal's copy: just what that removal took), keeping a safety copy and a 30 s
// Undo; it never removes or changes an entry. Download saves the copy as a backup file.

const LABELS: Readonly<Record<SnapshotReason, string>> = {
  daily: 'Daily copy',
  'pre-v5': 'Before the 0.10.0 upgrade',
  'delete-all': 'Before Delete all',
  import: 'Before an import or restore',
  replace: 'Before Replace',
  mass: 'Before your other device removed entries',
}

/** "1 entry", "641 entries". */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

export function RecoverySnapshots({
  api,
  items,
  canWrite,
  onDownloadBackup,
  onChanged,
}: {
  api: RecoveryApi
  items: readonly SnapshotInfo[]
  canWrite: boolean
  onDownloadBackup: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  /**
   * The row whose copy is being read ("Checking…", preview null), or previewed in its place.
   * Closing hands focus back to that row's Restore.
   */
  const open = useInlineConfirm<{ id: string; preview: Preview | null }>()
  const reads = useRef(0)

  const preview = async (snap: SnapshotInfo) => {
    if (open.pending?.id === snap.id) return
    reads.current += 1
    const mine = reads.current
    open.ask({ id: snap.id, preview: null }, snap.id)
    try {
      const p = await api.previewSnapshot(snap.id)
      if (mine === reads.current) open.ask({ id: snap.id, preview: p }, snap.id)
    } catch (err) {
      if (mine !== reads.current) return
      open.close()
      toast.error(err instanceof Error ? err.message : "This copy can't be read any more.")
    }
  }

  const download = async (snap: SnapshotInfo) => {
    let file: unknown = null
    try {
      file = await api.snapshotFile(snap.id)
    } catch {
      file = null
    }
    if (file === null) {
      toast.error("This copy can't be read any more.")
      return
    }
    try {
      downloadJSON(`spendtrack-snapshot-${format(new Date(snap.at), 'yyyy-MM-dd-HHmm')}.json`, file)
    } catch {
      toast.error("The download couldn't start. Try again.")
      return
    }
    toast.success('Snapshot downloaded')
  }

  return (
    <RecoverySection title="Snapshots">
      {items.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          No snapshots yet. SpendTrack keeps one each day you add something, and one before every
          big change.
        </p>
      ) : (
        <PagedList
          items={items}
          label="Snapshots"
          keyOf={(s) => s.id}
          render={(snap) => {
            const label = LABELS[snap.reason]
            // Three daily copies share a label: the time tells them apart for a screen reader.
            const named = `${label}, ${whenText(snap.at)}`
            const pending = open.pending?.id === snap.id ? open.pending : null
            if (pending?.preview != null) {
              return (
                <ImportPreview
                  preview={pending.preview}
                  source={{ kind: 'snapshot' }}
                  onDownloadBackup={onDownloadBackup}
                  onClose={() => {
                    open.close()
                    onChanged()
                  }}
                />
              )
            }
            const checking = pending !== null
            return (
              <RecoveryRow
                title={label}
                actions={
                  <>
                    {canWrite && (
                      <Button
                        id={open.triggerId(snap.id)}
                        size={null}
                        variant="ghost"
                        className={ROW_ACTION}
                        aria-label={`Restore ${named}`}
                        onClick={(e) => {
                          if (e.detail > 1) return
                          shieldGesture(e.nativeEvent)
                          void preview(snap)
                        }}
                      >
                        <RotateCcw size={14} aria-hidden /> Restore
                      </Button>
                    )}
                    <Button
                      size={null}
                      variant="ghost"
                      className={ROW_ACTION}
                      aria-label={`Download ${named}`}
                      onClick={(e) => {
                        if (e.detail > 1) return
                        void download(snap)
                      }}
                    >
                      <Download size={14} aria-hidden /> Download
                    </Button>
                  </>
                }
              >
                <span>
                  <When at={snap.at} /> · {entries(snap.rows)}
                </span>
                {checking && (
                  <span role="status" className="text-[var(--text-tertiary)]">
                    Checking…
                  </span>
                )}
              </RecoveryRow>
            )
          }}
        />
      )}
    </RecoverySection>
  )
}
