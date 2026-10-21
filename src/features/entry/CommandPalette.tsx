import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  Activity,
  ListOrdered,
  LineChart,
  Settings2,
  Plus,
  Download,
  Sparkles,
  PenLine,
  X,
  AlertTriangle,
} from 'lucide-react'
import clsx from 'clsx'
import Fuse from 'fuse.js'
import { useUIStore } from '../../stores/useUIStore'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { downloadJSON } from '../../lib/download'
import { format as fmtDate, isValid, parseISO } from 'date-fns'
import { parseExpense, quickAddDateLabel, quickAddStoredDate } from '../../utils/parseExpense'
import {
  CONFIRM_DELAY_MS,
  MAX_AMOUNT,
  isAmountTooLarge,
  isUnusualAmount,
  type AmountConfirmation,
} from '../../utils/amountGuard'
import { useToast } from '../../hooks/useToast'
import { useHaptic } from '../../hooks/useHaptic'
import { useToday } from '../../hooks/useToday'
import { keyToLocalNoon } from '../../lib/dates'
import type { Expense } from '../../types'

type Action = {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  warning?: boolean
  /** Closes the palette itself (quick add, which may wait for a confirming press). */
  selfClosing?: boolean
  /** `at` is the triggering event's timeStamp. */
  onRun: (at: number) => void
}

const EXPENSE_HITS = 6

interface ExpenseIndex {
  readonly fuse: Fuse<Expense>
  /** Row positions of each indexed entry, ascending (the store keeps the newest first). */
  readonly rows: readonly (readonly number[])[]
}

// One search index per expenses array (the store replaces the array on every change), so typing
// searches a ready index instead of rebuilding it per keystroke. Rows that read the same to the
// search (name, category, notes) are indexed once, so the cost follows the number of distinct
// entries rather than the length of the history.
const expenseIndexCache = new WeakMap<readonly Expense[], ExpenseIndex>()

function expenseIndex(expenses: readonly Expense[]): ExpenseIndex {
  const cached = expenseIndexCache.get(expenses)
  if (cached) return cached
  const groups = new Map<string, { first: Expense; rows: number[] }>()
  expenses.forEach((expense, i) => {
    const key = [expense.itemName, expense.category, expense.notes ?? ''].join('\u0000')
    const group = groups.get(key)
    if (group) group.rows.push(i)
    else groups.set(key, { first: expense, rows: [i] })
  })
  const entries = [...groups.values()]
  const index: ExpenseIndex = {
    fuse: new Fuse(
      entries.map((g) => g.first),
      { keys: ['itemName', 'category', 'notes'], threshold: 0.35, includeScore: true },
    ),
    rows: entries.map((g) => g.rows),
  }
  expenseIndexCache.set(expenses, index)
  return index
}

/**
 * The best `limit` expenses for `query`, in exactly the order a full Fuse search over every row
 * gives (score, then list position, newest first): rows of entries that tie on score are merged by
 * position.
 */
function searchExpenses(expenses: readonly Expense[], query: string, limit: number): Expense[] {
  const { fuse, rows } = expenseIndex(expenses)
  const picked: number[] = []
  let tied: number[] = []
  let tiedScore: number | undefined
  const takeTied = () => {
    tied.sort((a, b) => a - b)
    picked.push(...tied.slice(0, limit - picked.length))
    tied = []
  }
  for (const hit of fuse.search(query)) {
    if (hit.score !== tiedScore) {
      takeTied()
      if (picked.length >= limit) break
      tiedScore = hit.score
    }
    tied.push(...(rows[hit.refIndex] ?? []))
  }
  takeTied()
  return picked.flatMap((i) => {
    const expense = expenses[i]
    return expense ? [expense] : []
  })
}

/** A stored date in `pattern`, or null for a row whose date cannot be read. */
function formatStoredDate(date: string, pattern: string): string | null {
  const parsed = parseISO(date)
  return isValid(parsed) ? fmtDate(parsed, pattern) : null
}

