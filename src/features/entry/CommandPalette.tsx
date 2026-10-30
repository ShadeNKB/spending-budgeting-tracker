import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { holdScrollLock, useModalLayer } from '../../ui/modalLayer'
import { LayerAnnouncer } from '../../ui/LayerAnnouncer'
import { useHeldWhileClosing, usePresence } from '../../ui/usePresence'
import { announce, retract } from '../../ui/announce'
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

/**
 * Every option: 44 px tall. The active one (`aria-selected`: what Enter runs) carries a bar in
 * the focus colour down its left edge, 3:1 and more against the option and the list in both
 * themes, whatever the option's own tone (the amber large-amount one too). Its tint is extra.
 */
const OPTION =
  'relative flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm transition before:absolute before:inset-y-1.5 before:left-0 before:hidden before:w-[3px] before:rounded-r-full before:bg-[var(--focus-ring)] aria-selected:before:block'

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
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Set by a quick add, cleared by typing or reopening: a second Enter adds nothing.
  const addedRef = useRef(false)
  const deferredQuery = useDeferredValue(query)
  const today = useToday()
  const listboxId = useId()

  // Each open starts empty. Reset while rendering, so the last query never shows for a frame.
  const [openSeen, setOpenSeen] = useState(open)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setFlagged(null)
    }
  }
  useEffect(() => {
    if (open) addedRef.current = false
  }, [open])

  const close = () => {
    setOpen(false)
  }
  useModalLayer(open, {
    ref: dialogRef,
    onEscape: close,
    initialFocus: () => inputRef.current,
  })
  const { mounted, state } = usePresence(open, {
    parts: () => [backdropRef.current, dialogRef.current],
  })

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
  // The expense search runs a render behind the typing (deferred). Until it has caught up, an
  // empty list only means "not searched yet": never say "No matches" for it.
  const searched = deferredQuery === query
  // Never stale: the option the input points at is always one that is on screen.
  const activeIndex = totalItems === 0 ? -1 : Math.max(0, Math.min(activeIdx, totalItems - 1))
  const optionId = (idx: number): string => {
    const action = filteredActions[idx]
    if (action) return `${listboxId}-action-${action.id}`
    const expense = expenseHits[idx - filteredActions.length]
    return `${listboxId}-expense-${expense?.id ?? String(idx)}`
  }
  const activeId = activeIndex === -1 ? undefined : optionId(activeIndex)

  // Keep the active option in view inside the list (it scrolls on its own; the page is locked).
  useEffect(() => {
    const list = listRef.current
    const option = activeId === undefined ? null : document.getElementById(activeId)
    if (!list || !option) return
    const box = list.getBoundingClientRect()
    const rect = option.getBoundingClientRect()
    if (rect.top < box.top) list.scrollTop -= box.top - rect.top
    else if (rect.bottom > box.bottom) list.scrollTop += rect.bottom - box.bottom
  }, [activeId])

  const tooLargeText = tooLarge
    ? `Amount too large: ${fmt(quickAddAmount)} is over the ${fmt(MAX_AMOUNT)} limit`
    : ''
  const status = confirming
    ? `Large amount, ${fmt(quickAddAmount ?? 0)}. Choose it again to add it.`
    : tooLarge
      ? tooLargeText
      : totalItems === 0 && searched
        ? 'No matches'
        : ''
  // Spoken through the palette's own live region (LayerAnnouncer), the one inside the dialog,
  // and taken back from it as soon as it no longer holds (results arrived, the query changed).
  useEffect(() => {
    if (!open || !status) return
    announce(status)
    return () => {
      retract(status)
    }
  }, [open, status])

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

  // Enter runs the option the input announces, and only from the input: Tab to Clear then
  // Enter clears instead of running whatever was highlighted.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(Math.min(totalItems - 1, activeIndex + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(Math.max(0, activeIndex - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat || e.nativeEvent.isComposing) return
      if (activeIndex !== -1) runAt(activeIndex, e.timeStamp)
    }
  }

  const optionProps = (idx: number) => ({
    id: optionId(idx),
    role: 'option' as const,
    'aria-selected': idx === activeIndex ? true : undefined,
    tabIndex: -1,
    // The input keeps focus (and the keyboard stays up on a phone) while an option is pressed.
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault()
    },
    onMouseMove: () => {
      if (idx !== activeIndex) setActiveIdx(idx)
    },
    onClick: (e: React.MouseEvent) => {
      runAt(idx, e.timeStamp)
    },
    // Reached by a screen reader's own cursor only (options are never tab stops).
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault()
        runAt(idx, e.timeStamp)
      }
    },
  })

  const actionsLabelId = `${listboxId}-actions`
  const expensesLabelId = `${listboxId}-expenses`

  // What the palette shows. Closing, it keeps showing it: a quick add clears the query and adds
  // a row as the palette leaves, and the leaving palette must not flash the action list.
  const content = useHeldWhileClosing(
    open,
    <>
      <div className="field-focus focus-inset flex items-center gap-2 border-b border-white/[0.06] px-4">
        <Search size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search actions and expenses, or quick add"
          aria-expanded={totalItems > 0}
          aria-controls={totalItems > 0 ? listboxId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => {
            addedRef.current = false
            setFlagged(null)
            setQuery(e.target.value)
            setActiveIdx(0)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Search actions, expenses, or quick-add..."
          className="field-control h-11 min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-[var(--text-tertiary)]"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setFlagged(null)
              setActiveIdx(0)
              inputRef.current?.focus()
            }}
            className="tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white"
            aria-label="Clear command search"
          >
            <X size={14} aria-hidden />
          </button>
        )}
        <kbd
          aria-hidden
          className="shrink-0 rounded border border-white/[0.06] bg-surface-2 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]"
        >
          ESC
        </kbd>
      </div>

      {tooLarge && (
        <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-warning">
          <AlertTriangle size={15} aria-hidden />
          <span className="flex-1">{tooLargeText}</span>
        </div>
      )}

      {totalItems > 0 && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Results"
          className="max-h-[58dvh] overflow-y-auto py-1 md:max-h-[50vh]"
        >
          {filteredActions.length > 0 && (
            <div role="group" aria-labelledby={actionsLabelId}>
              <div
                id={actionsLabelId}
                aria-hidden
                className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
              >
                Actions
              </div>
              {filteredActions.map((a, i) => {
                const Icon = a.icon
                const active = i === activeIndex
                return (
                  <div
                    key={a.id}
                    {...optionProps(i)}
                    className={clsx(
                      OPTION,
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
                  </div>
                )
              })}
            </div>
          )}

          {expenseHits.length > 0 && (
            <div role="group" aria-labelledby={expensesLabelId} className="mt-1">
              <div
                id={expensesLabelId}
                aria-hidden
                className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
              >
                Expenses
              </div>
              {expenseHits.map((e, i) => {
                const idx = filteredActions.length + i
                return (
                  <div
                    key={e.id}
                    {...optionProps(idx)}
                    className={clsx(OPTION, idx === activeIndex && 'bg-surface-2')}
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
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Held in place but hidden while the search catches up: no flash of "No matches",
          and no jump in the palette's height. */}
      {totalItems === 0 && !tooLarge && (
        <div
          className={clsx(
            'px-4 py-8 text-center text-sm text-[var(--text-tertiary)]',
            !searched && 'invisible',
          )}
        >
          No matches - try an action or expense like <span className="text-white">coffee 4.50</span>
        </div>
      )}

      <div
        aria-hidden
        className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2 text-[11px] text-[var(--text-tertiary)]"
      >
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
    </>,
  )

  // Drawn like a sheet (Sheet.tsx): one box at the level all layers share, portaled to the end
  // of <body> as it opens, so whichever opened last covers the rest (Ctrl+K over the Add sheet,
  // Ctrl+N over the palette), and closing, it lets a new tap through while it animates out (the
  // rest of the press that ran an option is swallowed: pressShield.ts). Motion is CSS
  // (index.css, "Overlay motion") keyed on the box's data-state; page scroll stays locked while
  // the box is in the page, its exit included (holdScrollLock).
  return createPortal(
    mounted && (
      <div
        ref={holdScrollLock}
        data-state={state}
        className="fixed inset-0 z-[96] [&:has(>[inert])]:pointer-events-none"
      >
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="palette-backdrop fixed inset-0 bg-black/60 backdrop-blur-sm"
          onClick={close}
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabIndex={-1}
          className="palette-panel fixed inset-x-0 bottom-0 mx-auto max-h-[88dvh] overflow-hidden rounded-t-2xl border border-white/[0.08] bg-surface-1 shadow-[var(--shadow-overlay)] motion-reduce:!transform-none md:inset-x-4 md:bottom-auto md:top-[12vh] md:max-w-[560px] md:rounded-2xl"
        >
          {content}
          <LayerAnnouncer />
        </div>
      </div>
    ),
    document.body,
  )
}
