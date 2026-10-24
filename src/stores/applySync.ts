// Applies a merged sync document to the expense store. Sync-only code: the engine is its one
// caller, so it ships in the engine's lazy chunk, not in the store every page loads.
//
// Structure sharing: every object that is equal by content is kept, so a no-op sync notifies no
// subscriber and nothing downstream recomputes.

import { DEFAULT_CATEGORIES } from '../constants'
import { isRecord } from '../lib/backup'
import { canon, canonRow } from '../lib/canon'
import { LEGACY_STAMP_ISO } from '../lib/stamps'
import type { BackupData, Expense } from '../types'
import { completeBudgetUpdatedAt, flushPendingSave, useExpenseStore } from './useExpenseStore'

const idOf = (row: unknown): string | undefined =>
  isRecord(row) && typeof row.id === 'string' ? row.id : undefined

/** The next rows, reusing current objects; null when they are the same rows in any order. */
function shareRows(current: readonly Expense[], next: readonly Expense[]): Expense[] | null {
  const byId = new Map<string, Expense>()
  const unused = new Map<Expense, number>()
  for (const row of current) {
    unused.set(row, (unused.get(row) ?? 0) + 1)
    const id = idOf(row)
    if (id !== undefined && !byId.has(id)) byId.set(id, row)
  }
  let changed = next.length !== current.length
  const rows = next.map((row) => {
    let kept = row
    if (!unused.has(row)) {
      const id = idOf(row)
      const mine = id === undefined ? undefined : byId.get(id)
      if (mine !== undefined && canonRow(mine) === canonRow(row)) kept = mine
    }
    const left = unused.get(kept) ?? 0
    if (left > 0) unused.set(kept, left - 1)
    else changed = true
    return kept
  })
  return changed ? rows : null
}

function keepIfSameSet(current: string[], next: string[]): string[] {
  const a = new Set(current)
  const b = new Set(next)
  return a.size === b.size && [...a].every((x) => b.has(x)) ? current : next
}

const keepIfEqual = <T>(current: T, next: T): T => (canon(current) === canon(next) ? current : next)

/** Applies `data` to the store, sharing every unchanged object. Returns whether anything changed. */
export function applySync(data: BackupData): boolean {
  const s = useExpenseStore.getState()
  const budgets = data.budgets ?? {}
  const next = {
    expenses: shareRows(s.expenses, data.expenses) ?? s.expenses,
    categories: keepIfSameSet(
      s.categories,
      data.categories.length ? data.categories : DEFAULT_CATEGORIES,
    ),
    categoryMappings: keepIfEqual(s.categoryMappings, data.categoryMappings),
    mappingUpdatedAt: keepIfEqual(s.mappingUpdatedAt, data.mappingUpdatedAt ?? {}),
    budgets: keepIfEqual(s.budgets, budgets),
    budgetUpdatedAt: keepIfEqual(
      s.budgetUpdatedAt,
      completeBudgetUpdatedAt(budgets, data.budgetUpdatedAt, LEGACY_STAMP_ISO),
    ),
    budgetDeletedAt: keepIfEqual(s.budgetDeletedAt, data.budgetDeletedAt ?? {}),
    deletedIds: keepIfSameSet(s.deletedIds, data.deletedIds ?? []),
  }
  const changed =
    next.expenses !== s.expenses ||
    next.categories !== s.categories ||
    next.categoryMappings !== s.categoryMappings ||
    next.mappingUpdatedAt !== s.mappingUpdatedAt ||
    next.budgets !== s.budgets ||
    next.budgetUpdatedAt !== s.budgetUpdatedAt ||
    next.budgetDeletedAt !== s.budgetDeletedAt ||
    next.deletedIds !== s.deletedIds
  if (!changed) return false
  useExpenseStore.setState(next)
  // Remote data is written at once: no debounce window for a kill to lose it in.
  flushPendingSave()
  return true
}
