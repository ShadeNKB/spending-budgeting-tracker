import { useEffect, useId, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { Trash2 } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Input } from '../../ui/Input'
import { Button } from '../../ui/Button'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { colorFromString } from '../../lib/analytics'
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
  const categoryLabelId = useId()
  const dateLabelId = useId()
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
    date: string
    notes: string
  }>({
    itemName: '',
    amount: '',
    category: 'Other',
    date: format(new Date(), 'yyyy-MM-dd'),
    notes: '',
  })

  useEffect(() => {
    if (expense) {
      setForm({
        itemName: expense.itemName,
        amount: expense.amount.toString(),
        category: expense.category,
        date: format(parseISO(expense.date), 'yyyy-MM-dd'),
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
    updateExpense(expense.id, {
      itemName: form.itemName.trim(),
      amount,
      category: form.category,
      date: new Date(form.date + 'T12:00:00').toISOString(),
      notes: form.notes.trim() || undefined,
    })
    toast.success('Expense updated')
    onClose()
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
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix="$"
          mono
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && save()}
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
              // A chip like its neighbours (as in AddExpenseSheet): the 12 px label is drawn
              // here, and the native select sits invisibly on top to take the tap. Touch screens
              // floor the select's own text at 16 px (index.css, against iOS focus zoom).
              <div className="relative inline-flex h-[30px] max-w-full items-center rounded-full border border-white/[0.08] bg-surface-2 pl-2.5 pr-6 text-[12px] text-[var(--text-secondary)] focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.18)]">
                <span aria-hidden className="min-w-0 truncate">
                  {categories.slice(8).includes(form.category) ? form.category : 'More…'}
                </span>
                <select
                  aria-label="More categories"
                  value={categories.slice(8).includes(form.category) ? form.category : ''}
                  onChange={(e) => {
                    if (e.target.value) setForm({ ...form, category: e.target.value })
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0"
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

        {/* Date selector — presets + custom picker */}
        {(() => {
          const todayStr = format(new Date(), 'yyyy-MM-dd')
          const editPresets = [
            { label: 'Today', val: todayStr },
            { label: 'Yesterday', val: format(new Date(Date.now() - 864e5), 'yyyy-MM-dd') },
            { label: '2d ago', val: format(new Date(Date.now() - 2 * 864e5), 'yyyy-MM-dd') },
            { label: '3d ago', val: format(new Date(Date.now() - 3 * 864e5), 'yyyy-MM-dd') },
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
                    setForm({ ...form, date: v || format(new Date(), 'yyyy-MM-dd') })
                  }}
                  max={todayStr}
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
