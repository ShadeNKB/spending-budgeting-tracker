import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, CornerDownLeft, X, CalendarDays, PenLine } from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'
import { parseExpense } from '../../utils/parseExpense'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useHaptic } from '../../hooks/useHaptic'
import { Pill } from '../../ui/Pill'
import { colorFromString } from '../../lib/analytics'

const AddExpenseSheet = lazy(() =>
  import('./AddExpenseSheet').then((m) => ({ default: m.AddExpenseSheet })),
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
  const [sheetOpen, setSheetOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const addExpense = useExpenseStore((s) => s.addExpense)
  const categoryMappings = useExpenseStore((s) => s.categoryMappings)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const vibrate = useHaptic()

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const parsed = useMemo(() => parseExpense(value, categoryMappings), [value, categoryMappings])
  const canCommit = Boolean(parsed.itemName && parsed.amount && parsed.amount > 0)

  const today = format(new Date(), 'yyyy-MM-dd')
  const parsedDateLabel =
    parsed.parsedDate && parsed.parsedDate !== today
      ? format(new Date(parsed.parsedDate + 'T12:00:00'), 'MMM d')
      : null

  const commit = () => {
    if (!canCommit) return
    const created = addExpense({
      itemName: parsed.itemName,
      amount: parsed.amount!,
      category: parsed.suggestedCategory,
      date: parsed.parsedDate ? new Date(parsed.parsedDate + 'T12:00:00').toISOString() : undefined,
    })
    vibrate(10)
    toast.success(
      `${parsedDateLabel ? `${parsedDateLabel} / ` : ''}Added "${created.itemName}" - $${created.amount.toFixed(2)}`,
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
    onCommit?.()
  }

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
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setValue('')
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
              onClick={() => setValue('')}
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
            onClick={commit}
            disabled={!canCommit}
            className={clsx(
              'inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition',
              canCommit
                ? 'bg-accent text-surface-0 hover:bg-accent-hover active:scale-95'
                : 'cursor-not-allowed bg-surface-2 text-[var(--text-tertiary)]',
            )}
          >
            Add <CornerDownLeft size={12} />
          </button>
        </div>

        {value && (
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            {parsed.itemName && (
              <Pill tone="default">
                <span className="max-w-[140px] truncate">{parsed.itemName}</span>
              </Pill>
            )}
            {parsed.amount != null && parsed.amount > 0 ? (
              <Pill tone="accent">${parsed.amount.toFixed(2)}</Pill>
            ) : (
              <Pill tone="warning">add amount</Pill>
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
              <Pill tone="default">
                <CalendarDays size={10} /> {parsedDateLabel}
              </Pill>
            )}
          </div>
        )}
      </div>

      <Suspense fallback={null}>
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
      </Suspense>
    </>
  )
}
