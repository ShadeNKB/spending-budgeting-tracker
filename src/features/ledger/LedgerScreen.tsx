import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, Filter, Inbox, X, FileDown } from 'lucide-react'
import { downloadCSV } from '../../lib/download'
import { expensesToCsv } from '../../lib/csv'
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
import { ledgerRange, ledgerRangeLabel, shortDateYear } from '../../lib/dates'
import { getLedgerIndex, rowsInRange, rowsToExpenses } from '../../lib/ledgerIndex'
import { SmartInput } from '../entry/SmartInput'
import { LedgerRow } from './LedgerRow'
import { VirtualLedgerList } from './VirtualLedgerList'
import { filterLedgerRows, groupLedgerRows } from './ledgerFlatten'
import { EditExpenseSheet } from './EditExpenseSheet'
import { useToast } from '../../hooks/useToast'
import { changingNow, shieldGesture, type Change } from '../../ui/pressShield'
import { isRange, isValidYmd, type Range } from './ledgerParams'
import type { Expense } from '../../types'

// Above this many rows, switch from the grouped sticky-header view to a
// windowed list so the DOM stays bounded (anti-pattern: lists >~200 unwindowed).
const VIRTUALIZE_THRESHOLD = 150
/** Typing settles into `?q=` after this pause (and at once on blur). */
const SEARCH_SYNC_MS = 400
/**
 * After a delete, further deletes are ignored until it has been on screen this long: a reflex
 * second tap lands on the row that just slid into place, and must never delete it. Judged by
 * when the press was made, so a busy phone that handles that tap late still ignores it.
 */
const DELETE_GUARD_MS = 450

const ROW = '[data-ledger-row]'

/** The ledger rows on screen, in list order (the virtual list mounts only those near view). */
function mountedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(ROW))
}

/** The ids of the rows after and before `id`: where focus goes if that row disappears. */
function neighboursOf(id: string): string[] {
  const ids = mountedRows().map((row) => row.dataset.ledgerRow)
  const at = ids.indexOf(id)
  if (at < 0) return []
  return [ids[at + 1], ids[at - 1]].filter((n): n is string => n !== undefined)
}

/**
 * Focus without the browser's own jump. A keyboard user's focus (the ring shows) is then
 * scrolled only as far as needed: `nearest` honours the row's scroll margin and the page's
 * scroll padding, which keep it clear of the header and the tab bar. After a tap or click
 * nothing is shown, so nothing is measured or scrolled (a phone's delete stays light).
 */
function focusInView(el: HTMLElement): void {
  el.focus({ preventScroll: true })
  if (el.matches(':focus-visible')) el.scrollIntoView({ block: 'nearest' })
}

