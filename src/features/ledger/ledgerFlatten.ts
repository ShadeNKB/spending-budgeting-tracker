import {
  addDays,
  keyYear,
  shortDate,
  shortDateYear,
  weekdayShort,
  type DayKey,
} from '../../lib/dates'
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
 */
export function filterLedgerRows(
  index: LedgerIndex,
  rows: readonly number[],
  { category, search }: { category: string; search: string },
): number[] {
  const q = search.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (category === 'all' || index.expenses[r]?.category === category) &&
      (q === '' || index.searchText(r).includes(q)),
  )
}

export interface LedgerGroup {
  /** The day, or `null` for rows whose date cannot be read. */
  key: DayKey | null
  label: string
  rowDateLabel: string
  items: Expense[]
  total: number
}

/**
 * Group already-ordered index rows (newest day first, unreadable dates last) into day sections
 * in one pass, with totals summed in cents.
 */
export function groupLedgerRows(
  index: LedgerIndex,
  rows: readonly number[],
  today: DayKey,
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
      }
      groups.push(group)
      current = { group, cents: 0 }
    }
    current.group.items.push(expense)
    current.cents += index.cents[r] ?? 0
  }
  if (current) current.group.total = current.cents / 100
  return groups
}

export type FlatLedgerItem =
  | { kind: 'header'; id: string; key: DayKey | null; label: string; total: number }
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
    })
    for (const e of g.items) {
      out.push({ kind: 'row', id: `r:${e.id}`, expense: e, dateLabel: g.rowDateLabel })
    }
  }
  return out
}
