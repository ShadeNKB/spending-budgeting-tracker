import type { CategoryBudgets, Expense } from '../types'
import { kindOf } from './kind'

/**
 * What counts as spending (F-057, F-058). Pulse and Insights build their one index over
 * `spending`, so a total, a pace, a comparison, a forecast and a budget cannot disagree about
 * what was left out; every other part is summed on its own, and the Ledger lists them all.
 *
 * - `spending`: expenses that count.
 * - `aside`: expenses in a not-spending category (investments, savings, transfers: money
 *   moved, not spent).
 * - `income`: money that came in (T8c).
 * - `unknown`: entries of a kind this version does not know. Counted nowhere.
 * - `outgoing`: every expense, counted or not (`spending` and `aside` together, in the store's
 *   order): where recurring charges are looked for.
 */
export interface SpendingSplit<E extends Expense = Expense> {
  readonly spending: readonly E[]
  readonly aside: readonly E[]
  readonly income: readonly E[]
  readonly unknown: readonly E[]
  readonly outgoing: readonly E[]
}

const NONE: readonly never[] = Object.freeze([])

interface Cached {
  readonly names: readonly string[]
  readonly split: SpendingSplit
}
const cache = new WeakMap<readonly Expense[], Cached>()

/**
 * Splits `expenses` by kind and by the not-spending names. Cached on both arrays' identity (the
 * store keeps each while it is unchanged). A part that takes every entry is the `expenses`
 * array itself: with no income and no not-spending entry, the index built over `spending` is
 * the Ledger's own.
 */
export function splitSpending<E extends Expense>(
  expenses: readonly E[],
  asideCategories: readonly string[],
): SpendingSplit<E> {
  const hit = cache.get(expenses)
  // The cached split holds this very array's own entries, so they are E.
  if (hit?.names === asideCategories) return hit.split as SpendingSplit<E>
  const names = asideCategories.length === 0 ? null : new Set(asideCategories)
  const spending: E[] = []
  const aside: E[] = []
  const income: E[] = []
  const unknown: E[] = []
  for (const e of expenses) {
    const kind = kindOf(e)
    if (kind === 'income') income.push(e)
    else if (kind === 'unknown') unknown.push(e)
    else if (names?.has(e.category) === true) aside.push(e)
    else spending.push(e)
  }
  const allOutgoing = income.length === 0 && unknown.length === 0
  const split: SpendingSplit<E> = {
    spending: allOutgoing && aside.length === 0 ? expenses : spending,
    aside: aside.length === 0 ? NONE : aside,
    income: income.length === 0 ? NONE : income,
    unknown: unknown.length === 0 ? NONE : unknown,
    outgoing: allOutgoing
      ? expenses
      : aside.length === 0
        ? spending
        : expenses.filter((e) => kindOf(e) === 'expense'),
  }
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
