import { useId, useLayoutEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
// Icons no Settings module uses: one the card shared with Settings alone would be split into a
// chunk of its own, and its name would be added to the startup code's preload list.
import { CloudDownload, FolderOpen, Sparkles } from 'lucide-react'
import { Button } from '../ui/Button'
import { shieldGesture } from '../ui/pressShield'
import { useToast } from '../hooks/useToast'
import { downloadJSON } from '../lib/download'
import { safeSet } from '../services/storage'
import { syncEnabled } from '../services/syncConfig'
import { importWithReload, isChunkLoadError } from '../lib/chunkReload'
import { useExpenseStore, type ImportPreview as Preview } from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'
import type { ImportPreview } from '../features/settings/ImportPreview'

/** Set once Start fresh is answered; `spendtrack:*`, so Remove from this device clears it too. */
export const WELCOME_KEY = 'spendtrack:welcome'

/**
 * The Backup tab's import preview, fetched with the file's first read: the card's chunk stays
 * small, and the backup nudge (same chunk) never loads it.
 */
const loadPreview = () =>
  importWithReload(() => import('../features/settings/ImportPreview')).then((m) => m.ImportPreview)

/** After the card's own button took it away: focus goes to the screen, never to <body>. */
function focusMain(): void {
  document.getElementById('main')?.focus({ preventScroll: true })
}

/** An installed app (any browser's display mode, or an iPhone Home Screen app) keeps its data. */
function isStandalone(): boolean {
  const media =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  return media || ('standalone' in navigator && navigator.standalone === true)
}

/**
 * Welcome to SpendTrack (F-050): shown on a pristine origin, which is also what a browser that
 * cleared the site's data leaves. It never blocks the screen under it. Start fresh is the main
 * action; Restore from sync (relay builds) opens Settings › Sync; Import a backup file previews
 * the file here and restores it with the Backup tab's own Restore (F-004: adds and brings back
 * only, with a snapshot and a 30 s Undo).
 */
export function FirstRunCard({ onStartFresh }: { onStartFresh: () => void }) {
  const toast = useToast()
  const titleId = useId()
  const hintId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  /** The preview waiting for an answer, numbered by the file read that made it. */
  const [pending, setPending] = useState<{
    preview: Preview
    read: number
    View: typeof ImportPreview
  } | null>(null)
  /** Closed with nothing imported: Import a backup file re-mounts and takes focus back. */
  const refocus = useRef(false)
  /** The latest file chosen: a slower read of an earlier one is dropped. */
  const readSeq = useRef(0)
  const answered = useRef(false)

  // As the commit lands, before any later key: never leave focus on <body> beside the card.
  useLayoutEffect(() => {
    if (!refocus.current || pending !== null) return
    refocus.current = false
    importRef.current?.focus()
  })

  const startFresh = (e: React.MouseEvent) => {
    if (e.detail > 1 || answered.current) return
    answered.current = true
    shieldGesture(e.nativeEvent)
    try {
      safeSet(WELCOME_KEY, '1')
    } catch {
      // storage refused: the card stays away for this page only
    }
    onStartFresh()
    focusMain()
  }

  const restoreFromSync = (e: React.MouseEvent) => {
    if (e.detail > 1) return
    const ui = useUIStore.getState()
    ui.setSettingsTab('sync')
    ui.setSettingsOpen(true)
  }

  const onFile = async (file: File) => {
    readSeq.current += 1
    const mine = readSeq.current
    try {
      const [preview, View] = await Promise.all([
        useExpenseStore.getState().previewImport(file),
        loadPreview(),
      ])
      if (mine !== readSeq.current) return
      // The question takes the buttons' place: a double tap's second tap must not answer it.
      shieldGesture()
      setPending({ preview, read: mine, View })
    } catch (err) {
      if (mine !== readSeq.current) return
      toast.error(
        isChunkLoadError(err)
          ? "Couldn't open the preview. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Couldn't read this file.",
      )
    }
  }

  // Offered by the preview only when the restore was refused for want of room.
  const downloadBackup = () => {
    try {
      downloadJSON(
        `spendtrack-backup-${format(new Date(), 'yyyy-MM-dd')}.json`,
        useExpenseStore.getState().exportBackup(),
      )
      useExpenseStore.getState().markBackedUp()
      toast.success('Backup downloaded')
    } catch {
      toast.error("The download couldn't start. Try again.")
    }
  }

  // Applied with entries: the card goes with this render, so focus goes to the screen. Cancelled,
  // or nothing new in the file: back to Import.
  const closePreview = () => {
    const imported = useExpenseStore.getState().expenses.length > 0
    refocus.current = !imported
    setPending(null)
    if (imported) focusMain()
  }

  const choosing = pending === null
  const syncHint = syncEnabled && choosing
  const tip = !isStandalone()

  return (
    <section
      aria-labelledby={titleId}
      className="mb-4 rounded-2xl border border-accent/20 bg-surface-1 p-4 md:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent"
        >
          <Sparkles size={16} />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-[16px] font-semibold leading-snug text-white">
            Welcome to SpendTrack
          </h2>
          <p className="mt-1 max-w-[60ch] text-[14px] leading-relaxed text-[var(--text-secondary)]">
            Your spending is saved on this device. New here? Start fresh. Moving phones, or did the
            browser clear its data? Bring your entries back.
          </p>
        </div>
      </div>

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
      <div className="mt-4">
        {pending === null ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className="w-full sm:w-auto" onClick={startFresh}>
              Start fresh
            </Button>
            {syncHint && (
              <Button
                variant="ghost"
                className="w-full sm:w-auto"
                aria-describedby={hintId}
                onClick={restoreFromSync}
              >
                <CloudDownload size={14} aria-hidden /> Restore from sync
              </Button>
            )}
            <Button
              ref={importRef}
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={(e) => {
                if (e.detail > 1) return
                fileRef.current?.click()
              }}
            >
              <FolderOpen size={14} aria-hidden /> Import a backup file
            </Button>
          </div>
        ) : (
          <pending.View
            // A new file is a new question, with its own guards and focus.
            key={pending.read}
            preview={pending.preview}
            onClose={closePreview}
            onDownloadBackup={downloadBackup}
            // a first run has nothing to replace
            replace={false}
          />
        )}
      </div>

      {(syncHint || tip) && (
        <div className="mt-3 flex flex-col gap-1 text-[14px] leading-relaxed text-[var(--text-tertiary)]">
          {syncHint && (
            <p id={hintId}>Join with the code from Settings › Sync on your other device.</p>
          )}
          {tip && (
            <p>
              Tip: add SpendTrack to your Home Screen (Safari: Share › Add to Home Screen) so the
              browser keeps your data.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