/** The row button of the first of `ids` that is still on screen. */
function firstRowButton(ids: readonly string[]): HTMLElement | null {
  const rows = mountedRows()
  for (const id of ids) {
    const row = rows.find((r) => r.dataset.ledgerRow === id)
    const button = row?.querySelector<HTMLElement>('[data-row-main]')
    if (button) return button
  }
  return null
}

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
  const headingRef = useRef<HTMLHeadingElement>(null)
  /** The edited row and its neighbours, for when the editor deletes or moves that row. */
  const editedRows = useRef<string[]>([])
  /** Set when the focused row is deleted: the rows to move focus to, in order. */
  const refocusAfterDelete = useRef<string[] | null>(null)

  const openEditor = useCallback((e: Expense) => {
    editedRows.current = [e.id, ...neighboursOf(e.id)]
    setEditing(e)
  }, [])
  const closeEditor = useCallback(() => {
    setEditing(null)
  }, [])
  // Only asked when the row that opened the editor is gone (deleted, filtered out, or moved to
  // another day, where it is a new element): the row itself, else the one that took its place.
  const editorReturnFocus = useCallback(
    () => firstRowButton(editedRows.current) ?? headingRef.current,
    [],
  )

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

  const lastDelete = useRef<Change | null>(null)
  const handleDelete = useCallback(
    (id: string, at: number) => {
      if (lastDelete.current?.includes({ timeStamp: at }) === true) return
      const expense = useExpenseStore.getState().expenses.find((e) => e.id === id)
      if (!expense) return
      lastDelete.current = changingNow(DELETE_GUARD_MS)
      // The next row slides up under the pointer: the rest of a double tap presses nothing.
      shieldGesture()
      // Focus inside the row (its button after the Delete key, its trash after a click) would
      // fall to <body> with it: carry it to the row that takes its place.
      const focused = document.activeElement
      const focusedRow = focused instanceof HTMLElement ? focused.closest<HTMLElement>(ROW) : null
      if (focusedRow?.dataset.ledgerRow === id) refocusAfterDelete.current = neighboursOf(id)
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

  // After the commit that removed the row: the next row, else the previous, else the heading.
  useEffect(() => {
    const candidates = refocusAfterDelete.current
    if (!candidates) return
    refocusAfterDelete.current = null
    const target = firstRowButton(candidates) ?? headingRef.current
    if (target) focusInView(target)
  })

  const handleExportCsv = () => {
    if (filtered.length === 0) return
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, expensesToCsv(filtered))
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
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-[22px] font-semibold tracking-tight text-white"
          >
            Ledger
          </h1>
          <div className="flex items-center gap-2">
            {filtered.length > 0 && (
              <button
                type="button"
                onClick={handleExportCsv}
                title={`Export ${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'} to CSV`}
                aria-label="Export filtered entries to CSV"
                className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white"
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
            {/* On a narrow phone the six ranges can be wider than the column: the row scrolls
                sideways out to the screen edge (through the page gutter), so the control is never
                cut off in mid-gutter. Under 390 px the options take 2 px less padding a side, so
                it shows whole from 360 px; under 360 px it still scrolls, and its right edge fades
                (over the end padding, so the last option shows whole once scrolled to). The
                arrow keys move focus by script, which browsers do not scroll into a part-hidden
                spot: focus brings the whole option, ring included (its scroll-margin), into
                view, and under 360 px the scroll padding keeps it, ring and all, clear of the
                fade: the last option scrolls all the way to the end. */}
            <div
              onFocus={(e) => {
                e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }}
              data-scroll-x=""
              className="no-scrollbar flex-1 overflow-x-auto max-md:-mx-4 max-md:px-4 max-[359px]:scroll-pr-5 max-[359px]:[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-16px),transparent)] max-[359px]:[mask-image:linear-gradient(to_right,#000_calc(100%-16px),transparent)] max-[389px]:[&_[role=radio]]:px-2.5"
            >
              <Segmented<Range>
                value={tappedRange ?? range}
                onChange={(v) => {
                  setTappedRange(v)
                  setRange(v)
                }}
                size="sm"
                label="Date range"
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
                  label="From"
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
                  label="To"
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
                      // 44 px square, flush with the field's right edge: no hit area over the text.
                      className="-mr-3 inline-flex h-11 w-11 items-center justify-center text-[var(--text-tertiary)] hover:text-white"
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
              <Pill
                tone="accent"
                onClick={clearDate}
                aria-label={`Remove date filter ${shortDateYear(specificDate)}`}
              >
                <Filter size={10} /> {shortDateYear(specificDate)}
                <X size={10} />
              </Pill>
            )}
            {hasFilters && (
              <button
                type="button"
                onClick={clearAll}
                className="tap-target text-[11px] text-[var(--text-tertiary)] transition hover:text-white"
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
        <VirtualLedgerList groups={groups} onEdit={openEditor} onDelete={handleDelete} />
      ) : (
        <div className="elevated overflow-hidden rounded-2xl border border-white/[0.06] bg-surface-1">
          {groups.map((g) => (
            <section key={g.key ?? 'unknown'}>
              <header className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-white/[0.05] bg-surface-2/85 px-4 py-2.5 backdrop-blur">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  {g.label}
                </h2>
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
                      onEdit={openEditor}
                      onDelete={handleDelete}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <EditExpenseSheet expense={editing} onClose={closeEditor} returnFocus={editorReturnFocus} />
    </div>
  )
}
