import { isToday, isYesterday, parseISO, format } from 'date-fns'
import type { Expense } from '../../types'

/**
 * Day-header label shared by the grouped and windowed ledger views so the two
 * never drift. Today/Yesterday for the two most recent days, else `EEE / MMM d`.
 */
export function ledgerHeaderLabel(date: string): string {
  const d = parseISO(date)
  return isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEE / MMM d')
}

export interface LedgerGroup {
  date: string
  items: Expense[]
  total: number
}

export type FlatLedgerItem =
  | { kind: 'header'; date: string; total: number }
  | { kind: 'row'; expense: Expense }

/**
 * Flatten day-grouped ledger entries into a single stream of header + row items
 * for windowed rendering. Each group contributes one header followed by its
 * rows, preserving order. Pure + DOM-free so it's unit-testable.
 */
export function flattenLedgerGroups(groups: LedgerGroup[]): FlatLedgerItem[] {
  const out: FlatLedgerItem[] = []
  for (const g of groups) {
    out.push({ kind: 'header', date: g.date, total: g.total })
    for (const e of g.items) out.push({ kind: 'row', expense: e })
  }
  return out
}
