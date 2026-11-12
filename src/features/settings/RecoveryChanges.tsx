import { useRef, type RefObject } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Pill } from '../../ui/Pill'
import { shieldGesture } from '../../ui/pressShield'
import { useToast } from '../../hooks/useToast'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { formatKey, keyYear, todayKey } from '../../lib/dates'
import {
  undoAction,
  undoOutcomeMessage,
  type ChangeItem,
  type RecordSummary,
  type RecoveryApi,
  type RestoreResult,
} from '../../stores/useExpenseStore'
import { PagedList, ROW_ACTION, RecoveryRow, RecoverySection, When } from './RecoveryRow'

// Changes from your other device, in Recovery (PR-4 track spec §3.2, F-004): what a sync merge
// replaced or removed here, from the journal. Restore puts this device's version back as a new,
// dated change that syncs; it never brings back what was deleted (or changed) again since.

/** A restore and its Undo live this long (P2-12). */
const UNDO_MS = 30_000

/** "1 entry", "12 entries". */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

function titleOf(c: ChangeItem): string {
  switch (c.kind) {
    case 'conflict':
      return c.after === null
        ? 'Deleted on your other device while you were editing it here'
        : 'Changed on your other device while you were editing it here'
    case 'replaced':
      return 'Changed on your other device'
    case 'removed':
      return 'Deleted on your other device'
    case 'edit-after-delete':
      return 'Edited on your other device after it was deleted here'
    case 'mass':
      return `Your other device removed ${entries(c.count)}`
  }
}

/** The version a restore brings back: this device's, or the other device's edited copy. */
const restoredOf = (c: ChangeItem): RecordSummary | null =>
  c.kind === 'edit-after-delete' ? c.after : c.before

/** What the owner reads when a restore did nothing, by why (the mass removal's toast too). */
function refusal(why: NonNullable<RestoreResult['why']>, mass: boolean): string {
  switch (why) {
    case 'already':
      return mass ? 'Those entries are already back.' : "It's already back."
    case 'changed-since':
      return 'It has changed again since, so nothing was restored.'
    case 'deleted-since':
      return mass
        ? 'Those entries are back already or were deleted again since, so nothing was restored.'
        : 'It was deleted since, so nothing was restored.'
    case 'gone':
      return "This change can't be restored any more."
  }
}

export function RecoveryChanges({
  api,
  items,
  canWrite,
  synced,
  headingRef,
  onChanged,
}: {
  api: RecoveryApi
  items: readonly ChangeItem[]
  canWrite: boolean
  synced: boolean
  headingRef: RefObject<HTMLHeadingElement | null>
  onChanged: () => void
}) {
  const toast = useToast()
  const fmt = useFormatMoney()
  const busy = useRef(false)
  const fresh = items.filter((c) => c.pinned && !c.seen).length

  const dayText = (day: string): string =>
    formatKey(day, keyYear(day) === keyYear(todayKey()) ? 'd MMM' : 'd MMM yyyy')

  const money = (n: number | null) =>
    n === null ? null : <span className="font-mono tabular-nums">{fmt(n)}</span>

  /** "Lunch · $4.50 · Meals · 19 Oct" (figures in mono, words in the body font). */
  const summary = (r: RecordSummary) => (
    <span className="text-white/90">
      {r.itemName === '' ? 'Unnamed entry' : r.itemName}
      {r.amount !== null && <> · {money(r.amount)}</>}
      {r.category !== null && ` · ${r.category}`}
      {r.day !== null && ` · ${dayText(r.day)}`}
    </span>
  )

  /** "Amount: $12.50 → $99.00": one line per field the change moved, this device's value first. */
  const moved = (before: RecordSummary, after: RecordSummary) => {
    const text = (v: string | null) => v ?? 'none'
    const lines = [
      ['Name', before.itemName, after.itemName],
      ['Category', before.category, after.category],
      ['Day', before.day, after.day],
      ['Notes', before.notes, after.notes],
    ] as const
    return (
      <>
        {before.amount !== after.amount && (
          <span>
            Amount: {money(before.amount) ?? 'none'} → {money(after.amount) ?? 'none'}
          </span>
        )}
        {lines
          .filter(([, a, b]) => a !== b)
          .map(([label, a, b]) => (
            <span key={label}>
              {label}:{' '}
              {label === 'Day'
                ? `${a === null ? 'none' : dayText(a)} → ${b === null ? 'none' : dayText(b)}`
                : `${text(a)} → ${text(b)}`}
            </span>
          ))}
      </>
    )
  }

  const restore = async (c: ChangeItem) => {
    if (busy.current) return
    busy.current = true
    let res: RestoreResult
    try {
      res = await api.restoreChange(c.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nothing was restored.')
      return
    } finally {
      busy.current = false
      onChanged()
    }
    const mass = c.kind === 'mass'
    if (res.why !== null) {
      toast.info(refusal(res.why, mass))
      return
    }
    const undoId = res.undoId
    toast.success(mass ? `Restored ${entries(res.applied)}` : 'Restored', {
      duration: UNDO_MS,
      undoId: undoId ?? undefined,
      action:
        undoId === null
          ? undefined
          : undoAction(toast, undoId, (o) => {
              if (o.skipped === 0) toast.success(undoOutcomeMessage(o))
              onChanged()
            }),
    })
  }

  return (
    <RecoverySection
      title="Changes from your other device"
      headingRef={headingRef}
      aside={
        fresh > 0 && (
          <div className="flex items-center gap-2">
            <Pill tone="accent">{fresh.toLocaleString()} new</Pill>
            {canWrite && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  api.markAllSeen()
                  onChanged()
                }}
              >
                Mark all seen
              </Button>
            )}
          </div>
        )
      }
    >
      {items.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          {synced
            ? 'Nothing has changed here from your other device.'
            : 'Changes from your other device show here once sync is on.'}
        </p>
      ) : (
        <PagedList
          items={items}
          label="Changes from your other device"
          keyOf={(c) => c.id}
          render={(c) => {
            const back = restoredOf(c)
            const name = back === null || back.itemName === '' ? 'this entry' : back.itemName
            return (
              <RecoveryRow
                title={titleOf(c)}
                badge={c.pinned && !c.seen ? <Pill tone="accent">New</Pill> : undefined}
                actions={
                  canWrite ? (
                    <Button
                      size={null}
                      variant="ghost"
                      className={ROW_ACTION}
                      aria-label={c.kind === 'mass' ? undefined : `Restore ${name}`}
                      onClick={(e) => {
                        if (e.detail > 1) return
                        shieldGesture(e.nativeEvent)
                        void restore(c)
                      }}
                    >
                      <RotateCcw size={14} aria-hidden />
                      {c.kind === 'mass' ? `Restore all ${c.count.toLocaleString()}` : 'Restore'}
                    </Button>
                  ) : undefined
                }
              >
                {back !== null && summary(back)}
                {c.before !== null && c.after !== null && moved(c.before, c.after)}
                <span className="text-[var(--text-tertiary)]">
                  <When at={c.at} />
                </span>
              </RecoveryRow>
            )
          }}
        />
      )}
    </RecoverySection>
  )
}
