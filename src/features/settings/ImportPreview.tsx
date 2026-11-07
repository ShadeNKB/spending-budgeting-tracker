import { useId, useLayoutEffect, useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '../../ui/Button'
import { announce } from '../../ui/announce'
import { shieldGesture } from '../../ui/pressShield'
import { useToast } from '../../hooks/useToast'
import {
  undoOutcomeMessage,
  useExpenseStore,
  type ImportOutcome,
  type ImportPreview as Preview,
  type SnapshotSkips,
} from '../../stores/useExpenseStore'
import { RefusedNotice } from './ClearData'
import { TypedConfirm } from './TypedConfirm'

/** Import and its Undo live this long (P2-12). */
const UNDO_MS = 30_000

/** A count as the owner reads it: "1,500". */
const count = (n: number): string => n.toLocaleString()

/** "1 entry", "1,500 entries". */
const entries = (n: number): string => `${count(n)} ${n === 1 ? 'entry' : 'entries'}`

interface Line {
  readonly n: number
  readonly what: string
}

/**
 * What is being imported: a backup file (the default), or a snapshot kept on this device, with
 * what its restore leaves alone (restored before: back already, or deleted again since).
 */
export interface PreviewSource {
  readonly kind: 'snapshot'
  readonly skips?: SnapshotSkips
}

/**
 * The preview's lines: the file's total first, always, then only the parts that count
 * something. Every row in the file is in exactly one part (unreadable rows included), so the
 * parts add up to the total.
 */
function previewLines(preview: Preview, of: string, skips: SnapshotSkips | undefined): Line[] {
  const c = preview.counts
  const parts: Line[] = [
    { n: c.added, what: 'new' },
    { n: c.restored, what: 'restored (they were deleted)' },
    { n: c.updated, what: 'updated' },
    { n: c.alreadyHere + (skips?.back ?? 0), what: 'already here' },
    { n: skips?.deletedSince ?? 0, what: 'deleted again since (they stay deleted)' },
    { n: c.deletedInFile, what: `marked deleted in the ${of}` },
    { n: c.unreadable, what: "can't be read" },
  ].filter((l) => l.n > 0)
  const total = parts.reduce((sum, l) => sum + l.n, 0)
  return [{ n: total, what: `in the ${of}` }, ...parts]
}

/**
 * "Imported · 3 added, 1 restored", "Replaced · 57 removed, 4 restored": the parts that
 * happened, in the order they matter for each mode.
 */
function outcomeMessage(o: ImportOutcome, mode: 'restore' | 'replace'): string {
  const parts: Line[] =
    mode === 'replace'
      ? [
          { n: o.removed, what: 'removed' },
          { n: o.restored, what: 'restored' },
          { n: o.added, what: 'added' },
          { n: o.updated, what: 'updated' },
        ]
      : [
          { n: o.added, what: 'added' },
          { n: o.restored, what: 'restored' },
          { n: o.updated, what: 'updated' },
        ]
  const said = parts.filter((p) => p.n > 0).map((p) => `${count(p.n)} ${p.what}`)
  return `${mode === 'replace' ? 'Replaced' : 'Imported'} · ${said.join(', ')}`
}

/**
 * What a chosen backup file would do, before anything changes, inline in the Backup tab. A
 * snapshot (Recovery) previews the same way, as a restore only: it has no Replace.
 * Restore (the default, focused) only adds and revives: nothing on this device or any linked
 * device is removed, and it survives the next sync. Replace makes the file the whole truth and
 * deletes the rest everywhere, so it asks for REPLACE typed. Both keep a snapshot and a 30 s
 * Undo; the store plans again against the data as it is when applied, so a preview left open
 * while something changed still applies correctly.
 */
export function ImportPreview({
  preview,
  onClose,
  onDownloadBackup,
  source,
  replace,
}: {
  preview: Preview
  /** The preview is done: applied, cancelled or refused and closed. */
  onClose: () => void
  onDownloadBackup: () => void
  /** Left out: a backup file. */
  source?: PreviewSource
  /** false: Restore only (a first run has nothing to replace). A snapshot never offers it. */
  replace?: boolean
}) {
  const snapshot = source?.kind === 'snapshot'
  const toast = useToast()
  const headingId = useId()
  const noteId = useId()
  const restoreRef = useRef<HTMLButtonElement>(null)
  const replaceRef = useRef<HTMLButtonElement>(null)
  const applied = useRef(false)
  const backFromReplace = useRef(false)
  const [replacing, setReplacing] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  // In the commit that shows the preview (it comes from a file read, not a press): Restore, the
  // safe choice, is under the next key.
  useLayoutEffect(() => {
    restoreRef.current?.focus()
  }, [])
  useLayoutEffect(() => {
    if (replacing || !backFromReplace.current) return
    backFromReplace.current = false
    replaceRef.current?.focus()
  }, [replacing])

  // Escape takes the preview back (as Cancel), not the sheet it sits in.
  const backOut = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
    e.preventDefault()
    onClose()
  }

  const apply = (mode: 'restore' | 'replace') => {
    if (applied.current) return
    applied.current = true
    let outcome: ImportOutcome
    try {
      outcome = useExpenseStore.getState().applyImport(preview, mode)
    } catch (err) {
      applied.current = false
      const message = err instanceof Error ? err.message : 'Nothing was imported.'
      setReplacing(false)
      setRefused(message)
      announce(`Download a backup, then try again. ${message}`, 'assertive')
      return
    }
    const changed = outcome.added + outcome.restored + outcome.updated + outcome.removed
    const entry = useExpenseStore.getState().undoStack.at(-1)
    const undoId = entry?.id.startsWith('imp-') === true ? entry.id : null
    if (changed === 0) {
      toast.info(
        snapshot
          ? (source.skips?.deletedSince ?? 0) > 0
            ? 'Nothing to restore: the rest of the copy is here already or was deleted again since'
            : 'Nothing to restore: everything in the copy is already here'
          : mode === 'restore'
            ? 'Nothing to import: everything in the file is already here'
            : 'Nothing to replace: this device already matches the file',
      )
    } else {
      toast.success(snapshot ? `Restored ${entries(changed)}` : outcomeMessage(outcome, mode), {
        duration: UNDO_MS,
        undoId: undoId ?? undefined,
        action:
          undoId === null
            ? undefined
            : {
                label: 'Undo',
                onClick: () => {
                  const o = useExpenseStore.getState().consumeUndo(undoId)
                  if (o === null) return
                  if (o.skipped > 0) toast.warning(undoOutcomeMessage(o))
                  else toast.success(undoOutcomeMessage(o))
                },
              },
      })
    }
    onClose()
  }

  if (refused !== null) {
    return (
      <RefusedNotice
        message={refused}
        onDownload={() => {
          onDownloadBackup()
          onClose()
        }}
        onClose={onClose}
      />
    )
  }

  const lines = previewLines(preview, snapshot ? 'copy' : 'file', source?.skips)
  const deletes = preview.replaceDeletes

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={replacing ? undefined : noteId}
      className="flex flex-col gap-3 rounded-lg border border-accent/25 bg-accent/[0.06] p-4"
    >
      <div className="flex items-start gap-2">
        <FileUp size={15} aria-hidden className="mt-0.5 shrink-0 text-accent" />
        <h3
          id={headingId}
          className="min-w-0 text-[13px] font-semibold text-white [overflow-wrap:anywhere]"
        >
          {snapshot ? 'Restore from this copy?' : `Import ${preview.fileName}?`}
        </h3>
      </div>
      {/* Mono figures for the numbers only (design brief), right-aligned in one column so the
          parts read down against the total; the words stay in the body font. */}
      <ul className="flex flex-col gap-1 pl-6 text-[13px] text-[var(--text-secondary)]">
        {lines.map((line) => (
          <li key={line.what} className="flex items-baseline gap-2">
            <span className="min-w-[3.5ch] text-right font-mono tabular-nums text-white">
              {count(line.n)}
            </span>{' '}
            <span>{line.what}</span>
          </li>
        ))}
      </ul>
      {replacing ? (
        <TypedConfirm
          question={`Replace everything with ${entries(preview.counts.inFile)} from this file?`}
          detail={
            deletes === 0
              ? "Every entry here is in the file, so nothing is deleted. Replace makes the file's version of each entry current on every linked device."
              : `Replace deletes the ${entries(deletes)} that aren't in this file, on every linked device.`
          }
          word="REPLACE"
          confirmLabel="Replace"
          onConfirm={() => {
            apply('replace')
          }}
          onCancel={() => {
            backFromReplace.current = true
            setReplacing(false)
          }}
        />
      ) : (
        <>
          <p id={noteId} className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {snapshot
              ? 'Nothing here is removed or changed.'
              : 'Nothing on this device or your other devices will be removed.'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              ref={restoreRef}
              className="sm:flex-1"
              onClick={(e) => {
                if (e.detail > 1) return
                shieldGesture(e.nativeEvent)
                apply('restore')
              }}
              onKeyDown={backOut}
            >
              Restore
            </Button>
            {!snapshot && replace !== false && (
              <Button
                ref={replaceRef}
                variant="ghost"
                className="sm:flex-1"
                onClick={(e) => {
                  if (e.detail > 1) return
                  shieldGesture(e.nativeEvent)
                  setReplacing(true)
                }}
                onKeyDown={backOut}
              >
                Replace instead…
              </Button>
            )}
            <Button
              variant="ghost"
              className="sm:flex-1"
              onClick={(e) => {
                if (e.detail > 1) return
                shieldGesture(e.nativeEvent)
                onClose()
              }}
              onKeyDown={backOut}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
