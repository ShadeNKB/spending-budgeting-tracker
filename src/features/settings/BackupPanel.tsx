import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type Ref } from 'react'
import { format } from 'date-fns'
import {
  ChevronRight,
  Download,
  FileDown,
  History,
  LifeBuoy,
  Monitor,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Upload,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import { Pill } from '../../ui/Pill'
import { shieldGesture } from '../../ui/pressShield'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useToast } from '../../hooks/useToast'
import { importWithReload } from '../../lib/chunkReload'
import { diffDays, toDayKey, todayKey } from '../../lib/dates'
import { downloadCSV, downloadJSON } from '../../lib/download'
import { expensesToCsv } from '../../lib/csv'
import {
  useExpenseStore,
  type ImportPreview as Preview,
  type StorageFacts,
} from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore, type SettingsControl } from '../../stores/useUIStore'
import { syncEnabled } from '../../services/syncConfig'
import { ClearData } from './ClearData'
import { ImportPreview } from './ImportPreview'
import { NeedsAttentionCard } from './NeedsAttentionCard'

// Recovery: its own chunk, loaded when it is opened (PR-4: the startup does not grow).
const RecoveryCentre = lazy(() =>
  importWithReload(() => import('./RecoveryCentre')).then((m) => ({
    default: m.RecoveryCentre,
  })),
)

/** "Review" asks for a section of the Recovery view. */
const forRecovery = (c: SettingsControl | null): boolean =>
  c === 'recovery-attention' || c === 'recovery-changes'

/**
 * Settings › Backup: where the data lives, the backup files, the needs-attention list, the way
 * into Recovery, clearing. Recovery opens in place of the rest (a drill-in, not a fifth tab).
 */
export function BackupPanel() {
  const expenses = useExpenseStore((s) => s.expenses)
  const facts = useExpenseStore((s) => s.facts)
  const demo = useExpenseStore((s) => s.demo)
  const synced = useSyncStore((s) => s.syncId !== null)
  const reviewing = useUIStore((s) => forRecovery(s.settingsFocus))
  const [view, setView] = useState<'main' | 'recovery'>(reviewing ? 'recovery' : 'main')
  // A "Review" while Backup is already open: Recovery opens (set while rendering, not after).
  const [reviewSeen, setReviewSeen] = useState(reviewing)
  if (reviewing !== reviewSeen) {
    setReviewSeen(reviewing)
    if (reviewing) setView('recovery')
  }
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

  /** Back from Recovery: focus goes to its row as it mounts again. */
  const backToRow = useRef(false)
  const rowRef = useCallback((row: HTMLButtonElement | null) => {
    if (row === null || !backToRow.current) return
    backToRow.current = false
    row.focus()
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

  if (view === 'recovery') {
    return (
      <Suspense
        fallback={
          <p role="status" className="text-[12px] text-[var(--text-secondary)]">
            Opening Recovery…
          </p>
        }
      >
        <RecoveryCentre
          onBack={() => {
            backToRow.current = true
            setView('main')
          }}
          onDownloadBackup={downloadBackup}
        />
      </Suspense>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="text-[13px] font-semibold text-white">{entries(expenses.length)}</div>
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {synced
            ? `Synced through your relay: every linked device has a full copy${demo === 'sample' ? ' (the sample data stays on this device)' : ''}. The relay copy isn't encrypted yet: until the database lockdown (update 005), anyone with this app's public key could read it.`
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

      <RecoveryRow
        ref={rowRef}
        onOpen={() => {
          setView('recovery')
        }}
      />

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

// Older WebKit has no navigator.storage at all, whatever lib.dom says (as data/local/persist.ts).
const storageOf = (nav: Navigator): { readonly persist?: () => Promise<boolean> } | undefined =>
  nav.storage

/** The browser's `persist()`, bound, or null where there is none. */
function persistOf(nav: Navigator): (() => Promise<boolean>) | null {
  const manager = storageOf(nav)
  return manager?.persist === undefined ? null : manager.persist.bind(manager)
}

function StorageFactsList({ facts }: { facts: StorageFacts }) {
  const persist = facts.persisted === true ? null : persistOf(navigator)
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
        <span className="flex min-w-0 flex-col items-start gap-1.5">
          {facts.persisted === true
            ? 'Storage: protected from automatic cleanup'
            : 'Storage: may be cleared by the browser. Keep sync on or download backups.'}
          {persist !== null && <AskToKeep persist={persist} />}
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

/**
 * F-050: ask the browser again to keep this site's data (it asks once by itself, after the first
 * entry). Called in the tap, where a browser that prompts wants it; the line above then says
 * what the browser decided.
 */
function AskToKeep({ persist }: { persist: () => Promise<boolean> }) {
  const toast = useToast()
  const asking = useRef(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(e) => {
        if (e.detail > 1 || asking.current) return
        asking.current = true
        shieldGesture(e.nativeEvent)
        const answer = (granted: boolean) => {
          asking.current = false
          useExpenseStore.getState().refreshStorageFacts()
          if (granted) toast.success('Storage is now protected from automatic cleanup.')
          else toast.warning("The browser didn't agree. Keep sync on or download backups.")
        }
        persist().then(answer, () => {
          answer(false)
        })
      }}
    >
      Ask the browser to keep it
    </Button>
  )
}

/** The way into Recovery, with how many changes from the other device are new. */
function RecoveryRow({ ref, onOpen }: { ref: Ref<HTMLButtonElement>; onOpen: () => void }) {
  // A merge that journals a change also changes the entries: the count reads again then.
  const expenses = useExpenseStore((s) => s.expenses)
  const [fresh, setFresh] = useState(0)
  const subId = useId()

  useEffect(() => {
    const run = { live: true }
    void (async () => {
      try {
        const api = await useExpenseStore.getState().recovery()
        if (run.live) setFresh(api.summary().newChanges)
      } catch {
        // the row opens Recovery without its count
      }
    })()
    return () => {
      run.live = false
    }
  }, [expenses])

  return (
    <button
      ref={ref}
      type="button"
      aria-label={fresh > 0 ? `Recovery, ${fresh.toLocaleString()} new` : 'Recovery'}
      aria-describedby={subId}
      onClick={(e) => {
        if (e.detail > 1) return
        shieldGesture(e.nativeEvent)
        onOpen()
      }}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-4 py-3 text-left transition hover:border-white/10 hover:bg-surface-2"
    >
      <LifeBuoy size={16} aria-hidden className="shrink-0 text-accent/70" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-white">Recovery</span>
        <span id={subId} className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          Snapshots, changes from your other device, entries set aside
        </span>
      </span>
      {fresh > 0 && <Pill tone="accent">{fresh.toLocaleString()} new</Pill>}
      <ChevronRight size={16} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
    </button>
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