export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen)
  const setOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const navigate = useNavigate()
  const expenses = useExpenseStore((s) => s.expenses)
  const categoryMappings = useExpenseStore((s) => s.categoryMappings)
  const categories = useExpenseStore((s) => s.categories)
  const addExpense = useExpenseStore((s) => s.addExpense)
  const exportBackup = useExpenseStore((s) => s.exportBackup)
  const toast = useToast()
  const vibrate = useHaptic()
  const fmt = useFormatMoney()

  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  // Set when a large amount is flagged; running the quick add again on the same query adds it.
  const [flagged, setFlagged] = useState<AmountConfirmation | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set by a quick add, cleared by typing or reopening: a second Enter adds nothing.
  const addedRef = useRef(false)
  const deferredQuery = useDeferredValue(query)
  const today = useToday()

  useEffect(() => {
    if (!open) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setQuery('')
    setActiveIdx(0)
    setFlagged(null)
    addedRef.current = false
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10)

    return () => {
      window.clearTimeout(timer)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [open])

  const parsedQuery = useMemo(
    () => parseExpense(query, categoryMappings, { categories, now: keyToLocalNoon(today) }),
    [query, categoryMappings, categories, today],
  )
  const quickAddAmount =
    parsedQuery.itemName !== '' && parsedQuery.amount !== null && parsedQuery.amount > 0
      ? parsedQuery.amount
      : null
  const tooLarge = quickAddAmount !== null && isAmountTooLarge(quickAddAmount)
  const unusual = quickAddAmount !== null && isUnusualAmount(quickAddAmount, expenses)
  const confirming = flagged?.text === query

  const quickAddAction: Action | null = useMemo(() => {
    if (quickAddAmount === null || tooLarge) return null
    const { itemName, suggestedCategory, parsedDate } = parsedQuery
    const dateLabel = quickAddDateLabel(parsedDate, keyToLocalNoon(today))
    const summary = `"${itemName}" · ${fmt(quickAddAmount)}${dateLabel ? ` · ${dateLabel}` : ''}`

    if (unusual && !confirming) {
      return {
        id: 'quick-add-query',
        label: `Add ${summary}`,
        hint: 'Enter',
        icon: Plus,
        selfClosing: true,
        onRun: (at) => {
          setFlagged({ text: query, at })
          vibrate([10, 60, 10])
        },
      }
    }
    return {
      id: 'quick-add-query',
      label: confirming ? `Confirm large amount: add ${summary}` : `Add ${summary}`,
      hint: 'Enter',
      icon: confirming ? AlertTriangle : Plus,
      warning: confirming,
      selfClosing: true,
      onRun: (at) => {
        // A double tap cannot confirm its own warning.
        if (addedRef.current || (confirming && at - flagged.at < CONFIRM_DELAY_MS)) return
        const created = addExpense({
          itemName,
          amount: quickAddAmount,
          category: suggestedCategory,
          date: quickAddStoredDate(parsedDate),
        })
        addedRef.current = true
        vibrate(10)
        toast.success(
          `Added "${created.itemName}" · ${fmt(created.amount)}${dateLabel ? ` · ${dateLabel}` : ''}`,
        )
        setQuery('')
        setFlagged(null)
        setOpen(false)
      },
    }
  }, [
    addExpense,
    confirming,
    flagged,
    fmt,
    parsedQuery,
    query,
    quickAddAmount,
    setOpen,
    today,
    toast,
    tooLarge,
    unusual,
    vibrate,
  ])

  const actions: Action[] = useMemo(
    () => [
      {
        id: 'add-expense',
        label: 'Add expense',
        hint: 'Ctrl+N',
        icon: PenLine,
        onRun: () => setAddSheetOpen(true),
      },
      { id: 'nav-pulse', label: 'Go to Pulse', icon: Activity, onRun: () => navigate('/pulse') },
      {
        id: 'nav-ledger',
        label: 'Go to Ledger',
        icon: ListOrdered,
        onRun: () => navigate('/ledger'),
      },
      {
        id: 'nav-insights',
        label: 'Go to Insights',
        icon: LineChart,
        onRun: () => navigate('/insights'),
      },
      {
        id: 'settings',
        label: 'Open Settings',
        icon: Settings2,
        onRun: () => setSettingsOpen(true),
      },
      {
        id: 'export',
        label: 'Export backup (JSON)',
        icon: Download,
        onRun: () => {
          downloadJSON(
            `spendtrack-backup-${fmtDate(new Date(), 'yyyy-MM-dd')}.json`,
            exportBackup(),
          )
        },
      },
    ],
    [navigate, setSettingsOpen, setAddSheetOpen, exportBackup],
  )

  const expenseHits = useMemo(
    () => (deferredQuery.length < 2 ? [] : searchExpenses(expenses, deferredQuery, EXPENSE_HITS)),
    [expenses, deferredQuery],
  )

  const filteredActions = useMemo(() => {
    if (quickAddAction) return [quickAddAction, ...actions]
    if (!query) return actions
    const q = query.toLowerCase()
    return actions.filter((a) => a.label.toLowerCase().includes(q))
  }, [actions, query, quickAddAction])

  const totalItems = filteredActions.length + expenseHits.length

  const runAt = (idx: number, at: number) => {
    const action = filteredActions[idx]
    if (action) {
      action.onRun(at)
      if (action.selfClosing) return
    } else {
      const exp = expenseHits[idx - filteredActions.length]
      if (exp) {
        const day = formatStoredDate(exp.date, 'yyyy-MM-dd')
        const search = `q=${encodeURIComponent(exp.itemName)}`
        void navigate(day ? `/ledger?date=${day}&${search}` : `/ledger?${search}`)
      }
    }
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(totalItems - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat || e.nativeEvent.isComposing) return
      if (totalItems > 0) runAt(activeIdx, e.timeStamp)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            className="fixed inset-x-0 bottom-0 z-[91] mx-auto max-h-[88dvh] overflow-hidden rounded-t-2xl border border-white/[0.08] bg-surface-1 shadow-[var(--shadow-overlay)] md:inset-x-4 md:bottom-auto md:top-[12vh] md:max-w-[560px] md:rounded-2xl"
            onKeyDown={onKey}
          >
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
              <Search size={14} className="text-[var(--text-tertiary)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  addedRef.current = false
                  setFlagged(null)
                  setQuery(e.target.value)
                  setActiveIdx(0)
                }}
                placeholder="Search actions, expenses, or quick-add..."
                className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-[var(--text-tertiary)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    setFlagged(null)
                    inputRef.current?.focus()
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white"
                  aria-label="Clear command search"
                >
                  <X size={14} />
                </button>
              )}
              <kbd className="rounded border border-white/[0.06] bg-surface-2 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                ESC
              </kbd>
            </div>

            <div className="max-h-[58dvh] overflow-y-auto py-1 md:max-h-[50vh]">
              {tooLarge && (
                <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-warning">
                  <AlertTriangle size={15} />
                  <span className="flex-1">
                    Amount too large: {fmt(quickAddAmount)} is over the {fmt(MAX_AMOUNT)} limit
                  </span>
                </div>
              )}

              {filteredActions.length > 0 && (
                <div>
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                    Actions
                  </div>
                  {filteredActions.map((a, i) => {
                    const Icon = a.icon
                    const active = i === activeIdx
                    return (
                      <button
                        type="button"
                        key={a.id}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={(e) => runAt(i, e.timeStamp)}
                        className={clsx(
                          'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition',
                          a.warning
                            ? 'bg-warning/10 text-warning'
                            : active
                              ? 'bg-surface-2 text-white'
                              : 'text-[var(--text-secondary)]',
                        )}
                      >
                        <Icon
                          size={15}
                          className={a.warning ? 'text-warning' : active ? 'text-accent' : ''}
                        />
                        <span className="flex-1">{a.label}</span>
                        {a.hint && (
                          <kbd className="rounded border border-white/[0.06] bg-surface-3 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                            {a.hint}
                          </kbd>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}

              {expenseHits.length > 0 && (
                <div className="mt-1">
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                    Expenses
                  </div>
                  {expenseHits.map((e, i) => {
                    const idx = filteredActions.length + i
                    const active = idx === activeIdx
                    return (
                      <button
                        type="button"
                        key={e.id}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={(ev) => runAt(idx, ev.timeStamp)}
                        className={clsx(
                          'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition',
                          active ? 'bg-surface-2' : '',
                        )}
                      >
                        <Sparkles size={14} className="text-[var(--text-tertiary)]" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-white">{e.itemName}</div>
                          <div className="text-[11px] text-[var(--text-tertiary)]">
                            {e.category} / {formatStoredDate(e.date, 'MMM d') ?? 'Unknown date'}
                          </div>
                        </div>
                        <span className="font-mono text-[13px] tabular-nums text-white">
                          {fmt(e.amount)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              {totalItems === 0 && !tooLarge && (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-tertiary)]">
                  No matches - try an action or expense like{' '}
                  <span className="text-white">coffee 4.50</span>
                </div>
              )}
            </div>

            <span role="status" className="sr-only">
              {confirming && quickAddAmount !== null
                ? `Large amount, ${fmt(quickAddAmount)}. Choose it again to add it.`
                : ''}
            </span>

            <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2 text-[11px] text-[var(--text-tertiary)]">
              <span className="inline-flex items-center gap-1.5">
                <Plus size={11} /> Type to add fast
              </span>
              <span className="inline-flex items-center gap-2">
                <kbd className="rounded border border-white/[0.06] bg-surface-2 px-1.5 py-0.5 text-[10px]">
                  Enter
                </kbd>
                run
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
