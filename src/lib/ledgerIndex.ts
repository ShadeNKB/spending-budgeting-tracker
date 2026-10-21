import { readStored, type DayKey, type DayRange } from './dates'
import type { Expense } from '../types'

/**
 * One derived view of the expenses array, built once per data change and shared by Pulse,
 * Insights, recurring detection and the Ledger. Zustand hands out a new array on every
 * change, so the array's identity is the cache key: remounting a screen or switching tabs
 * reuses the same index instead of re-parsing every date.
 */
export interface DayTotal {
  readonly cents: number
  readonly count: number
}

export interface LedgerIndex {
  readonly expenses: readonly Expense[]
  /** Per row: its local day, `null` when the stored date cannot be read. */
  readonly dayKeys: readonly (DayKey | null)[]
  /** Per row: the amount in integer cents (non-finite amounts count 0). */
  readonly cents: Float64Array
  /** Row indices, newest first: day desc, time desc, createdAt desc, id asc; unreadable last. */
  readonly order: Uint32Array
  /** `dayKeys[order[i]]`: descending, `null`s at the end. */
  readonly orderedKeys: readonly (DayKey | null)[]
  /** Rows with a readable date; they occupy `order[0 .. validCount)`. */
  readonly validCount: number
  readonly byDay: ReadonlyMap<DayKey, DayTotal>
  readonly totalCents: number
  /** Lowercased `itemName \0 category \0 notes`, built on first use and cached. */
  searchText: (row: number) => string
}

/** Integer cents; non-finite amounts contribute nothing. */
export const toCents = (amount: number): number =>
  Number.isFinite(amount) ? Math.round(amount * 100) : 0

/** The key two rows share when they are the same item: lower case, spaces collapsed. */
export const itemKey = (name: string): string => name.toLowerCase().trim().replace(/\s+/g, ' ')

/** Unreadable dates sort as the oldest possible time (subtracting two of them gives 0). */
const OLDEST = -Number.MAX_VALUE

/** `yyyy-MM-dd` → yyyyMMdd as a number, read digit by digit (keys are always 10 ASCII chars). */
function keyNumber(key: DayKey): number {
  let n = 0
  for (let i = 0; i < 10; i++) if (i !== 4 && i !== 7) n = n * 10 + key.charCodeAt(i) - 48
  return n
}

const cache = new WeakMap<readonly Expense[], LedgerIndex>()

function buildIndex(expenses: readonly Expense[]): LedgerIndex {
  const n = expenses.length
  const dayKeys: (DayKey | null)[] = new Array<DayKey | null>(n)
  const dayNums = new Float64Array(n)
  const times = new Float64Array(n)
  const cents = new Float64Array(n)
  const byDay = new Map<DayKey, { cents: number; count: number }>()
  let totalCents = 0
  let validCount = 0

  for (let i = 0; i < n; i++) {
    const e = expenses[i]
    if (!e) continue
    const stored = readStored(e.date)
    const c = toCents(e.amount)
    dayKeys[i] = stored.key
    cents[i] = c
    totalCents += c
    if (stored.key === null) {
      dayNums[i] = -1
      times[i] = OLDEST
      continue
    }
    validCount++
    dayNums[i] = keyNumber(stored.key)
    times[i] = stored.time
    const bucket = byDay.get(stored.key)
    if (bucket) {
      bucket.cents += c
      bucket.count += 1
    } else {
      byDay.set(stored.key, { cents: c, count: 1 })
    }
  }

  // Ties on day and time (every sheet entry of a day is stored at local noon) fall back to
  // createdAt — ISO strings compare chronologically as text — then id, so the order is
  // deterministic and an undone delete returns to its old place. The store keeps rows
  // newest-first, so this is close to a single pass of TimSort in practice.
  const sorted: number[] = []
  for (let i = 0; i < n; i++) sorted.push(i)
  sorted.sort((a, b) => {
    const day = (dayNums[b] ?? 0) - (dayNums[a] ?? 0)
    if (day !== 0) return day
    const time = (times[b] ?? 0) - (times[a] ?? 0)
    if (time !== 0) return time
    const ca = expenses[a]?.createdAt ?? ''
    const cb = expenses[b]?.createdAt ?? ''
    if (ca !== cb) return ca < cb ? 1 : -1
    const ia = expenses[a]?.id ?? ''
    const ib = expenses[b]?.id ?? ''
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  const order = Uint32Array.from(sorted)
  const orderedKeys = sorted.map((r) => dayKeys[r] ?? null)

  const texts: (string | undefined)[] = new Array<string | undefined>(n)
  const searchText = (r: number): string => {
    const hit = texts[r]
    if (hit !== undefined) return hit
    const e = expenses[r]
    const text = e ? `${e.itemName}\0${e.category}\0${e.notes ?? ''}`.toLowerCase() : ''
    texts[r] = text
    return text
  }

  return {
    expenses,
    dayKeys,
    cents,
    order,
    orderedKeys,
    validCount,
    byDay,
    totalCents,
    searchText,
  }
}

export function getLedgerIndex(expenses: readonly Expense[]): LedgerIndex {
  const hit = cache.get(expenses)
  if (hit) return hit
  const index = buildIndex(expenses)
  cache.set(expenses, index)
  return index
}

/** First position in `[0, validCount)` whose key satisfies `pred` (keys descending). */
function firstPosition(index: LedgerIndex, pred: (key: DayKey) => boolean): number {
  let lo = 0
  let hi = index.validCount
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const key = index.orderedKeys[mid]
    if (key != null && pred(key)) hi = mid
    else lo = mid + 1
  }
  return lo
}

function bounds(index: LedgerIndex, range: DayRange | null): [number, number] {
  if (range === null) return [0, index.order.length]
  const from = firstPosition(index, (k) => k <= range.end)
  const to = firstPosition(index, (k) => k < range.start)
  return [from, Math.max(from, to)]
}

/**
 * Row indices whose day lies in `range` (inclusive), newest first. `null` = every row,
 * including those whose date cannot be read. O(log N + k).
 */
export function rowsInRange(index: LedgerIndex, range: DayRange | null): number[] {
  const [from, to] = bounds(index, range)
  return Array.from(index.order.subarray(from, to))
}

/** Total cents and row count over `range` (`null` = every row). */
export function sumRange(index: LedgerIndex, range: DayRange | null): DayTotal {
  const [from, to] = bounds(index, range)
  let cents = 0
  for (let p = from; p < to; p++) cents += index.cents[index.order[p] ?? 0] ?? 0
  return { cents, count: to - from }
}

/** The expenses behind a list of row indices, in that order. */
export function rowsToExpenses(index: LedgerIndex, rows: readonly number[]): Expense[] {
  const out: Expense[] = []
  for (const r of rows) {
    const e = index.expenses[r]
    if (e) out.push(e)
  }
  return out
}
