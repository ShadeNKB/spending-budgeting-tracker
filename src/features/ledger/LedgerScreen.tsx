import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, Filter, Inbox, X, FileDown } from 'lucide-react'
import { downloadCSV } from '../../lib/download'
import { DatePicker } from '../../ui/DatePicker'
import { format } from 'date-fns'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { Segmented } from '../../ui/Segmented'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Pill } from '../../ui/Pill'
import { EmptyState } from '../../ui/EmptyState'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { dayKeyOfStored, ledgerRange, ledgerRangeLabel, shortDateYear } from '../../lib/dates'
import { getLedgerIndex, rowsInRange, rowsToExpenses } from '../../lib/ledgerIndex'
import { SmartInput } from '../entry/SmartInput'
import { LedgerRow } from './LedgerRow'
import { VirtualLedgerList } from './VirtualLedgerList'
import { filterLedgerRows, groupLedgerRows } from './ledgerFlatten'
import { EditExpenseSheet } from './EditExpenseSheet'
import { useToast } from '../../hooks/useToast'
import { isRange, isValidYmd, type Range } from './ledgerParams'
import type { Expense } from '../../types'

// Above this many rows, switch from the grouped sticky-header view to a
// windowed list so the DOM stays bounded (anti-pattern: lists >~200 unwindowed).
const VIRTUALIZE_THRESHOLD = 150
/** Typing settles into `?q=` after this pause (and at once on blur). */
const SEARCH_SYNC_MS = 400
/**
 * After a delete, further deletes are ignored this long: a reflex second tap lands on the
 * row that just slid into place, and must never delete it.
 */
const DELETE_GUARD_MS = 450

