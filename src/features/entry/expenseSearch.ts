import Fuse from 'fuse.js/basic'
import { filedUnder, kindOf } from '../../lib/kind'
import type { ExpenseView } from '../../types'

interface ExpenseIndex {
  readonly fuse: Fuse<SearchRow>
  /** Row positions of each indexed entry, ascending (the store keeps the newest first). */
  readonly rows: readonly (readonly number[])[]
}

/** What the search reads of an entry: what its row shows (an income is filed under "Income"). */
interface SearchRow {
  readonly itemName: string
  readonly category: string
  readonly notes: string
}
const searchRow = (e: ExpenseView): SearchRow => ({
  itemName: e.itemName,
  // a refund is found by its category and by the word its row carries
  category: kindOf(e) === 'refund' ? `${filedUnder(e)} refund` : filedUnder(e),
  notes: e.notes ?? '',
})

// One search index per expenses array (the store replaces the array on every change), so typing
// searches a ready index instead of rebuilding it per keystroke. Rows that read the same to the
// search (name, category, notes) are indexed once, so the cost follows the number of distinct
// entries rather than the length of the history.
const expenseIndexCache = new WeakMap<readonly ExpenseView[], ExpenseIndex>()

function expenseIndex(expenses: readonly ExpenseView[]): ExpenseIndex {
  const cached = expenseIndexCache.get(expenses)
  if (cached) return cached
  const groups = new Map<string, { first: SearchRow; rows: number[] }>()
  expenses.forEach((expense, i) => {
    const row = searchRow(expense)
    const key = [row.itemName, row.category, row.notes].join('\u0000')
    const group = groups.get(key)
    if (group) group.rows.push(i)
    else groups.set(key, { first: row, rows: [i] })
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
export function searchExpenses(
  expenses: readonly ExpenseView[],
  query: string,
  limit: number,
): ExpenseView[] {
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
