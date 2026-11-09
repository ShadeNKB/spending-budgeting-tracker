import { dayKeyOfStored, type RangeName } from '../../lib/dates'

// Ledger filters live in the URL, so every search param is untrusted: anything
// outside the known shape falls back to a default instead of leaking into the filters.

export const RANGES = [
  'today',
  'week',
  'month',
  'year',
  'all',
  'custom',
] as const satisfies readonly RangeName[]
export type Range = (typeof RANGES)[number]

export const isRange = (v: string | null): v is Range => RANGES.some((r) => r === v)

/** A Pulse period the Ledger can show: this month (null), this year, or a span of days. */
export type LedgerPeriod = null | 'year' | { readonly start: string; readonly end: string }

/** The Ledger filtered to `category` over the period Pulse shows, as Pulse drills into it. */
export function ledgerCategoryHref(category: string, period: LedgerPeriod): string {
  const base = `/ledger?category=${encodeURIComponent(category)}`
  if (period === null) return base
  if (period === 'year') return `${base}&range=year`
  return `${base}&range=custom&customStart=${period.start}&customEnd=${period.end}`
}

/**
 * The Ledger at one entry's day, searched for its name, with its Edit sheet open (`edit`, which
 * the Ledger takes out of the URL once it has opened it).
 */
export function ledgerEntryHref(entry: {
  readonly id: string
  readonly day: string
  readonly itemName: string
}): string {
  const q = encodeURIComponent(entry.itemName)
  return `/ledger?date=${entry.day}&q=${q}&edit=${encodeURIComponent(entry.id)}`
}

/** True for a real calendar date written as `yyyy-MM-dd`. */
export const isValidYmd = (v: string | null): v is string =>
  v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v) && dayKeyOfStored(v) === v
