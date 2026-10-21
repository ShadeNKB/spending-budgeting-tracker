import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Input } from '../../ui/Input'
import { Button } from '../../ui/Button'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { colorFromString } from '../../lib/analytics'
import { addDays, dayKeyOfStored } from '../../lib/dates'
import { MAX_AMOUNT, isAmountTooLarge } from '../../utils/amountGuard'
import { DatePicker } from '../../ui/DatePicker'
import type { Expense } from '../../types'

export function EditExpenseSheet({
  expense,
  onClose,
}: {
  expense: Expense | null
  onClose: () => void
}) {
  const updateExpense = useExpenseStore((s) => s.updateExpense)
  const deleteExpense = useExpenseStore((s) => s.deleteExpense)
  const categories = useExpenseStore((s) => s.categories)
  const toast = useToast()
  const fmt = useFormatMoney()
  const symbol = useCurrencySymbol()
  const today = useToday()
  const categoryLabelId = useId()
  const dateLabelId = useId()
  const dateHintId = useId()
  const notesId = useId()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const [form, setForm] = useState<{
    itemName: string
    amount: string
    category: string
    /** The day; `''` while the stored date cannot be read and no day has been picked. */
    date: string
    notes: string
  }>({
    itemName: '',
    amount: '',
    category: 'Other',
    date: today,
    notes: '',
  })

  useEffect(() => {
    if (expense) {
      setForm({
        itemName: expense.itemName,
        amount: expense.amount.toString(),
        category: expense.category,
        // The row's own day, as every screen reads it. An unreadable date opens with no day
        // chosen, so saving another field never silently moves the entry to today.
        date: dayKeyOfStored(expense.date) ?? '',
        notes: expense.notes ?? '',
      })
    }
  }, [expense])

  const save = () => {
    if (!expense) return
    const amount = parseFloat(form.amount)
    if (!form.itemName.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Item name and a valid amount are required')
      return
    }
    if (isAmountTooLarge(amount)) {
      toast.error(`Amount too large — the limit is ${fmt(MAX_AMOUNT)}`)
      return
    }
    updateExpense(expense.id, {
      itemName: form.itemName.trim(),
      amount,
      category: form.category,
      // No day picked for an unreadable date: keep what is stored.
      ...(form.date ? { date: new Date(form.date + 'T12:00:00').toISOString() } : {}),
      notes: form.notes.trim() || undefined,
    })
    toast.success('Expense updated')
    onClose()
  }

  // A held Enter (key repeat) or the Enter that confirms an IME word must not save twice.
  const saveOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) save()
  }

  return (
    <Sheet
      open={!!expense}
      onClose={onClose}
      title="Edit expense"
      side={isMobile ? 'bottom' : 'right'}
      width={420}
    >
      <div className="flex flex-col gap-4 p-5">
        <Input
          label="Item"
          value={form.itemName}
          onChange={(e) => setForm({ ...form, itemName: e.target.value })}
          autoFocus
          onKeyDown={saveOnEnter}
        />
        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix={symbol}
          mono
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          onKeyDown={saveOnEnter}
        />

        <div className="flex flex-col gap-1.5">
          <span
            id={categoryLabelId}
            className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
          >
            Category
          </span>
          <div role="group" aria-labelledby={categoryLabelId} className="flex flex-wrap gap-1.5">
            {categories.slice(0, 8).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setForm({ ...form, category: form.category === c ? 'Other' : c })}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
                  form.category === c
                    ? 'border-transparent text-surface-0'
                    : 'border-white/[0.08] text-[var(--text-secondary)] hover:text-white'
                }`}
                style={form.category === c ? { background: colorFromString(c) } : undefined}
              >
                {c}
              </button>
            ))}
            {categories.length > 8 && (
              <select
                value={categories.slice(8).includes(form.category) ? form.category : ''}
                onChange={(e) => {
                  if (e.target.value) setForm({ ...form, category: e.target.value })
                }}
                className="h-[30px] appearance-none rounded-full border border-white/[0.08] bg-surface-2 pl-2.5 pr-6 text-[12px] text-[var(--text-secondary)] outline-none"
              >
                <option value="">More…</option>
                {categories.slice(8).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

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
          const dateUnknown = form.date === ''
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
                aria-describedby={dateUnknown ? dateHintId : undefined}
                className="flex flex-wrap items-center gap-2"
              >
                {editPresets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setForm({ ...form, date: p.val })}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                      form.date === p.val
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <DatePicker
                  variant="pill"
                  value={editIsPreset ? '' : form.date}
                  onChange={(v) => {
                    setForm({ ...form, date: v || today })
                  }}
                  max={today}
                  placeholder="Pick date"
                  active={!editIsPreset && !dateUnknown}
                />
              </div>
              {dateUnknown && (
                <p id={dateHintId} className="text-[12px] text-warning">
                  This entry's date can't be read. Pick the day to fix it, or save to keep it under
                  Unknown date.
                </p>
              )}
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
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Any extra detail"
            rows={2}
            className="resize-none rounded-[10px] border border-white/[0.06] bg-surface-2 px-3 py-2.5 text-[14px] text-white outline-none [color-scheme:dark] placeholder:text-[var(--text-tertiary)] focus:border-accent/60"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={save} className="flex-1">
            Save changes
          </Button>
        </div>

        <div className="border-t border-white/[0.06] pt-3">
          {confirmDelete ? (
            <div className="flex flex-col gap-2 rounded-lg border border-negative/30 bg-negative/[0.07] p-3">
              <div className="text-[12px] text-[var(--text-tertiary)]">
                Delete this expense? This cannot be undone.
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (!expense) return
                    deleteExpense(expense.id)
                    toast.info(`Deleted "${expense.itemName}"`)
                    onClose()
                  }}
                  variant="primary"
                  className="flex-1 border-transparent !bg-negative/80 hover:!bg-negative"
                >
                  Delete
                </Button>
                <Button onClick={() => setConfirmDelete(false)} variant="ghost" className="flex-1">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-white/[0.06] py-2.5 text-[12px] text-[var(--text-tertiary)] transition hover:border-negative/30 hover:bg-negative/10 hover:text-negative"
            >
              <Trash2 size={13} /> Delete expense
            </button>
          )}
        </div>
      </div>
    </Sheet>
  )
}
