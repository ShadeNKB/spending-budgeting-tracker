import { lazy, Suspense, useId, useState, type RefObject } from 'react'
import { format } from 'date-fns'
import { Download, Trash2, Wrench } from 'lucide-react'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { shieldGesture } from '../../ui/pressShield'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useLatch } from '../../hooks/useLatch'
import { useToast } from '../../hooks/useToast'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { importWithReload } from '../../lib/chunkReload'
import { downloadJSON } from '../../lib/download'
import {
  useExpenseStore,
  type AttentionItem,
  type ExpenseView,
  type RecoveryApi,
} from '../../stores/useExpenseStore'
import { PagedList, ROW_ACTION, RecoveryRow, RecoverySection, When } from './RecoveryRow'

// Needs attention, in Recovery (PR-4 track spec §3.2, F-014): each row SpendTrack couldn't read
// and each damaged copy it set aside, with why, where it came from and when. Fix adds the entry
// again from what still reads (the original stays in the raw data); Download saves that one item;
// Discard removes it from this device only, after asking, with "Download it first" ticked.

// The Add sheet's own chunk (loaded already when the owner has added anything this session).
const AddExpenseSheet = lazy(() =>
  importWithReload(() => import('../entry/AddExpenseSheet')).then((m) => ({
    default: m.AddExpenseSheet,
  })),
)

const REASONS: Readonly<Record<string, string>> = {
  'bad-amount': "The amount isn't a number above 0",
  'bad-date': "The date can't be read",
  'bad-name': 'It has no name',
  'bad-id': 'Its id is damaged',
  'not-object': "It isn't an entry",
  cap: 'Over the 50,000-entry limit',
  'no-free-id': "A copy with the same id couldn't be kept apart",
  'invalid-payload': "A synced copy that couldn't be read",
}

const ORIGINS: Readonly<Record<AttentionItem['origin'], string>> = {
  'local-envelope': 'Found on this device',
  'local-v4': 'Found on this device',
  remote: 'From the synced copy',
  file: 'From a backup file',
  snapshot: 'From a snapshot',
}

const ADDED_NOTE = 'The unreadable original stays in your raw data download.'

/** Past the Add toast's Undo (and Ctrl+Z on it), with room: a Fix's entry is kept by then. */
const FIX_WATCH_MS = 35_000

/**
 * A Fix marks its row fixed as the entry is added. Undone (the toast's Undo, Ctrl+Z) or deleted
 * within the watch, the entry is gone and the row is listed again: the owner can fix it later.
 * Module-level, so closing Settings does not end it.
 */
function watchFix(api: RecoveryApi, itemId: string, addedId: string): void {
  const stop = () => {
    off()
    clearTimeout(timer)
  }
  const here = (s: { readonly expenses: readonly ExpenseView[] }) =>
    s.expenses.some((e) => e.id === addedId)
  // counted as gone only once it was there
  let seen = here(useExpenseStore.getState())
  const off = useExpenseStore.subscribe((s) => {
    if (here(s)) seen = true
    if (here(s) || !seen) return
    stop()
    try {
      api.unmarkFixed(itemId)
    } catch {
      // not saving any more: nothing to list again on this device
    }
  })
  const timer = setTimeout(stop, FIX_WATCH_MS)
}

function titleOf(item: AttentionItem): string {
  if (item.kind === 'copy') {
    return item.origin === 'remote' ? 'A damaged synced copy' : 'A damaged copy of your saved data'
  }
  return item.salvage?.itemName ?? 'Unnamed entry'
}

const reasonOf = (item: AttentionItem): string =>
  item.kind === 'copy'
    ? 'Kept exactly as it was found'
    : (REASONS[item.reason] ?? "It couldn't be checked")

const fileName = (): string => `spendtrack-needs-attention-${format(new Date(), 'yyyy-MM-dd')}.json`

/**
 * The section shows only while something needs attention; it stays mounted, so the Add sheet a
 * Fix opened closes as usual when its row was the last one.
 */
