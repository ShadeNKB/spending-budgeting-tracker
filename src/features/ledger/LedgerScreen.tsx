import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Filter, Inbox, X, FileDown } from 'lucide-react'
import { downloadCSV } from '../../lib/download'
import { DatePicker } from '../../ui/DatePicker'
import {
  parseISO,
  format,
  isToday,
  isYesterday,
  startOfMonth,
  endOfMonth,
  subDays,
  isWithinInterval,
  startOfDay,
  endOfDay,
  startOfYear,
  endOfYear,
  isValid,
} from 'date-fns'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { Segmented } from '../../ui/Segmented'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Pill } from '../../ui/Pill'
import { EmptyState } from '../../ui/EmptyState'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { SmartInput } from '../entry/SmartInput'
import { LedgerRow } from './LedgerRow'
import { EditExpenseSheet } from './EditExpenseSheet'
import { useToast } from '../../hooks/useToast'
import type { Expense } from '../../types'

type Range = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom'

const isValidYmd = (v: string | null): v is string => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  return isValid(parseISO(v))
}

export function LedgerScreen() {
  const expenses = useExpenseStore((s) => s.expenses)
  const categories = useExpenseStore((s) => s.categories)
  const deleteExpense = useExpenseStore((s) => s.deleteExpense)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const fmt = useFormatMoney()

  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<Expense | null>(null)

  const range = (params.get('range') as Range) ?? 'month'
  const category = params.get('category') ?? 'all'
  const rawSpecificDate = params.get('date')
  const rawCustomStart = params.get('customStart')
  const rawCustomEnd = params.get('customEnd')
  const specificDate = isValidYmd(rawSpecificDate) ? rawSpecificDate : null // yyyy-MM-dd
  const customStart = isValidYmd(rawCustomStart) ? rawCustomStart : ''
  const customEnd = isValidYmd(rawCustomEnd) ? rawCustomEnd : ''
  const [search, setSearch] = useState(params.get('q') ?? '')

  const today = format(new Date(), 'yyyy-MM-dd')

  const setRange = (r: Range) => {
    const n = new URLSearchParams(params)
    n.set('range', r)
    n.delete('date')
    if (r !== 'custom') {
      n.delete('customStart')
      n.delete('customEnd')
    }
    setParams(n, { replace: true })
  }
  const setCustomStart = (v: string) => {
    const n = new URLSearchParams(params)
    n.set('customStart', v)
    setParams(n, { replace: true })
  }
  const setCustomEnd = (v: string) => {
    const n = new URLSearchParams(params)
    n.set('customEnd', v)
    setParams(n, { replace: true })
  }
  const setCategory = (c: string) => {
    const n = new URLSearchParams(params)
    if (c === 'all') n.delete('category')
    else n.set('category', c)
    setParams(n, { replace: true })
  }
  const clearDate = () => {
    const n = new URLSearchParams(params)
    n.delete('date')
    setParams(n, { replace: true })
  }
  const clearAll = () => {
    setSearch('')
    setParams(new URLSearchParams(), { replace: true })
  }

  const filtered = useMemo(() => {
    let arr = [...expenses]
    const now = new Date()
    if (specificDate) {
      arr = arr.filter((e) => format(parseISO(e.date), 'yyyy-MM-dd') === specificDate)
    } else if (range === 'custom') {
      const start = customStart ? startOfDay(parseISO(customStart)) : new Date(0)
      const end = customEnd ? endOfDay(parseISO(customEnd)) : endOfDay(now)
      arr = arr.filter((e) => isWithinInterval(parseISO(e.date), { start, end }))
    } else if (range !== 'all') {
      let start: Date, end: Date
      if (range === 'today') {
        start = startOfDay(now)
        end = endOfDay(now)
      } else if (range === 'week') {
        start = subDays(now, 7)
        end = now
      } else if (range === 'year') {
        start = startOfYear(now)
        end = endOfYear(now)
      } else {
        start = startOfMonth(now)
        end = endOfMonth(now)
      }
      arr = arr.filter((e) => isWithinInterval(parseISO(e.date), { start, end }))
    }
    if (category !== 'all') arr = arr.filter((e) => e.category === category)
    if (search) {
      const q = search.toLowerCase()
      arr = arr.filter(
        (e) =>
          e.itemName.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          e.notes?.toLowerCase().includes(q),
      )
    }
    arr.sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime())
    return arr
  }, [expenses, range, category, search, specificDate, customStart, customEnd])

  const groups = useMemo(() => {
    const m = new Map<string, Expense[]>()
    for (const e of filtered) {
      const key = format(parseISO(e.date), 'yyyy-MM-dd')
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(e)
    }
    return Array.from(m.entries()).map(([date, items]) => ({
      date,
      items,
      total: items.reduce((s, e) => s + e.amount, 0),
    }))
  }, [filtered])

  const totalSum = useMemo(() => filtered.reduce((s, e) => s + e.amount, 0), [filtered])

  const handleDelete = (id: string) => {
    const expense = expenses.find((e) => e.id === id)
    deleteExpense(id)
    if (expense) {
      toast.info(`Deleted "${expense.itemName}"`, {
        action: {
          label: 'Undo',
          onClick: () => {
            const entry = useExpenseStore
              .getState()
              .undoStack.find((u) => u.id.startsWith(`del-${id}`))
            if (entry) consumeUndo(entry.id)
          },
        },
      })
    }
  }

  const escapeCsvField = (value: string | number | undefined) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`

  const handleExportCsv = () => {
    if (filtered.length === 0) return
    const headers = ['Date', 'Item', 'Category', 'Amount', 'Notes']
    const rows = filtered.map((e) =>
      [format(new Date(e.date), 'yyyy-MM-dd'), e.itemName, e.category, e.amount, e.notes]
        .map(escapeCsvField)
        .join(','),
    )
    const csv = [headers.join(','), ...rows].join('\n')
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, csv)
    toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`)
  }

  // Sync search param. Intentionally only depends on `search` — adding `params`
  // / `setParams` to the deps would re-arm the debounce on every URL change
  // and we'd never settle. The latest `params` is captured fresh inside the
  // setTimeout closure when it fires.
  useEffect(() => {
    const t = setTimeout(() => {
      const n = new URLSearchParams(params)
      if (search) n.set('q', search)
      else n.delete('q')
      setParams(n, { replace: true })
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const hasFilters =
    range !== 'month' ||
    category !== 'all' ||
    !!search ||
    !!specificDate ||
    !!(customStart || customEnd)

  // Compute a human-readable date range label for the active filter
  const dateRangeLabel = useMemo(() => {
    const now = new Date()
    if (specificDate) return format(parseISO(specificDate), 'MMM d, yyyy')
    switch (range) {
      case 'today':
        return format(now, 'MMMM d, yyyy')
      case 'week': {
        const weekStart = subDays(now, 6)
        return `${format(weekStart, 'MMM d')} - ${format(now, 'MMM d, yyyy')}`
      }
      case 'month': {
        const ms = startOfMonth(now)
        const me = endOfMonth(now)
        if (now.getDate() === me.getDate()) return format(ms, 'MMMM yyyy')
        return `${format(ms, 'MMM d')} - ${format(now, 'MMM d, yyyy')}`
      }
      case 'year': {
        const ys = startOfYear(now)
        const ye = endOfYear(now)
        return `${format(ys, 'MMM d')} - ${format(ye, 'MMM d, yyyy')}`
      }
      case 'custom': {
        if (customStart && customEnd)
          return `${format(parseISO(customStart), 'MMM d, yyyy')} - ${format(parseISO(customEnd), 'MMM d, yyyy')}`
        if (customStart) return `From ${format(parseISO(customStart), 'MMM d, yyyy')}`
        if (customEnd) return `Until ${format(parseISO(customEnd), 'MMM d, yyyy')}`
        return 'Custom range'
      }
      case 'all':
      default:
        return 'All time'
    }
  }, [range, specificDate, customStart, customEnd])

  return (
    <div className="flex flex-col gap-4">
      <div className="lg:hidden">
        <SmartInput />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-[22px] font-semibold tracking-tight text-white">Ledger</h1>
          <div className="flex items-center gap-2">
            {filtered.length > 0 && (
              <button
                type="button"
                onClick={handleExportCsv}
                title={`Export ${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'} to CSV`}
                aria-label="Export filtered entries to CSV"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white"
              >
                <FileDown size={14} />
              </button>
            )}
            <div className="text-right">
              <div className="font-mono text-[16px] font-semibold tabular-nums text-white">
                {fmt(totalSum)}
              </div>
              <div className="text-[11px] text-[var(--text-tertiary)]">
                {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="no-scrollbar flex-1 overflow-x-auto">
              <Segmented<Range>
                value={range}
                onChange={(v) => setRange(v)}
                size="sm"
                options={[
                  { value: 'today', label: 'Today' },
                  { value: 'week', label: 'Week' },
                  { value: 'month', label: 'Month' },
                  { value: 'year', label: 'Year' },
                  { value: 'all', label: 'All' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
            </div>
          </div>
          {/* Date range label */}
          {range !== 'custom' && (
            <div className="flex items-center gap-1 pl-0.5 text-[11px] text-[var(--text-tertiary)]">
              <span>{dateRangeLabel}</span>
            </div>
          )}

          {range === 'custom' && (
            <div className="flex items-center gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <span className="pl-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  From
                </span>
                <DatePicker
                  variant="input"
                  value={customStart}
                  onChange={setCustomStart}
                  max={customEnd || today}
                  placeholder="Start date"
                />
              </div>
              <div className="mt-4 shrink-0 text-[var(--text-tertiary)]">to</div>
              <div className="flex flex-1 flex-col gap-1">
                <span className="pl-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  To
                </span>
                <DatePicker
                  variant="input"
                  value={customEnd}
                  onChange={setCustomEnd}
                  min={customStart}
                  max={today}
                  placeholder="End date"
                />
              </div>
            </div>
          )}

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                prefix={<Search size={13} />}
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                suffix={
                  search ? (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="text-[var(--text-tertiary)] hover:text-white"
                      aria-label="Clear search"
                    >
                      <X size={13} />
                    </button>
                  ) : undefined
                }
              />
            </div>
            <div className="min-w-0 shrink-0">
              <Select
                label="Filter by category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="max-w-[42vw] sm:w-[160px]"
                aria-label="Filter by category"
              >
                <option value="all">All</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {(specificDate || hasFilters) && (
          <div className="flex flex-wrap items-center gap-2">
            {specificDate && (
              <Pill tone="accent" onClick={clearDate}>
                <Filter size={10} /> {format(parseISO(specificDate), 'MMM d, yyyy')}
                <X size={10} />
              </Pill>
            )}
            {hasFilters && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[11px] text-[var(--text-tertiary)] transition hover:text-white"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={hasFilters ? 'No results for this view' : 'No expenses yet'}
          description={
            hasFilters
              ? 'Try widening the range or clearing filters'
              : 'Use the quick bar above to add your first entry'
          }
          action={hasFilters ? { label: 'Clear filters', onClick: clearAll } : undefined}
          className="mt-4"
        />
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-white/[0.06] bg-surface-1">
          <AnimatePresence initial={false}>
            {groups.map((g) => {
              const d = parseISO(g.date)
              const label = isToday(d)
                ? 'Today'
                : isYesterday(d)
                  ? 'Yesterday'
                  : format(d, 'EEE / MMM d')
              return (
                <motion.section
                  key={g.date}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <header className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-white/[0.05] bg-surface-1/95 px-4 py-2.5 backdrop-blur">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                      {label}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
                      {fmt(g.total)}
                    </span>
                  </header>
                  <ul className="divide-y divide-white/[0.04]">
                    {g.items.map((e) => (
                      <motion.li key={e.id} layout>
                        <LedgerRow expense={e} onEdit={setEditing} onDelete={handleDelete} />
                      </motion.li>
                    ))}
                  </ul>
                </motion.section>
              )
            })}
          </AnimatePresence>
        </div>
      )}

      <EditExpenseSheet expense={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
