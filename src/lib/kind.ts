import type { Expense } from '../types'

// What kind of entry a row is (T8c, money in). The data core carries it in the entry's
// pass-through fields (`ext.kind`); these words are the core's own (`KIND_KEY`, `KIND_INCOME`,
// `KIND_REFUND` in data/core/constants.ts, held equal by kind.test.ts). They are repeated here
// so the screens do not pull the core's modules onto the startup path.
export const KIND_KEY = 'kind'
export const KIND_INCOME = 'income'
export const KIND_REFUND = 'refund'

/**
 * `expense`: what every entry was before kinds, and what one without the field still is.
 * `income`: money that came in. `refund`: money back for something paid for; it keeps a category
 * and is negative spending there. `unknown`: a kind a newer SpendTrack wrote and this one does
 * not know: it is listed and can be edited, and it is counted nowhere. A total that leaves
 * something out can be seen and questioned; one that counted a kind it cannot read as spending
 * would be wrong in silence.
 */
export type Kind = 'expense' | 'income' | 'refund' | 'unknown'

export function kindOf(e: Expense): Kind {
  const ext = e.ext
  if (ext === undefined || !Object.hasOwn(ext, KIND_KEY)) return 'expense'
  const raw = ext[KIND_KEY]
  return raw === KIND_INCOME
    ? 'income'
    : raw === KIND_REFUND
      ? 'refund'
      : raw === 'expense'
        ? 'expense'
        : 'unknown'
}

/** The kinds a spending sum takes: an expense adds to it, a refund comes off it. */
export const inSpending = (kind: Kind): boolean => kind === 'expense' || kind === 'refund'

/** The category an entry is filed under, or null: an expense or a refund has one to show. */
export const categoryOf = (e: Expense): string | null => (inSpending(kindOf(e)) ? e.category : null)

/** What a row shows where an expense has its category (and what a search for it finds). */
export function filedUnder(e: Expense): string {
  const kind = kindOf(e)
  return inSpending(kind) ? e.category : kind === 'income' ? 'Income' : 'Newer kind'
}

/**
 * A net figure where no signed rows sit beside it (a chart's tooltip, a day on the heatmap,
 * "Today" on Pulse, a budget's row): below zero it is said as what came back, "S$20.00 back".
 * A bare minus there reads as a mistake; beside its rows (a Ledger day, the Today strip) the
 * minus stays, because the rows add up to it.
 */
export const netFigure = (total: number, fmt: (n: number) => string): string =>
  total < 0 ? `${fmt(-total)} back` : fmt(total)

/**
 * An entry's amount as a row shows it, on every screen that lists it. Income carries a plus:
 * it is beside the spending sums, not in them. A refund carries a minus: it is in them, and the
 * rows of a day add up to the day's figure.
 */
export function shownAmount(e: Expense, fmt: (n: number) => string): string {
  const kind = kindOf(e)
  return kind === 'income'
    ? `+${fmt(e.amount)}`
    : kind === 'refund'
      ? fmt(-e.amount)
      : fmt(e.amount)
}
