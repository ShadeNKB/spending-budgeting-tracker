import type { Expense } from '../types'

// What kind of entry a row is (T8c, money in). The data core carries it in the entry's
// pass-through fields (`ext.kind`); these two words are the core's own (`KIND_KEY`,
// `KIND_INCOME` in data/core/constants.ts, held equal by kind.test.ts). They are repeated here
// so the screens do not pull the core's modules onto the startup path.
export const KIND_KEY = 'kind'
export const KIND_INCOME = 'income'

/**
 * `expense`: what every entry was before kinds, and what one without the field still is.
 * `income`: money that came in. `unknown`: a kind a newer SpendTrack wrote and this one does
 * not know: it is listed and can be edited, and it is counted nowhere. A total that leaves
 * something out can be seen and questioned; one that counted, say, a refund as spending would
 * be wrong in silence.
 */
export type Kind = 'expense' | 'income' | 'unknown'

export function kindOf(e: Expense): Kind {
  const ext = e.ext
  if (ext === undefined || !Object.hasOwn(ext, KIND_KEY)) return 'expense'
  const raw = ext[KIND_KEY]
  return raw === KIND_INCOME ? 'income' : raw === 'expense' ? 'expense' : 'unknown'
}

/** The category an entry is filed under, or null: only an expense has one to show. */
export const categoryOf = (e: Expense): string | null =>
  kindOf(e) === 'expense' ? e.category : null

/** What a row shows where an expense has its category (and what a search for it finds). */
export function filedUnder(e: Expense): string {
  const kind = kindOf(e)
  return kind === 'expense' ? e.category : kind === 'income' ? 'Income' : 'Newer kind'
}

/** An entry's amount as a row shows it: income carries its sign, on every screen that lists it. */
export const shownAmount = (e: Expense, fmt: (n: number) => string): string =>
  `${kindOf(e) === 'income' ? '+' : ''}${fmt(e.amount)}`
