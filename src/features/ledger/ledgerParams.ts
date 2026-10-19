import { isValid, parseISO } from 'date-fns'

// Ledger filters live in the URL, so every search param is untrusted: anything
// outside the known shape falls back to a default instead of leaking into the filters.

export const RANGES = ['today', 'week', 'month', 'year', 'all', 'custom'] as const
export type Range = (typeof RANGES)[number]

export const isRange = (v: string | null): v is Range => RANGES.some((r) => r === v)

/** True for a real calendar date written as `yyyy-MM-dd`. */
export const isValidYmd = (v: string | null): v is string => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  return isValid(parseISO(v))
}