export function RecoveryAttention({
  api,
  items,
  canWrite,
  headingRef,
  fallbackRef,
  onChanged,
}: {
  api: RecoveryApi
  items: readonly AttentionItem[]
  canWrite: boolean
  headingRef: RefObject<HTMLHeadingElement | null>
  /** Where focus goes once the last row has left (the Recovery heading). */
  fallbackRef: RefObject<HTMLHeadingElement | null>
  /** Something here changed: the lists read again. */
  onChanged: () => void
}) {
  const toast = useToast()
  const fmt = useFormatMoney()
  const confirm = useInlineConfirm<string>()
  const [downloadFirst, setDownloadFirst] = useState(true)
  const [fixing, setFixing] = useState<AttentionItem | null>(null)
  const sheetMounted = useLatch(fixing !== null)

  /** That one item as a file; false when it couldn't be saved (nothing else happens then). */
  const download = (item: AttentionItem): boolean => {
    const file = api.attentionFile(item.id)
    if (file === null) {
      toast.error("It's gone already.")
      return false
    }
    try {
      downloadJSON(fileName(), file)
    } catch {
      return false
    }
    return true
  }

  const discard = (item: AttentionItem) => {
    if (downloadFirst && !download(item)) {
      toast.error("The download couldn't start, so nothing was discarded. Try again.")
      confirm.close()
      return
    }
    try {
      api.discard(item.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nothing was discarded.')
      confirm.close()
      return
    }
    toast.success(downloadFirst ? 'Downloaded, then discarded' : 'Discarded')
    // the row is gone: focus goes to the section's heading (the view's, with the last row),
    // never to <body>
    confirm.close(null)
    const target = items.length > 1 ? headingRef.current : fallbackRef.current
    target?.focus()
    onChanged()
  }

  const fixed = (item: AttentionItem, added: ExpenseView) => {
    try {
      api.markFixed(item.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't mark it fixed.")
      return
    }
    watchFix(api, item.id, added.id)
    onChanged()
  }

  const salvage = fixing?.salvage ?? null

  return (
    <>
      {items.length > 0 && (
        <RecoverySection
          title={`Needs attention (${items.length.toLocaleString()})`}
          headingRef={headingRef}
        >
          <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            SpendTrack couldn&apos;t read these, so it kept them as they were. Nothing here is
            counted.
          </p>
          <PagedList
            items={items}
            label="Needs attention"
            keyOf={(item) => item.id}
            render={(item) =>
              confirm.pending === item.id ? (
                <InlineConfirm
                  tone="warning"
                  icon={<Trash2 size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />}
                  question="Discard this for good?"
                  detail={
                    <>
                      It&apos;s removed from this device. Nothing else changes.
                      <DownloadFirst
                        checked={downloadFirst}
                        onChange={setDownloadFirst}
                        onEscape={() => {
                          confirm.close()
                        }}
                      />
                    </>
                  }
                  confirmLabel="Discard"
                  onConfirm={() => {
                    discard(item)
                  }}
                  onCancel={() => {
                    confirm.close()
                  }}
                />
              ) : (
                <RecoveryRow
                  title={titleOf(item)}
                  badge={
                    item.salvage?.amount === undefined ? undefined : (
                      <span className="shrink-0 font-mono text-[13px] tabular-nums text-white">
                        {fmt(item.salvage.amount)}
                      </span>
                    )
                  }
                  actions={
                    <>
                      {canWrite && item.salvage !== null && (
                        <Button
                          variant="ghost"
                          size={null}
                          className={ROW_ACTION}
                          aria-label={`Fix ${titleOf(item)}`}
                          onClick={(e) => {
                            if (e.detail > 1) return
                            shieldGesture(e.nativeEvent)
                            setFixing(item)
                          }}
                        >
                          <Wrench size={14} aria-hidden /> Fix
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size={null}
                        className={ROW_ACTION}
                        aria-label={`Download ${titleOf(item)}`}
                        onClick={() => {
                          if (download(item)) toast.success('Downloaded')
                          else toast.error("The download couldn't start. Try again.")
                        }}
                      >
                        <Download size={14} aria-hidden /> Download
                      </Button>
                      {canWrite && (
                        <Button
                          id={confirm.triggerId(item.id)}
                          variant="ghost"
                          size={null}
                          className={ROW_ACTION}
                          aria-label={`Discard ${titleOf(item)}`}
                          onClick={(e) => {
                            if (e.detail > 1) return
                            setDownloadFirst(true)
                            confirm.ask(item.id, item.id)
                          }}
                        >
                          <Trash2 size={14} aria-hidden /> Discard…
                        </Button>
                      )}
                    </>
                  }
                >
                  <span>{reasonOf(item)}</span>
                  <span className="text-[var(--text-tertiary)]">
                    {ORIGINS[item.origin]} · <When at={item.at} />
                  </span>
                </RecoveryRow>
              )
            }
          />
        </RecoverySection>
      )}
      {sheetMounted && (
        <Suspense fallback={null}>
          <AddExpenseSheet
            open={fixing !== null}
            onClose={() => {
              setFixing(null)
            }}
            prefill={
              salvage === null
                ? undefined
                : {
                    itemName: salvage.itemName,
                    amount: salvage.amount,
                    category: salvage.category,
                    date: salvage.day,
                    notes: salvage.notes,
                  }
            }
            onAdded={(added) => {
              if (fixing !== null) fixed(fixing, added)
            }}
            addedNote={ADDED_NOTE}
            returnFocus={() => headingRef.current ?? fallbackRef.current}
          />
        </Suspense>
      )}
    </>
  )
}

/** The preselected "Download it first" box inside the Discard question (a 44 px row). */
function DownloadFirst({
  checked,
  onChange,
  onEscape,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  onEscape: () => void
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className="-ml-4 mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 pl-4 text-[13px] text-[var(--text-secondary)]"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
        onKeyDown={(e) => {
          // Escape takes back the question, not the sheet it sits in.
          if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
          e.preventDefault()
          onEscape()
        }}
        className="h-4 w-4 shrink-0 accent-accent"
      />
      Download it first
    </label>
  )
}
