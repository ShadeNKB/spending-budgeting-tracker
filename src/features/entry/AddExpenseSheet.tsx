import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { CalendarDays, ChevronDown } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Input } from '../../ui/Input'
import { Button } from '../../ui/Button'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useHaptic } from '../../hooks/useHaptic'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { addDays, formatKey, keyYear, shortDate, shortDateYear, type DayKey } from '../../lib/dates'
import { DatePicker } from '../../ui/DatePicker'
import {
  chosenChipFill,
  firstInvalidField,
  validateExpenseForm,
  type ExpenseFormErrors,
  type ExpenseFormField,
} from './expenseForm'

interface Props {
  open: boolean
  onClose: () => void
  prefill?: { itemName?: string; amount?: number; category?: string; date?: string }
}

function formFrom(prefill: Props['prefill'], today: string) {
  return {
    itemName: prefill?.itemName ?? '',
    amount: prefill?.amount ? String(prefill.amount) : '',
    category: prefill?.category ?? '',
    date: prefill?.date ?? today,
    notes: '',
  }
}

export function AddExpenseSheet({ open, onClose, prefill }: Props) {
  const categories = useExpenseStore((s) => s.categories)
  const addExpense = useExpenseStore((s) => s.addExpense)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const vibrate = useHaptic()
  const fmt = useFormatMoney()
  const symbol = useCurrencySymbol()
  const categoryLabelId = useId()
  const fields: Record<ExpenseFormField, React.RefObject<HTMLInputElement | null>> = {
    itemName: useRef<HTMLInputElement>(null),
    amount: useRef<HTMLInputElement>(null),
  }

  const today = useToday()
  // "Oct 17", or "Dec 31, 2025" for another year — read from the key, never through `new Date(key)`
  // (UTC midnight, the day before west of UTC).
  const dayLabel = (day: DayKey) =>
    keyYear(day) === keyYear(today) ? shortDate(day) : shortDateYear(day)

  const [form, setForm] = useState(() => formFrom(prefill, today))
  const [errors, setErrors] = useState<ExpenseFormErrors>({})

  // Refill the form each time the sheet opens (SmartInput passes what was typed as a prefill),
  // and only then: refilling on later prefill or date changes would wipe what the user typed.
  // Done while rendering, not in an effect. The sheet often mounts already open (on its first
  // tap, once its chunk has loaded), and an effect after that render runs once the form is on
  // screen, where it could wipe the first keystrokes.
  const [openSeen, setOpenSeen] = useState(open)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (open) {
      setForm(formFrom(prefill, today))
      setErrors({})
    }
  }

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (k === 'itemName' || k === 'amount') setErrors((e) => ({ ...e, [k]: undefined }))
  }

  const submit = () => {
    const errs = validateExpenseForm(form, fmt)
    const invalid = firstInvalidField(errs)
    if (invalid) {
      // Mark the fields first, so the focused one is announced with its error.
      flushSync(() => {
        setErrors(errs)
      })
      fields[invalid].current?.focus()
      return
    }
    const created = addExpense({
      itemName: form.itemName.trim(),
      amount: parseFloat(form.amount),
      category: form.category || undefined,
      date: new Date(form.date + 'T12:00:00').toISOString(),
      notes: form.notes.trim() || undefined,
    })
    vibrate(10)
    const isBackdated = form.date !== today
    toast.success(
      `Added "${created.itemName}" · ${fmt(created.amount)}${isBackdated ? ` · ${dayLabel(form.date)}` : ''}`,
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
    setForm({ itemName: '', amount: '', category: '', date: today, notes: '' })
    onClose()
  }

  // A held Enter (key repeat) or the Enter that confirms an IME word must not add a second row.
  const submitOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) submit()
  }

  const isBackdated = form.date && form.date !== today

  // Calendar days, not 24 h steps: the day after a DST change is 23 or 25 hours long.
  const presets = [
    { id: 'today', label: 'Today', val: today },
    { id: 'yesterday', label: 'Yesterday', val: addDays(today, -1) },
    { id: '-2', label: '2d ago', val: addDays(today, -2) },
    { id: '-3', label: '3d ago', val: addDays(today, -3) },
  ]
  const isPreset = presets.some((p) => p.val === form.date)
  const isCustomActive = !isPreset

  return (
    <Sheet open={open} onClose={onClose} title="Add expense" side="bottom">
      {/* WebKit reveals only the caret line of a text field when the sheet itself scrolls:
          focus brings the whole control, ring included (its scroll-margin), into view. */}
      <div
        onFocus={(e) => {
          e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
        className="flex flex-col gap-3 px-4 pb-6 pt-2"
      >
        {/* Date selector. The presets wrap rather than scroll, as in the Edit sheet: every one
            stays in sight on a narrow phone ("Pick date" drops to a second row). 36 px pills
            8 px apart, so their 44 px touch areas meet without overlapping, row to row too. */}
        <div role="group" aria-label="Date" className="flex flex-wrap items-center gap-2">
          {presets.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={form.date === p.val}
              onClick={() => set('date', p.val)}
              className={`tap-target inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition ${
                form.date === p.val
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
          {/* The calendar opens on the entry's day, a preset's too ("Pick date" then). */}
          <DatePicker
            variant="pill"
            value={form.date}
            onChange={(v) => {
              set('date', v || today)
            }}
            max={today}
            placeholder="Pick date"
            active={isCustomActive}
          />
        </div>

        {isBackdated && (
          <div className="flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-accent">
            <CalendarDays size={12} />
            Logging for{' '}
            {formatKey(
              form.date,
              keyYear(form.date) === keyYear(today) ? 'EEEE, MMMM d' : 'EEEE, MMMM d, yyyy',
            )}
          </div>
        )}

        <Input
          ref={fields.itemName}
          label="What"
          placeholder="e.g. Coffee, Grab, Spotify"
          value={form.itemName}
          onChange={(e) => set('itemName', e.target.value)}
          error={errors.itemName}
          autoFocus
          onKeyDown={submitOnEnter}
        />

        <Input
          ref={fields.amount}
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix={symbol}
          mono
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => set('amount', e.target.value)}
          error={errors.amount}
          onKeyDown={submitOnEnter}
        />

        <div className="flex flex-col gap-1.5">
          <span
            id={categoryLabelId}
            className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
          >
            Category
          </span>
          {/* 36 px chips 8 px apart: each gets a 44 px hit area on touch, none overlapping. */}
          <div role="group" aria-labelledby={categoryLabelId} className="flex flex-wrap gap-2">
            {categories.slice(0, 8).map((c) => (
              <button
                type="button"
                key={c}
                aria-pressed={form.category === c}
                onClick={() => set('category', form.category === c ? '' : c)}
                className={`tap-target inline-flex h-9 items-center gap-1 rounded-full border px-3 text-[12px] font-medium transition ${
                  form.category === c
                    ? 'border-transparent text-surface-0'
                    : 'border-white/[0.08] text-[var(--text-secondary)] hover:text-white'
                }`}
                style={form.category === c ? { background: chosenChipFill(c) } : undefined}
              >
                {c}
              </button>
            ))}
            {categories.length > 8 && (
              // A chip like its neighbours: the 12 px label is drawn here, and the native select
              // sits invisibly on top to take the tap (8 px taller on touch: a 44 px target).
              // Touch screens floor the select's own text at 16 px (index.css, against iOS focus
              // zoom), which would make this chip bigger than the rest. The chip draws the
              // select's focus ring.
              <div className="field-focus relative inline-flex h-9 max-w-full items-center rounded-full border border-white/[0.08] bg-surface-2 pl-3 pr-6 text-[12px] text-[var(--text-secondary)]">
                <span aria-hidden className="min-w-0 truncate">
                  {categories.slice(8).includes(form.category) ? form.category : 'More…'}
                </span>
                <select
                  aria-label="More categories"
                  value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                  className="field-control absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0 [@media(pointer:coarse)]:-inset-y-1 [@media(pointer:coarse)]:h-auto"
                >
                  <option value="">More…</option>
                  {categories.slice(8).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={10}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                />
              </div>
            )}
          </div>
        </div>

        <Input
          label="Notes (optional)"
          placeholder="Any extra detail"
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
        />

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={submit} className="flex-1">
            Add{isBackdated ? ` for ${dayLabel(form.date)}` : ''}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
