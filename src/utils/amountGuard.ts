import type { Expense } from '../types'

/** The largest amount quick add accepts; anything above is a typo, not a purchase. */
export const MAX_AMOUNT = 10_000_000

/**
 * A confirming press that comes sooner than this after the large-amount warning appeared is the
 * tail of the same double tap (or double Enter), not a decision, and is ignored.
 */
export const CONFIRM_DELAY_MS = 400

/** A large amount waiting for a second press: the text it was flagged for and when (event time). */
export interface AmountConfirmation {
  readonly text: string
  readonly at: number
}

// Recent history only: the store keeps the newest expense first.
const HISTORY_ROWS = 200
const MIN_HISTORY = 10
const NEW_PROFILE_THRESHOLD = 10_000

const thresholdCache = new WeakMap<readonly Expense[], number>()

/**
 * The amount from which a quick add asks for a second press: the larger of 10 × the median and
 * 2 × the 95th percentile (nearest rank) of the 200 newest amounts, or 10,000 with fewer than 10
 * rows of history. For a typical day (median 6, p95 60) that is 120, so groceries go straight in
 * while 450 typed for 4.50 does not.
 */
export function unusualAmountThreshold(expenses: readonly Expense[]): number {
  const cached = thresholdCache.get(expenses)
  if (cached !== undefined) return cached

  const amounts = expenses
    .slice(0, HISTORY_ROWS)
    .map((e) => e.amount)
    .filter((a) => Number.isFinite(a) && a > 0)
    .sort((a, b) => a - b)

  let threshold = NEW_PROFILE_THRESHOLD
  if (amounts.length >= MIN_HISTORY) {
    const mid = amounts.length / 2
    const median = Number.isInteger(mid)
      ? ((amounts[mid - 1] ?? 0) + (amounts[mid] ?? 0)) / 2
      : (amounts[Math.floor(mid)] ?? 0)
    const p95 = amounts[Math.ceil(amounts.length * 0.95) - 1] ?? 0
    threshold = Math.max(10 * median, 2 * p95)
  }
  thresholdCache.set(expenses, threshold)
  return threshold
}

export function isUnusualAmount(amount: number, expenses: readonly Expense[]): boolean {
  return amount >= unusualAmountThreshold(expenses)
}

export function isAmountTooLarge(amount: number): boolean {
  return amount > MAX_AMOUNT
}
