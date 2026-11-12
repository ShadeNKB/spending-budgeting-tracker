import type { CategoryBudgets, Expense } from '../types'

/**
 * What counts as spending (F-057). Entries in a not-spending category (investments, savings,
 * transfers: money moved, not spent) stay in the Ledger and leave every total. Pulse and
 * Insights build their one index over `spending`, so a total, a pace, a comparison, a forecast
 * and a budget cannot disagree about what was left out; `aside` is summed on its own.
 */
export interface SpendingSplit<E extends Expense = Expense> {
  readonly spending: readonly E[]
  readonly aside: readonly E[]
}

const NONE: readonly never[] = Object.freeze([])

interface Cached {
  readonly names: readonly string[]
  readonly split: SpendingSplit
}
const cache = new WeakMap<readonly Expense[], Cached>()

/**
 * Splits `expenses` by the not-spending names. Cached on both arrays' identity (the store keeps
 * each while it is unchanged), and with no such category, or nothing in those categories,
 * `spending` is the `expenses` array itself: the index built over it is the Ledger's.
 */
export function splitSpending<E extends Expense>(
  expenses: readonly E[],
  asideCategories: readonly string[],
): SpendingSplit<E> {
  if (asideCategories.length === 0) return { spending: expenses, aside: NONE }
  const hit = cache.get(expenses)
  // The cached split holds this very array's own entries, so they are E.
  if (hit?.names === asideCategories) return hit.split as SpendingSplit<E>
  const names = new Set(asideCategories)
  const spending: E[] = []
  const aside: E[] = []
  for (const e of expenses) (names.has(e.category) ? aside : spending).push(e)
  const split: SpendingSplit<E> =
    aside.length === 0 ? { spending: expenses, aside: NONE } : { spending, aside }
  cache.set(expenses, { names: asideCategories, split })
  return split
}

interface CachedBudgets {
  readonly names: readonly string[]
  readonly budgets: CategoryBudgets
}
const budgetCache = new WeakMap<CategoryBudgets, CachedBudgets>()

/**
 * The budgets without those of not-spending categories: a cap there measures nothing. The same
 * object while both inputs are the same, and `budgets` itself when it loses none.
 */
export function spendingBudgets(
  budgets: CategoryBudgets,
  asideCategories: readonly string[],
): CategoryBudgets {
  if (asideCategories.length === 0) return budgets
  const hit = budgetCache.get(budgets)
  if (hit?.names === asideCategories) return hit.budgets
  const names = new Set(asideCategories)
  let out = budgets
  if (Object.keys(budgets).some((category) => names.has(category))) {
    // null-prototype, like the store's own: a category may be named "constructor"
    const kept = Object.create(null) as CategoryBudgets
    for (const [category, cap] of Object.entries(budgets)) {
      if (!names.has(category)) kept[category] = cap
    }
    out = kept
  }
  budgetCache.set(budgets, { names: asideCategories, budgets: out })
  return out
}
