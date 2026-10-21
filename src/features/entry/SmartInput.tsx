import { lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, CornerDownLeft, X, CalendarDays, PenLine, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { parseExpense, quickAddDateLabel, quickAddStoredDate } from '../../utils/parseExpense'
import {
  CONFIRM_DELAY_MS,
  isAmountTooLarge,
  isUnusualAmount,
  type AmountConfirmation,
} from '../../utils/amountGuard'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useHaptic } from '../../hooks/useHaptic'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { keyToLocalNoon } from '../../lib/dates'
import { Pill } from '../../ui/Pill'
import { colorFromString } from '../../lib/analytics'
import { importWithReload } from '../../lib/chunkReload'
import { OverlaySlot } from '../../app/OverlaySlot'

// SmartInput is on screen at boot (in the header and on Pulse), so its full-entry sheet only
// mounts on the first tap: a lazy component rendered at boot would fetch the sheet and
// framer-motion before first paint. A stale chunk reloads once; a failure shows the panel
// recovery card, never a crash of the screen around it.
const AddExpenseSheet = lazy(() =>
  importWithReload(() => import('./AddExpenseSheet')).then((m) => ({
    default: m.AddExpenseSheet,
  })),
)

export function SmartInput({
  autoFocus,
  onCommit,
  placeholder = 'e.g. coffee 4.50, grab 12 yesterday',
  className,
  dense,
}: {
  autoFocus?: boolean
  onCommit?: () => void
  placeholder?: string
  className?: string
  dense?: boolean
}) {
  const [value, setValue] = useState('')
  // Set when a large amount is flagged; a later Add on the same text confirms it.
  const [flagged, setFlagged] = useState<AmountConfirmation | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set by a commit, cleared by typing: a second Enter or tap before the text changes adds nothing.
  const committedRef = useRef(false)
  const addExpense = useExpenseStore((s) => s.addExpense)
  const categoryMappings = useExpenseStore((s) => s.categoryMappings)
  const categories = useExpenseStore((s) => s.categories)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const vibrate = useHaptic()
  const fmt = useFormatMoney()
  // Relative dates ("yesterday", "31 dec") follow the day, even when the app stays open overnight.
  const today = useToday()

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const parsed = useMemo(
    () => parseExpense(value, categoryMappings, { categories, now: keyToLocalNoon(today) }),
    [value, categoryMappings, categories, today],
  )
  const amount = parsed.amount !== null && parsed.amount > 0 ? parsed.amount : null
  const tooLarge = amount !== null && isAmountTooLarge(amount)
  const canCommit = parsed.itemName !== '' && amount !== null && !tooLarge
  const confirming = canCommit && flagged?.text === value

  const parsedDateLabel = quickAddDateLabel(parsed.parsedDate, keyToLocalNoon(today))

  const edit = (next: string) => {
    committedRef.current = false
    setFlagged(null)
    setValue(next)
  }

  /** `at` is the triggering event's timeStamp, so a double tap cannot confirm its own warning. */
  const commit = (at: number) => {
    if (committedRef.current || !canCommit) return
    if (confirming) {
      if (at - flagged.at < CONFIRM_DELAY_MS) return
    } else if (isUnusualAmount(amount, useExpenseStore.getState().expenses)) {
      setFlagged({ text: value, at })
      vibrate([10, 60, 10])
      return
    }
    const created = addExpense({
      itemName: parsed.itemName,
      amount,
      category: parsed.suggestedCategory,
      date: quickAddStoredDate(parsed.parsedDate),
    })
    committedRef.current = true
    vibrate(10)
    toast.success(
      `Added "${created.itemName}" · ${fmt(created.amount)}${parsedDateLabel ? ` · ${parsedDateLabel}` : ''}`,
      {
        action: {
          label: 'Undo',
          onClick: () => {
            const entry = useExpenseStore
              .getState()
              .undoStack.find((u) => u.id === `add-${created.id}`)
            if (entry) consumeUndo(entry.id)
          },
        },
      },
    )
    setTimeout(() => {
      const entry = useExpenseStore.getState().undoStack.find((u) => u.id === `add-${created.id}`)
      if (entry) useExpenseStore.getState().clearUndo(entry.id)
    }, 6000)
    setValue('')
    setFlagged(null)
    onCommit?.()
  }

  const status = confirming
    ? `Large amount, ${fmt(amount)}. Press Confirm to add it.`
    : tooLarge
      ? 'Amount too large.'
      : ''

  return (
    <>
      <div
        className={clsx(
          'relative flex flex-col gap-2 rounded-2xl border border-white/[0.07] bg-surface-1/85 px-3 py-2.5 backdrop-blur-md transition',
          'focus-within:border-accent/40 focus-within:shadow-[0_0_0_4px_rgba(34,211,238,0.1)]',
          className,
        )}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="shrink-0 text-accent/80" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                if (!e.repeat) commit(e.timeStamp)
              } else if (e.key === 'Escape') {
                edit('')
                inputRef.current?.blur()
              }
            }}
            placeholder={placeholder}
            className={clsx(
              'min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-[var(--text-tertiary)]',
              dense ? 'text-[14px]' : 'text-[15px]',
            )}
            aria-label="Quick add expense"
          />

          {value && (
            <button
              type="button"
              onClick={() => edit('')}
              className="shrink-0 text-[var(--text-tertiary)] transition hover:text-white"
              aria-label="Clear quick entry"
            >
              <X size={14} />
            </button>
          )}

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white"
            aria-label="Full entry form"
            title="Full entry (with date picker)"
          >
            <PenLine size={13} />
          </button>

          <button
            type="button"
            onClick={(e) => commit(e.timeStamp)}
            disabled={!canCommit}
            className={clsx(
              'inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition',
              !canCommit
                ? 'cursor-not-allowed bg-surface-2 text-[var(--text-tertiary)]'
                : confirming
                  ? 'bg-warning text-surface-0 hover:brightness-110 active:scale-95'
                  : 'bg-accent text-surface-0 hover:bg-accent-hover active:scale-95',
            )}
          >
            {confirming ? 'Confirm' : 'Add'} <CornerDownLeft size={12} />
          </button>
        </div>

        {value && (
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            {parsed.itemName && (
              <Pill tone="default">
                <span className="max-w-[140px] truncate">{parsed.itemName}</span>
              </Pill>
            )}
            {tooLarge ? (
              <Pill tone="warning">Amount too large</Pill>
            ) : amount !== null ? (
              <Pill tone={confirming ? 'warning' : 'accent'}>{fmt(amount)}</Pill>
            ) : (
              <Pill tone="warning">add amount</Pill>
            )}
            {confirming && (
              <Pill tone="warning">
                <AlertTriangle size={10} /> Large amount — confirm to add
              </Pill>
            )}
            {parsed.suggestedCategory && (
              <Pill tone="info">
                <span
                  className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: colorFromString(parsed.suggestedCategory) }}
                />
                {parsed.suggestedCategory}
              </Pill>
            )}
            {parsedDateLabel && (
              <Pill tone="accent">
                <CalendarDays size={10} /> {parsedDateLabel}
              </Pill>
            )}
          </div>
        )}
        <span role="status" className="sr-only">
          {status}
        </span>
      </div>

      <OverlaySlot open={sheetOpen} idle={false} setOpen={setSheetOpen}>
        <AddExpenseSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          prefill={
            parsed.itemName || parsed.amount
              ? {
                  itemName: parsed.itemName,
                  amount: parsed.amount ?? undefined,
                  category: parsed.suggestedCategory,
                  date: parsed.parsedDate ?? today,
                }
              : undefined
          }
        />
      </OverlaySlot>
    </>
  )
}
