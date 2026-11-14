import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Input } from '../../ui/Input'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { undoAction, useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { addDays, type DayKey } from '../../lib/dates'
import { inSpending, kindOf, type Kind } from '../../lib/kind'
import { entryDay } from '../../lib/ledgerIndex'
import { DatePicker } from '../../ui/DatePicker'
import { shieldKeyGesture } from '../../ui/pressShield'
import {
  actionErrorMessage,
  chosenChipFill,
  deleteUndoId,
  firstInvalidField,
  validateExpenseForm,
  type ExpenseFormErrors,
  type ExpenseFormField,
} from '../entry/expenseForm'
import type { EntryKind } from '../../data/core/types'
import type { Expense } from '../../types'

interface EditForm {
  /** `unknown`: a kind a newer SpendTrack wrote. The sheet leaves it exactly as it is. */
  kind: Kind
  itemName: string
  amount: string
  category: string
  /** The day, `yyyy-MM-dd`. */
  date: DayKey
  notes: string
}

function formFrom(expense: Expense, today: DayKey): EditForm {
  return {
    kind: kindOf(expense),
    itemName: expense.itemName,
    amount: expense.amount.toString(),
    category: expense.category,
    // The day the Ledger lists it under. Every stored entry has one (the store sets aside any
    // whose date can't be read), so `today` only fills in for a bare `Expense` handed in.
    date: entryDay(expense) ?? today,
    notes: expense.notes ?? '',
  }
}

/** What the sheet calls the entry, in its title and in the confirmation of a save. */
const NOUN: Record<Kind, string> = {
  expense: 'Expense',
  income: 'Income',
  refund: 'Refund',
  unknown: 'Entry',
}

/** A mouse or trackpad: the sheet can open with the keyboard already in Item. */
const hasFinePointer = () => window.matchMedia('(pointer: fine)').matches

export function EditExpenseSheet({
  expense,
  onClose,
  returnFocus,
}: {
  expense: Expense | null
  onClose: () => void
  /** Where focus goes on close if the control that opened the sheet is gone (see `Sheet`). */
  returnFocus?: () => HTMLElement | null
}) {
  const categories = useExpenseStore((s) => s.categories)
  const toast = useToast()
  const fmt = useFormatMoney()
  const symbol = useCurrencySymbol()
  const today = useToday()
  const categoryLabelId = useId()
  const dateLabelId = useId()
  const notesId = useId()
  const fields: Record<ExpenseFormField, React.RefObject<HTMLInputElement | null>> = {
    itemName: useRef<HTMLInputElement>(null),
    amount: useRef<HTMLInputElement>(null),
  }
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const [form, setForm] = useState<EditForm>({
    kind: 'expense',
    itemName: '',
    amount: '',
    category: 'Other',
    date: today,
    notes: '',
  })
  const [errors, setErrors] = useState<ExpenseFormErrors>({})
  /** One per opening: the delete confirmation below starts closed every time. */
  const [session, setSession] = useState(0)

  // Fill the form each time an expense is opened, while rendering: an effect would show the
  // previous expense's values for a frame and could land on top of the first keystrokes.
  const [shown, setShown] = useState<Expense | null>(null)
  if (expense !== shown) {
    setShown(expense)
    if (expense) {
      setForm(formFrom(expense, today))
      setErrors({})
      setSession((n) => n + 1)
    }
  }

  const setField = <K extends keyof EditForm>(k: K, v: EditForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (k === 'itemName' || k === 'amount') setErrors((e) => ({ ...e, [k]: undefined }))
  }

  const save = () => {
    if (!expense) return
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
    const before = useExpenseStore.getState().undoStack.at(-1)?.id
    try {
      // Fields sent back unchanged are no edit: an amount-only change keeps the stored date
      // byte for byte, and a new day is stored as that day (P2-2). Empty notes clear them.
      useExpenseStore.getState().updateExpense(expense.id, {
        itemName: form.itemName.trim(),
        amount: parseFloat(form.amount),
        // An expense or a refund has a category to change: income keeps the one it is stored
        // with, so turning it back into an expense finds it there.
        ...(inSpending(form.kind) ? { category: form.category } : {}),
        day: form.date,
        notes: form.notes.trim(),
        // The kind goes only when the switch was moved. The sheet holds the entry as it was
        // when it opened: sent back unchanged, that kind would undo one the other device set
        // meanwhile (or erase a newer version's) on a save that only meant to fix a note.
        ...(form.kind === 'unknown' || form.kind === kindOf(expense) ? {} : { kind: form.kind }),
      })
    } catch (err) {
      // The sheet stays open with the edits, so the owner can fix what the message names.
      toast.error(actionErrorMessage(err))
      return
    }
    // Undo only what this save put on the stack: a save that changed nothing adds no entry, and
    // an older edit of the same expense must not be undone in its name.
    const after = useExpenseStore.getState().undoStack.at(-1)?.id
    const undo =
      after !== before && after?.startsWith(`update-${expense.id}-`) === true ? after : undefined
    toast.success(`${NOUN[form.kind]} updated`, {
      undoId: undo,
      action: undo === undefined ? undefined : undoAction(toast, undo),
    })
    onClose()
  }

  // A held Enter (key repeat) or the Enter that confirms an IME word must not save twice, and the
  // second Enter of a double press never lands where the first one sent focus (pressShield).
  const saveOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.repeat || e.nativeEvent.isComposing) return
    save()
    shieldKeyGesture(e.key)
  }

  // On a phone the sheet keeps these in its footer, above the keyboard (F-071). In the side
  // panel they stay after Notes: a footer there would put Save in the screen's bottom corner,
  // where the "Expense updated" toast then opens under the pointer.
  const actions = (
    <>
      <Button variant="ghost" onClick={onClose} className="flex-1">
        Cancel
      </Button>
      <Button onClick={save} className="flex-1">
        Save changes
      </Button>
    </>
  )

  return (
    <Sheet
      open={!!expense}
      onClose={onClose}
      title={`Edit ${NOUN[form.kind].toLowerCase()}`}
      side={isMobile ? 'bottom' : 'right'}
      width={420}
      returnFocus={returnFocus}
      footer={isMobile ? actions : undefined}
    >
      {/* The sheet scrolls on a phone. WebKit reveals only the caret line of a text field that
          Tab lands on, leaving its frame and ring under the sheet's edge: focus brings the whole
          control, ring included (its scroll-margin), into view. */}
      <div
        onFocus={(e) => {
          e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
        className="flex flex-col gap-4 p-5"
      >
        {form.kind === 'unknown' ? (
          <p className="rounded-xl border border-white/[0.06] bg-surface-2/55 px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            This entry came from a newer version of SpendTrack. It is listed here and left out of
            every total. Update SpendTrack on this device to see it in full.
          </p>
        ) : (
          <div>
            <Segmented<EntryKind>
              label="Kind of entry"
              value={form.kind}
              onChange={(v) => {
                setField('kind', v)
              }}
              size="sm"
              options={[
                { value: 'expense', label: 'Expense' },
                { value: 'income', label: 'Income' },
                { value: 'refund', label: 'Refund' },
              ]}
            />
            {form.kind === 'refund' && (
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                Money back for something you paid for. It comes off its category&apos;s spending.
              </p>
            )}
          </div>
        )}
        <Input
          ref={fields.itemName}
          label="Item"
          value={form.itemName}
          onChange={(e) => setField('itemName', e.target.value)}
          error={errors.itemName}
          // Read as Item mounts, once per opening (the sheet mounts its content as it opens).
          autoFocus={hasFinePointer()}
          enterKeyHint="done"
          onKeyDown={saveOnEnter}
        />
        <Input
          ref={fields.amount}
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix={symbol}
          mono
          value={form.amount}
          onChange={(e) => setField('amount', e.target.value)}
          error={errors.amount}
          enterKeyHint="done"
          onKeyDown={saveOnEnter}
        />

        {inSpending(form.kind) && (
          <div className="flex flex-col gap-1.5">
            <span
              id={categoryLabelId}
              className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
            >
              Category
            </span>
            {/* 36 px chips 8 px apart: each gets a 44 px hit area on touch, none overlapping. */}
            <div role="group" aria-labelledby={categoryLabelId} className="flex flex-wrap gap-2">
              {categories.slice(0, 8).map((c) => {
                const selected = form.category === c
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setField('category', selected ? 'Other' : c)}
                    className={`tap-target inline-flex h-9 items-center gap-1 rounded-full border px-3 text-[12px] font-medium transition ${
                      selected
                        ? 'border-transparent text-surface-0'
                        : 'border-white/[0.08] text-[var(--text-secondary)] hover:text-white'
                    }`}
                    style={selected ? { background: chosenChipFill(c) } : undefined}
                  >
                    {c}
                  </button>
                )
              })}
              {categories.length > 8 && (
                // A chip like its neighbours (as in AddExpenseSheet): the 12 px label is drawn
                // here, and the native select sits invisibly on top to take the tap (8 px taller
                // on touch: a 44 px target). Touch screens floor the select's own text at 16 px
                // (index.css, against iOS focus zoom). The chip draws the select's focus ring.
                <div className="field-focus relative inline-flex h-9 max-w-full items-center rounded-full border border-white/[0.08] bg-surface-2 pl-3 pr-6 text-[12px] text-[var(--text-secondary)]">
                  <span aria-hidden className="min-w-0 truncate">
                    {categories.slice(8).includes(form.category) ? form.category : 'More…'}
                  </span>
                  <select
                    aria-label="More categories"
                    value={categories.slice(8).includes(form.category) ? form.category : ''}
                    onChange={(e) => {
                      if (e.target.value) setField('category', e.target.value)
                    }}
                    className="field-control absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0 [@media(pointer:coarse)]:-inset-y-1 [@media(pointer:coarse)]:h-auto"
                  >
                    <option value="">More…</option>
                    {categories.slice(8).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Date selector — presets + custom picker */}
        {(() => {
          // Calendar days, not 24 h steps: the day after a DST change is 23 or 25 hours long.
          const editPresets = [
            { label: 'Today', val: today },
            { label: 'Yesterday', val: addDays(today, -1) },
            { label: '2d ago', val: addDays(today, -2) },
            { label: '3d ago', val: addDays(today, -3) },
          ]
          const editIsPreset = editPresets.some((p) => p.val === form.date)
          return (
            <div className="flex flex-col gap-2">
              <span
                id={dateLabelId}
                className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
              >
                Date
              </span>
              <div
                role="group"
                aria-labelledby={dateLabelId}
                className="flex flex-wrap items-center gap-2"
              >
                {editPresets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={form.date === p.val}
                    onClick={() => setField('date', p.val)}
                    className={`tap-target inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition ${
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
                    setField('date', v || today)
                  }}
                  max={today}
                  placeholder="Pick date"
                  active={!editIsPreset}
                />
              </div>
            </div>
          )
        })()}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={notesId}
            className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
          >
            Notes
          </label>
          <textarea
            id={notesId}
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            placeholder="Any extra detail"
            rows={2}
            className="resize-none rounded-[10px] border border-white/[0.06] bg-surface-2 px-3 py-2.5 text-[14px] text-white [color-scheme:dark] placeholder:text-[var(--text-tertiary)]"
          />
        </div>

        {!isMobile && <div className="flex gap-2 pt-1">{actions}</div>}

        {expense && (
          <DeleteExpense
            key={session}
            expense={expense}
            noun={NOUN[form.kind].toLowerCase()}
            onDeleted={onClose}
          />
        )}
      </div>
    </Sheet>
  )
}

/**
 * "Delete expense" (or income, refund or entry: the sheet's own word for it), then the question in its
 * place. Re-keyed on every opening of the sheet.
 */
function DeleteExpense({
  expense,
  noun,
  onDeleted,
}: {
  expense: Expense
  noun: string
  onDeleted: () => void
}) {
  const toast = useToast()
  const confirm = useInlineConfirm<'delete'>()

  return (
    <div className="border-t border-white/[0.06] pt-3">
      {confirm.pending === 'delete' ? (
        <InlineConfirm
          question={`Delete "${expense.itemName}"?`}
          detail="You can undo it for a few seconds."
          confirmLabel="Delete"
          onConfirm={() => {
            useExpenseStore.getState().deleteExpense(expense.id)
            const undo = deleteUndoId(useExpenseStore.getState().undoStack, expense.id)
            toast.info(`Deleted "${expense.itemName}"`, {
              undoId: undo,
              action: undo === undefined ? undefined : undoAction(toast, undo),
            })
            // The sheet closes and hands focus back itself (to the next row).
            confirm.close(null)
            onDeleted()
          }}
          onCancel={() => confirm.close()}
        />
      ) : (
        <button
          type="button"
          id={confirm.triggerId()}
          onClick={() => confirm.ask('delete')}
          className="tap-target flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-white/[0.06] py-2.5 text-[12px] text-[var(--text-tertiary)] transition hover:border-negative/30 hover:bg-negative/10 hover:text-negative"
        >
          <Trash2 size={13} aria-hidden /> Delete {noun}
        </button>
      )}
    </div>
  )
}
