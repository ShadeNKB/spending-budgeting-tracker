import { useCallback, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import {
  Download,
  FileDown,
  History,
  Monitor,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Upload,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useToast } from '../../hooks/useToast'
import { diffDays, toDayKey, todayKey } from '../../lib/dates'
import { downloadCSV, downloadJSON } from '../../lib/download'
import { expensesToCsv } from '../../lib/csv'
import {
  useExpenseStore,
  type ImportPreview as Preview,
  type StorageFacts,
} from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'
import { syncEnabled } from '../../services/syncConfig'
import { ClearData } from './ClearData'
import { ImportPreview } from './ImportPreview'
import { NeedsAttentionCard } from './NeedsAttentionCard'

/** Settings › Backup: where the data lives, the backup files, the needs-attention list, clearing. */
export function BackupPanel() {
  const expenses = useExpenseStore((s) => s.expenses)
  const facts = useExpenseStore((s) => s.facts)
  const demo = useExpenseStore((s) => s.demo)
  const synced = useSyncStore((s) => s.syncId !== null)
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const downloadRef = useRef<HTMLButtonElement | null>(null)
  /** The preview waiting for an answer, numbered by the file read that made it. */
  const importing = useInlineConfirm<{ preview: Preview; read: number }>()
  /** The latest file chosen: a slower read of an earlier one is dropped. */
  const readSeq = useRef(0)

  // Whether the browser still protects the data can change between visits (Settings, a grant).
  useEffect(() => {
    useExpenseStore.getState().refreshStorageFacts()
  }, [])

  // Sync's "Export backup" sends focus here.
  const takeFocus = useCallback((button: HTMLButtonElement | null) => {
    downloadRef.current = button
    if (button && useUIStore.getState().takeSettingsFocus('backup-download')) button.focus()
  }, [])

  const downloadBackup = () => {
    downloadJSON(
      `spendtrack-backup-${format(new Date(), 'yyyy-MM-dd')}.json`,
      useExpenseStore.getState().exportBackup(),
    )
    // "Last backup" here, only once the browser has the file: a download that throws records
    // nothing (ClearData catches it and removes nothing).
    useExpenseStore.getState().markBackedUp()
    toast.success('Backup downloaded')
  }

  const exportCsv = () => {
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, expensesToCsv(expenses))
    toast.success('CSV exported')
  }

  const onFile = async (file: File) => {
    readSeq.current += 1
    const mine = readSeq.current
    try {
      const preview = await useExpenseStore.getState().previewImport(file)
      if (mine === readSeq.current) importing.ask({ preview, read: mine })
    } catch (err) {
      if (mine !== readSeq.current) return
      toast.error(err instanceof Error ? err.message : "Couldn't read this file.")
    }
  }

  const clearSample = () => {
    useExpenseStore.getState().clearSampleData()
    toast.success('Sample data cleared')
    downloadRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="text-[13px] font-semibold text-white">{entries(expenses.length)}</div>
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {synced
            ? `Synced through your relay: every linked device has a full copy${demo === 'sample' ? ' (the sample data stays on this device)' : ''}. The relay copy isn't encrypted yet, so anyone with this app's public key could read it.`
            : 'Your data is stored only on this device. Download a backup regularly.'}
        </p>
        <StorageFactsList facts={facts} />
        <InstallLines synced={synced} />
      </div>

      <Button ref={takeFocus} onClick={downloadBackup} variant="primary">
        <Download size={14} aria-hidden /> Download JSON backup
      </Button>
      <Button onClick={exportCsv} variant="ghost">
        <FileDown size={14} aria-hidden /> Export to CSV
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onFile(file)
          e.target.value = ''
        }}
      />
      {importing.pending === null ? (
        <Button id={importing.triggerId()} onClick={() => fileRef.current?.click()} variant="ghost">
          <Upload size={14} aria-hidden /> Import JSON backup
        </Button>
      ) : (
        <ImportPreview
          // A new file is a new question, with its own guards and focus.
          key={importing.pending.read}
          preview={importing.pending.preview}
          onClose={() => {
            importing.close()
          }}
          onDownloadBackup={downloadBackup}
        />
      )}

      <NeedsAttentionCard />

      <div className="mt-1 flex flex-col gap-2 border-t border-white/[0.06] pt-3">
        {demo === 'sample' && (
          <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-3">
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              <Sparkles size={12} aria-hidden className="mt-0.5 shrink-0 text-accent/70" />
              Demo mode — sample data loaded.
            </p>
            <Button variant="ghost" onClick={clearSample}>
              Clear sample data
            </Button>
          </div>
        )}
        <ClearData onDownloadBackup={downloadBackup} />
      </div>
    </div>
  )
}

/** "1 entry", "2,000 entries" (the thousands as in every other count). */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

/** "Last backup: today", "Last backup: 3 days ago" (local calendar days). */
function lastBackupLine(lastBackupAt: number | null, today = todayKey()): string {
  if (lastBackupAt === null) return 'No backup downloaded yet'
  const days = Math.max(0, diffDays(toDayKey(new Date(lastBackupAt)), today))
  if (days === 0) return 'Last backup: today'
  return `Last backup: ${String(days)} ${days === 1 ? 'day' : 'days'} ago`
}

function StorageFactsList({ facts }: { facts: StorageFacts }) {
  return (
    <ul className="mt-1 flex flex-col gap-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
      {/* A browser that cannot say (Safari without navigator.storage, the one most likely to
          clear a site that is not installed) gets the cautious line too. */}
      <li className="flex items-start gap-2">
        {facts.persisted === true ? (
          <ShieldCheck size={12} aria-hidden className="mt-0.5 shrink-0 text-positive" />
        ) : (
          <ShieldAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        )}
        <span>
          {facts.persisted === true
            ? 'Storage: protected from automatic cleanup'
            : 'Storage: may be cleared by the browser. Keep sync on or download backups.'}
        </span>
      </li>
      <li className="flex items-start gap-2">
        <History size={12} aria-hidden className="mt-0.5 shrink-0 text-accent/70" />
        <span>{lastBackupLine(facts.lastBackupAt)}</span>
      </li>
      {facts.mirror === 'off' && (
        <li className="flex items-start gap-2">
          <RotateCcw size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
          <span>Rollback copy: off (storage full)</span>
        </li>
      )}
    </ul>
  )
}

/** How to install, per platform, and how another device gets the data. */
function InstallLines({ synced }: { synced: boolean }) {
  return (
    <ul className="mt-1 flex flex-col gap-1.5 border-t border-white/[0.06] pt-2.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
      <li className="flex items-start gap-2">
        <Smartphone size={12} aria-hidden className="mt-0.5 shrink-0 text-accent/60" />
        <span>
          <strong className="font-medium text-[var(--text-secondary)]">iPhone:</strong> open it in
          Safari, tap Share, then Add to Home Screen.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <Monitor size={12} aria-hidden className="mt-0.5 shrink-0 text-accent/60" />
        <span>
          <strong className="font-medium text-[var(--text-secondary)]">Android or computer:</strong>{' '}
          use Install app in the browser&apos;s menu or address bar.
        </span>
      </li>
      {!synced && (
        <li className="flex items-start gap-2">
          <Upload size={12} aria-hidden className="mt-0.5 shrink-0 text-accent/60" />
          <span>
            <strong className="font-medium text-[var(--text-secondary)]">Another device:</strong>{' '}
            {syncEnabled
              ? 'link it in Sync, or import a backup file there.'
              : 'download a backup here and import it there.'}
          </span>
        </li>
      )}
    </ul>
  )
}
