import {
  addDays,
  keyYear,
  shortDate,
  shortDateYear,
  weekdayShort,
  type DayKey,
} from '../../lib/dates'
import { categoryOf, inSpending, kindOf } from '../../lib/kind'
import type { LedgerIndex } from '../../lib/ledgerIndex'
import type { Expense } from '../../types'

const UNKNOWN_DATE = 'Unknown date'

/**
 * Day-header label shared by the grouped and windowed ledger views so the two never drift:
 * Today / Yesterday, else `EEE / MMM d`, with the year when it is not this year.
 */
export function ledgerHeaderLabel(key: DayKey | null, today: DayKey): string {
  if (key === null) return UNKNOWN_DATE
  if (key === today) return 'Today'
  if (key === addDays(today, -1)) return 'Yesterday'
  const date = keyYear(key) === keyYear(today) ? shortDate(key) : shortDateYear(key)
  return `${weekdayShort(key)} / ${date}`
}

/** The date shown on each row: `MMM d`, with the year when it is not this year. */
export function ledgerRowDateLabel(key: DayKey | null, today: DayKey): string {
  if (key === null) return UNKNOWN_DATE
  return keyYear(key) === keyYear(today) ? shortDate(key) : shortDateYear(key)
}

/**
 * Narrow already-ordered index rows to one category (`'all'` = any) and a search over the name,
 * category and notes. The search ignores case and surrounding spaces ("Kopi" finds "kopi").
 * An expense or a refund is in a category: income is listed under "all" alone.
 */
export function filterLedgerRows(
  index: LedgerIndex,
  rows: readonly number[],
  { category, search }: { category: string; search: string },
): number[] {
  const q = search.trim().toLowerCase()
  return rows.filter((r) => {
    const e = index.expenses[r]
    return (
      (category === 'all' || (e !== undefined && categoryOf(e) === category)) &&
      (q === '' || index.searchText(r).includes(q))
    )
  })
}

export interface LedgerGroup {
  /** The day, or `null` for rows whose date cannot be read. */
  key: DayKey | null
  label: string
  rowDateLabel: string
  items: Expense[]
  total: number
  /**
   * How many refunds the total takes. A day with one shows its figure at zero or below too
   * ("-S$20.00", or "S$0.00" for an expense and its refund); without one a figure shows only
   * above zero, as before refunds.
   */
  refunds: number
}

/**
 * Group already-ordered index rows (newest day first, unreadable dates last) into day sections
 * in one pass, with totals summed in cents. A day's total is its spending, net of the refunds
 * listed under it: an entry in a not-spending category (`aside`, F-057), income, or an entry of
 * a kind this version does not know (F-058) is listed under its day and left out of that day's
 * sum, as it is left out of every other spending total.
 */
export function groupLedgerRows(
  index: LedgerIndex,
  rows: readonly number[],
  today: DayKey,
  aside?: ReadonlySet<string>,
): LedgerGroup[] {
  const groups: LedgerGroup[] = []
  let current: { group: LedgerGroup; cents: number } | null = null
  for (const r of rows) {
    const expense = index.expenses[r]
    if (!expense) continue
    const key = index.dayKeys[r] ?? null
    if (current?.group.key !== key) {
      if (current) current.group.total = current.cents / 100
      const group: LedgerGroup = {
        key,
        label: ledgerHeaderLabel(key, today),
        rowDateLabel: ledgerRowDateLabel(key, today),
        items: [],
        total: 0,
        refunds: 0,
      }
      groups.push(group)
      current = { group, cents: 0 }
    }
    current.group.items.push(expense)
    const kind = kindOf(expense)
    if (inSpending(kind) && aside?.has(expense.category) !== true) {
      current.cents += index.cents[r] ?? 0
      if (kind === 'refund') current.group.refunds += 1
    }
  }
  if (current) current.group.total = current.cents / 100
  return groups
}

/** A day's figure is shown when it has spending to show, or a refund in its sum. */
export const showsDayFigure = (day: { total: number; refunds: number }): boolean =>
  day.total > 0 || day.refunds > 0

/** What the Ledger says above its rows, each in the entries' own unit (not cents). */
export interface LedgerSums {
  /** Spending, net of the refunds listed. */
  total: number
  /** What those refunds took off `total`. */
  refunded: number
  /** Entries in not-spending categories, net of refunds filed there. */
  aside: number
  income: number
  /** Rows of a kind this version does not know. */
  uncounted: number
}

/**
 * The sums over the rows listed: spending net of refunds, as on Pulse; entries of not-spending
 * categories (F-057) and income (F-058) beside it; rows of a kind this version does not know
 * counted, not summed. Together the lines account for every row shown.
 */
export function sumLedgerRows(
  index: LedgerIndex,
  rows: readonly number[],
  aside: ReadonlySet<string>,
): LedgerSums {
  let total = 0
  let refunded = 0
  let asideCents = 0
  let income = 0
  let uncounted = 0
  for (const r of rows) {
    const e = index.expenses[r]
    if (!e) continue
    const c = index.cents[r] ?? 0
    const kind = kindOf(e)
    if (kind === 'income') income += c
    else if (kind === 'unknown') uncounted += 1
    else if (aside.has(e.category)) asideCents += c
    else {
      total += c
      if (kind === 'refund') refunded -= c
    }
  }
  return {
    total: total / 100,
    refunded: refunded / 100,
    aside: asideCents / 100,
    income: income / 100,
    uncounted,
  }
}

export type FlatLedgerItem =
  | {
      kind: 'header'
      id: string
      key: DayKey | null
      label: string
      total: number
      refunds: number
    }
  | { kind: 'row'; id: string; expense: Expense; dateLabel: string }

/**
 * Flatten day-grouped ledger entries into a single stream of header + row items for windowed
 * rendering. Each item carries a stable `id` (`h:<day>` / `r:<expense id>`) so a recycled
 * virtual slot never keeps another row's state. Pure + DOM-free so it's unit-testable.
 */
export function flattenLedgerGroups(groups: readonly LedgerGroup[]): FlatLedgerItem[] {
  const out: FlatLedgerItem[] = []
  for (const g of groups) {
    out.push({
      kind: 'header',
      id: `h:${g.key ?? 'unknown'}`,
      key: g.key,
      label: g.label,
      total: g.total,
      refunds: g.refunds,
    })
    for (const e of g.items) {
      out.push({ kind: 'row', id: `r:${e.id}`, expense: e, dateLabel: g.rowDateLabel })
    }
  }
  return out
}