export function LedgerScreen() {
  const expenses = useExpenseStore((s) => s.expenses)
  const categories = useExpenseStore((s) => s.categories)
  const deleteExpense = useExpenseStore((s) => s.deleteExpense)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const fmt = useFormatMoney()
  const today = useToday()
  const navigate = useNavigate()

  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<Expense | null>(null)

  const rawRange = params.get('range')
  const range: Range = isRange(rawRange) ? rawRange : 'month'
  // The tapped range lights up at once; the URL (and the list) follow in the router's
  // transition, which can take a moment on a slow phone with a long list. Any change of the URL
  // range, from a tap or from outside (back, "Clear all filters"), clears it.
  const [tappedRange, setTappedRange] = useState<Range | null>(null)
  const [renderedRange, setRenderedRange] = useState(range)
  if (renderedRange !== range) {
    setRenderedRange(range)
    setTappedRange(null)
  }
  const category = params.get('category') ?? 'all'
  const rawSpecificDate = params.get('date')
  const rawCustomStart = params.get('customStart')
  const rawCustomEnd = params.get('customEnd')
  const specificDate = isValidYmd(rawSpecificDate) ? rawSpecificDate : null // yyyy-MM-dd
  const customStart = isValidYmd(rawCustomStart) ? rawCustomStart : ''
  const customEnd = isValidYmd(rawCustomEnd) ? rawCustomEnd : ''
  const urlQuery = params.get('q') ?? ''
  const [search, setSearch] = useState(urlQuery)
  const deferredSearch = useDeferredValue(search)
  /** The `?q=` value the search box last wrote or adopted. */
  const syncedQuery = useRef(urlQuery)

  // Filters live in the URL. Every write starts from the URL as it is *now* (not the params
  // of the last render), so a debounced search write can never revert a filter tapped while
  // it was pending, even if that tap is still rendering.
  const patchParams = useCallback(
    (patch: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search)
      patch(next)
      void navigate({ search: `?${next.toString()}` }, { replace: true })
    },
    [navigate],
  )

  const setRange = (r: Range) => {
    patchParams((n) => {
      n.set('range', r)
      n.delete('date')
      if (r !== 'custom') {
        n.delete('customStart')
        n.delete('customEnd')
      }
    })
  }
  const setCustomStart = (v: string) => {
    patchParams((n) => {
      n.set('customStart', v)
    })
  }
  const setCustomEnd = (v: string) => {
    patchParams((n) => {
      n.set('customEnd', v)
    })
  }
  const setCategory = (c: string) => {
    patchParams((n) => {
      if (c === 'all') n.delete('category')
      else n.set('category', c)
    })
  }
  const clearDate = () => {
    patchParams((n) => {
      n.delete('date')
    })
  }
  const clearAll = () => {
    syncedQuery.current = ''
    setSearch('')
    setParams(new URLSearchParams(), { replace: true })
  }

  const writeQuery = useCallback(
    (value: string) => {
      syncedQuery.current = value
      patchParams((n) => {
        if (value) n.set('q', value)
        else n.delete('q')
      })
    },
    [patchParams],
  )

  // `?q=` changed from outside (command palette, back/forward): the search box follows it.
  useEffect(() => {
    if (urlQuery === syncedQuery.current) return
    syncedQuery.current = urlQuery
    setSearch(urlQuery)
  }, [urlQuery])

  // Typing settles into the URL after a pause.
  useEffect(() => {
    if (search === syncedQuery.current) return
    const t = setTimeout(() => {
      writeQuery(search)
    }, SEARCH_SYNC_MS)
    return () => {
      clearTimeout(t)
    }
  }, [search, writeQuery])

  const index = getLedgerIndex(expenses)
  const rows = useMemo(
    () =>
      filterLedgerRows(
        index,
        rowsInRange(
          index,
          ledgerRange(range, today, { date: specificDate, customStart, customEnd }),
        ),
        { category, search: deferredSearch },
      ),
    [index, range, today, specificDate, customStart, customEnd, category, deferredSearch],
  )

  const filtered = useMemo(() => rowsToExpenses(index, rows), [index, rows])
  const groups = useMemo(() => groupLedgerRows(index, rows, today), [index, rows, today])
  const totalSum = useMemo(() => {
    let cents = 0
    for (const r of rows) cents += index.cents[r] ?? 0
    return cents / 100
  }, [index, rows])

  const lastDeleteAt = useRef(Number.NEGATIVE_INFINITY)
  const handleDelete = useCallback(
    (id: string) => {
      const now = performance.now()
      if (now - lastDeleteAt.current < DELETE_GUARD_MS) return
      const expense = useExpenseStore.getState().expenses.find((e) => e.id === id)
      if (!expense) return
      lastDeleteAt.current = now
      deleteExpense(id)
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
    },
    [deleteExpense, consumeUndo, toast],
  )

  const escapeCsvField = (value: string | number | undefined) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`

  const handleExportCsv = () => {
    if (filtered.length === 0) return
    const headers = ['Date', 'Item', 'Category', 'Amount', 'Notes']
    const rows = filtered.map((e) =>
      [dayKeyOfStored(e.date) ?? e.date, e.itemName, e.category, e.amount, e.notes]
        .map(escapeCsvField)
        .join(','),
    )
    const csv = [headers.join(','), ...rows].join('\n')
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, csv)
    toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`)
  }

  const hasFilters =
    range !== 'month' ||
    category !== 'all' ||
    !!search ||
    !!specificDate ||
    !!(customStart || customEnd)

  // The label comes from the same definition as the filter, so they cannot disagree.
  const dateRangeLabel = ledgerRangeLabel(range, today, {
    date: specificDate,
    customStart,
    customEnd,
  })

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
                value={tappedRange ?? range}
                onChange={(v) => {
                  setTappedRange(v)
                  setRange(v)
                }}
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
            <div className="flex items-center gap-1 truncate pl-0.5 text-[11px] text-[var(--text-tertiary)]">
              <span className="truncate">{dateRangeLabel}</span>
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
                aria-label="Search expenses"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                }}
                onBlur={() => {
                  if (search !== syncedQuery.current) writeQuery(search)
                }}
                suffix={
                  search ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch('')
                      }}
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
                onChange={(e) => {
                  setCategory(e.target.value)
                }}
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
                <Filter size={10} /> {shortDateYear(specificDate)}
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
      ) : filtered.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualLedgerList groups={groups} onEdit={setEditing} onDelete={handleDelete} />
      ) : (
        <div className="elevated overflow-hidden rounded-2xl border border-white/[0.06] bg-surface-1">
          {groups.map((g) => (
            <section key={g.key ?? 'unknown'}>
              <header className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-white/[0.05] bg-surface-2/85 px-4 py-2.5 backdrop-blur">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  {g.label}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
                  {fmt(g.total)}
                </span>
              </header>
              <ul className="divide-y divide-white/[0.04]">
                {g.items.map((e) => (
                  <li key={e.id}>
                    <LedgerRow
                      expense={e}
                      dateLabel={g.rowDateLabel}
                      onEdit={setEditing}
                      onDelete={handleDelete}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <EditExpenseSheet expense={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
