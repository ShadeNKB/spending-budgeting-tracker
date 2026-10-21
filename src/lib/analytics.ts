import {
  addDays,
  addMonths,
  daysInMonth,
  enumerateDays,
  formatRangeLabel,
  keyDay,
  keyMonth,
  keyYear,
  lastNDays,
  monthKeyOf,
  monthLabel,
  monthName,
  monthRange,
  monthShortName,
  prevMonthLikeForLike,
  prevYearLikeForLike,
  sundayOnOrBefore,
  weekdayShort,
  yearRange,
  type DayKey,
  type DayRange,
  type MonthKey,
} from './dates'
import {
  itemKey,
  rowsInRange,
  rowsToExpenses,
  sumRange,
  toCents,
  type LedgerIndex,
} from './ledgerIndex'
import type { CategoryBudgets, Expense } from '../types'

// Every figure is accumulated in integer cents and converted once, so a total never depends
// on summation order: Pulse month = Ledger month = the sum of its daily points, exactly.
// Periods come from `dates.ts` only; `today` is always passed in (no hidden clock).

// ─── Shared types ────────────────────────────────────────────────────────────

export interface CategoryStat {
  readonly category: string
  readonly total: number
  readonly share: number
}

export interface DayPoint {
  readonly date: DayKey
  readonly total: number
}

export interface PeriodComparison {
  /** The compared (previous) window's total. */
  readonly total: number
  /**
   * `(current - previous) / previous`; `null` when there is nothing to compare with, or nothing
   * logged yet in the current period (the 1st just after midnight is not a 100% drop).
   */
  readonly changePct: number | null
  /** "Sep 1–18", "August", "2025 to Oct 18". */
  readonly against: string
  /** "vs Sep 1–18", "vs August", "vs 2025 to Oct 18". */
  readonly label: string
}

/**
 * `over`: spent > cap. `ahead`: from day 5, the month-end projection passes the cap. Else
 * `onTrack`. The projection is the run rate of the variable spending plus the monthly charges
 * already paid, which are not extrapolated (see `paidMonthlyCharges`).
 */
export type BudgetStatus = 'onTrack' | 'ahead' | 'over'

export interface BudgetSummary {
  /** Sum of the caps set (> 0). */
  readonly cap: number
  /** Month total of the categories that have a cap. */
  readonly spent: number
  /** `spent / cap`. */
  readonly used: number
  /** Share of the month elapsed (`dom / dim`); 1 for a finished month. */
  readonly expected: number
  readonly left: number
  /** `left / daysLeft` for the current month; `null` for a finished one. */
  readonly perDay: number | null
  readonly projected: number | null
  readonly status: BudgetStatus
  /** Spending in categories without a cap (never measured against one). */
  readonly unbudgeted: number
  /** A finished month: spent vs cap only, no pace or projection. */
  readonly isFinal: boolean
}

export interface CategoryBudgetStat {
  readonly category: string
  readonly total: number
  readonly budget: number
  readonly used: number
  readonly expected: number
  readonly left: number
  readonly status: BudgetStatus
  /** Month-end projection, only when `status === 'ahead'`. */
  readonly projected: number | null
}

export interface HeatmapData {
  /** Sunday-start weeks: 13 full weeks plus the anchor's (partial) week. */
  readonly days: readonly DayPoint[]
  readonly start: DayKey
  readonly end: DayKey
}

export interface MonthAnalytics {
  readonly period: 'month'
  readonly monthKey: MonthKey
  /** "October 2026" */
  readonly label: string
  /** "October" */
  readonly monthName: string
  readonly isCurrent: boolean
  /** Whole month, future-dated rows included. */
  readonly periodTotal: number
  readonly periodCount: number
  readonly comparison: PeriodComparison
  readonly todayTotal: number
  readonly todayCount: number
  /** Today's rows, newest first; empty for a past month. */
  readonly todayEntries: readonly Expense[]
  readonly daysInPeriod: number
  readonly daysElapsed: number
  /** Today included (Oct 18 → 14, last day → 1); `null` for a past month. */
  readonly daysLeft: number | null
  readonly dailyAverage: number
  readonly budget: BudgetSummary | null
  readonly topCategories: readonly CategoryStat[]
  readonly categoryBudgets: readonly CategoryBudgetStat[]
  /** Current month: the last 30 days. Past month: every day of that month. */
  readonly daily: readonly DayPoint[]
  readonly heatmap: HeatmapData
}

export interface MonthTotal {
  /** 0-11 */
  readonly month: number
  readonly label: string
  readonly total: number
  readonly state: 'past' | 'current' | 'future'
}

export interface YearAnalytics {
  readonly period: 'year'
  readonly year: number
  readonly label: string
  readonly isCurrent: boolean
  readonly periodTotal: number
  readonly periodCount: number
  readonly comparison: PeriodComparison
  readonly monthlyTotals: readonly MonthTotal[]
  /**
   * Year total / months elapsed (the current month counts as a fraction), dividing by at least
   * one month so early January never projects one day to a whole month.
   */
  readonly monthlyAverage: number
  readonly monthsElapsed: number
  readonly highestMonth: MonthTotal | null
  readonly topCategories: readonly CategoryStat[]
  /** Current year: Jan to this month. Past year: all 12 months. */
  readonly sparkline: { readonly values: readonly number[]; readonly labels: readonly string[] }
  readonly heatmap: HeatmapData
}

export interface WeekAnalytics {
  readonly range: DayRange
  /** "Last 7 days · Oct 12 – Oct 18" */
  readonly label: string
  readonly thisWeek: number
  readonly prevWeek: number
  readonly changePct: number | null
  readonly dailyThisWeek: readonly (DayPoint & { readonly label: string })[]
}

// ─── Building blocks ──────────────────────────────────────────────────────────

const fromCents = (cents: number): number => cents / 100

const changeOf = (curCents: number, prevCents: number): number | null =>
  prevCents > 0 ? (curCents - prevCents) / prevCents : null

/** The current period so far vs its like-for-like window; nothing logged yet → no comparison. */
const changeSoFar = (curCents: number, prevCents: number): number | null =>
  curCents > 0 ? changeOf(curCents, prevCents) : null

/** Category → cents over `range`. A Map, so names like `constructor` are plain keys. */
export function categoryTotals(index: LedgerIndex, range: DayRange): Map<string, number> {
  const totals = new Map<string, number>()
  for (const r of rowsInRange(index, range)) {
    const category = index.expenses[r]?.category ?? ''
    totals.set(category, (totals.get(category) ?? 0) + (index.cents[r] ?? 0))
  }
  return totals
}

function topCategories(totals: Map<string, number>, totalCents: number): CategoryStat[] {
  return Array.from(totals)
    .filter(([, c]) => c > 0)
    .sort(([a, ca], [b, cb]) => cb - ca || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 6)
    .map(([category, c]) => ({
      category,
      total: fromCents(c),
      share: totalCents > 0 ? c / totalCents : 0,
    }))
}

const daySeries = (index: LedgerIndex, days: readonly DayKey[]): DayPoint[] =>
  days.map((date) => ({ date, total: fromCents(index.byDay.get(date)?.cents ?? 0) }))

/** One point per day for the `days` days ending at `end` (inclusive). */
export const computeTrailingDaily = (index: LedgerIndex, end: DayKey, days: number): DayPoint[] =>
  daySeries(index, enumerateDays(lastNDays(end, days)))

function heatmapEndingAt(index: LedgerIndex, end: DayKey): HeatmapData {
  const start = sundayOnOrBefore(addDays(end, -13 * 7))
  return { days: daySeries(index, enumerateDays({ start, end })), start, end }
}

/** Valid caps only: own keys, finite, at least one cent (a cap that rounds to 0 is unset). */
export const activeCaps = (budgets: CategoryBudgets): [string, number][] =>
  Object.entries(budgets).filter(([, cap]) => Number.isFinite(cap) && toCents(cap) > 0)

/**
 * This month's monthly charges per category, in cents: rows whose item appears exactly once this
 * month (up to `end`) and once in each of the two months before (Spotify on the 1st, rent on the
 * 28th). They are paid for the month, so projecting them at the daily run rate would count them
 * again.
 */
function paidMonthlyCharges(
  index: LedgerIndex,
  monthKey: MonthKey,
  end: DayKey = monthRange(monthKey).end,
): Map<string, number> {
  const twoBack = addMonths(monthKey, -2)
  const oneBack = addMonths(monthKey, -1)
  // Per item: how often it appears in each of the three months, and its row this month.
  const seen = new Map<string, { twoBack: number; oneBack: number; now: number; row: number }>()
  const range = { start: monthRange(twoBack).start, end }
  for (const r of rowsInRange(index, range)) {
    const name = itemKey(index.expenses[r]?.itemName ?? '')
    if (!name) continue
    const month = index.dayKeys[r]?.slice(0, 7)
    const entry = seen.get(name) ?? { twoBack: 0, oneBack: 0, now: 0, row: r }
    if (month === twoBack) entry.twoBack++
    else if (month === oneBack) entry.oneBack++
    else {
      entry.now++
      entry.row = r
    }
    seen.set(name, entry)
  }
  const paid = new Map<string, number>()
  for (const entry of seen.values()) {
    if (entry.twoBack !== 1 || entry.oneBack !== 1 || entry.now !== 1) continue
    const category = index.expenses[entry.row]?.category ?? ''
    paid.set(category, (paid.get(category) ?? 0) + (index.cents[entry.row] ?? 0))
  }
  return paid
}

/** Month-end projection: monthly charges already paid, plus the rest at the daily run rate. */
const projectedCents = (spent: number, fixed: number, dom: number, dim: number): number =>
  fixed + ((spent - fixed) / dom) * dim

/**
 * The current month's projected total in cents, from month to date (future-dated rows left out),
 * by the rule the budgets use: monthly charges already paid count once, the rest runs at the
 * daily rate. Insights' month pace reads this, so it can never contradict Pulse.
 */
export function projectedMonthCents(index: LedgerIndex, today: DayKey): number {
  const monthKey = monthKeyOf(today)
  const toDate = sumRange(index, { start: monthRange(monthKey).start, end: today }).cents
  let fixed = 0
  for (const cents of paidMonthlyCharges(index, monthKey, today).values()) fixed += cents
  const dim = daysInMonth(keyYear(today), keyMonth(today))
  return projectedCents(toDate, fixed, keyDay(today), dim)
}

function statusOf(
  spentCents: number,
  capCents: number,
  projected: number,
  dom: number,
  isCurrent: boolean,
): BudgetStatus {
  if (spentCents > capCents) return 'over'
  if (isCurrent && dom >= 5 && projected > capCents) return 'ahead'
  return 'onTrack'
}

const SEVERITY: Record<BudgetStatus, number> = { over: 2, ahead: 1, onTrack: 0 }

// ─── Month ────────────────────────────────────────────────────────────────────

export function computeMonthAnalytics(
  index: LedgerIndex,
  budgets: CategoryBudgets,
  today: DayKey,
  monthOffset = 0, // 0 = current month, 1 = the month before, …
): MonthAnalytics {
  const offset = Math.max(0, Math.trunc(monthOffset))
  const monthKey = addMonths(monthKeyOf(today), -offset)
  const isCurrent = offset === 0
  const range = monthRange(monthKey)
  const year = Number(monthKey.slice(0, 4))
  const dim = daysInMonth(year, Number(monthKey.slice(5, 7)))
  const dom = isCurrent ? keyDay(today) : dim

  const rows = rowsInRange(index, range)
  let totalCents = 0
  const catCents = new Map<string, number>()
  for (const r of rows) {
    const c = index.cents[r] ?? 0
    totalCents += c
    const category = index.expenses[r]?.category ?? ''
    catCents.set(category, (catCents.get(category) ?? 0) + c)
  }

  let comparison: PeriodComparison
  if (isCurrent) {
    const like = prevMonthLikeForLike(today)
    const cur = sumRange(index, { start: range.start, end: today }).cents
    const prev = sumRange(index, like.range).cents
    comparison = {
      total: fromCents(prev),
      changePct: changeSoFar(cur, prev),
      against: like.against,
      label: like.label,
    }
  } else {
    const prevMonth = addMonths(monthKey, -1)
    const prev = sumRange(index, monthRange(prevMonth)).cents
    const against = monthName(prevMonth)
    comparison = {
      total: fromCents(prev),
      changePct: changeOf(totalCents, prev),
      against,
      label: `vs ${against}`,
    }
  }

  const todayRows = isCurrent ? rowsInRange(index, { start: today, end: today }) : []
  let todayCents = 0
  for (const r of todayRows) todayCents += index.cents[r] ?? 0

  const caps = activeCaps(budgets)
  const fixed = isCurrent && caps.length > 0 ? paidMonthlyCharges(index, monthKey) : null
  let capCents = 0
  let spentCents = 0
  let fixedCents = 0
  const categoryBudgets = caps
    .map(([category, cap]): CategoryBudgetStat => {
      const capC = toCents(cap)
      const spentC = catCents.get(category) ?? 0
      const fixedC = fixed?.get(category) ?? 0
      capCents += capC
      spentCents += spentC
      fixedCents += fixedC
      const projected = projectedCents(spentC, fixedC, dom, dim)
      const status = statusOf(spentC, capC, projected, dom, isCurrent)
      return {
        category,
        total: fromCents(spentC),
        budget: fromCents(capC),
        used: capC > 0 ? spentC / capC : 0,
        expected: dom / dim,
        left: fromCents(Math.max(0, capC - spentC)),
        status,
        projected: status === 'ahead' ? fromCents(projected) : null,
      }
    })
    .sort(
      (a, b) =>
        SEVERITY[b.status] - SEVERITY[a.status] ||
        b.used - a.used ||
        (a.category < b.category ? -1 : 1),
    )

  const daysLeft = isCurrent ? dim - dom + 1 : null
  let budget: BudgetSummary | null = null
  if (capCents > 0) {
    const projected = projectedCents(spentCents, fixedCents, dom, dim)
    const status = statusOf(spentCents, capCents, projected, dom, isCurrent)
    const leftCents = Math.max(0, capCents - spentCents)
    budget = {
      cap: fromCents(capCents),
      spent: fromCents(spentCents),
      used: spentCents / capCents,
      expected: dom / dim,
      left: fromCents(leftCents),
      perDay: daysLeft === null ? null : fromCents(leftCents) / daysLeft,
      projected: status === 'ahead' ? fromCents(projected) : null,
      status,
      unbudgeted: fromCents(Math.max(0, totalCents - spentCents)),
      isFinal: !isCurrent,
    }
  }

  return {
    period: 'month',
    monthKey,
    label: monthLabel(monthKey),
    monthName: monthName(monthKey),
    isCurrent,
    periodTotal: fromCents(totalCents),
    periodCount: rows.length,
    comparison,
    todayTotal: fromCents(todayCents),
    todayCount: todayRows.length,
    todayEntries: rowsToExpenses(index, todayRows),
    daysInPeriod: dim,
    daysElapsed: dom,
    daysLeft,
    dailyAverage: fromCents(totalCents) / dom,
    budget,
    topCategories: topCategories(catCents, totalCents),
    categoryBudgets,
    daily: isCurrent
      ? computeTrailingDaily(index, today, 30)
      : daySeries(index, enumerateDays(range)),
    heatmap: heatmapEndingAt(index, isCurrent ? today : range.end),
  }
}

// ─── Year ─────────────────────────────────────────────────────────────────────

export function computeYearAnalytics(
  index: LedgerIndex,
  today: DayKey,
  yearOffset = 0, // 0 = current year, 1 = last year, …
): YearAnalytics {
  const offset = Math.max(0, Math.trunc(yearOffset))
  const year = keyYear(today) - offset
  const isCurrent = offset === 0
  const range = yearRange(year)
  const currentMonth = keyMonth(today) - 1

  const rows = rowsInRange(index, range)
  const monthCents = new Array<number>(12).fill(0)
  const catCents = new Map<string, number>()
  let totalCents = 0
  for (const r of rows) {
    const c = index.cents[r] ?? 0
    totalCents += c
    const m = Number(index.dayKeys[r]?.slice(5, 7) ?? '1') - 1
    monthCents[m] = (monthCents[m] ?? 0) + c
    const category = index.expenses[r]?.category ?? ''
    catCents.set(category, (catCents.get(category) ?? 0) + c)
  }

  let comparison: PeriodComparison
  if (isCurrent) {
    const like = prevYearLikeForLike(today)
    const cur = sumRange(index, { start: range.start, end: today }).cents
    const prev = sumRange(index, like.range).cents
    comparison = {
      total: fromCents(prev),
      changePct: changeSoFar(cur, prev),
      against: like.against,
      label: like.label,
    }
  } else {
    const prev = sumRange(index, yearRange(year - 1)).cents
    const against = String(year - 1)
    comparison = {
      total: fromCents(prev),
      changePct: changeOf(totalCents, prev),
      against,
      label: `vs ${against}`,
    }
  }

  const monthlyTotals = monthCents.map(
    (c, month): MonthTotal => ({
      month,
      label: monthShortName(`${String(year)}-${String(month + 1).padStart(2, '0')}`),
      total: fromCents(c),
      state:
        !isCurrent || month < currentMonth ? 'past' : month === currentMonth ? 'current' : 'future',
    }),
  )

  const monthsElapsed = isCurrent
    ? currentMonth + keyDay(today) / daysInMonth(year, currentMonth + 1)
    : 12

  let highestMonth: MonthTotal | null = null
  for (const m of monthlyTotals) if (m.total > (highestMonth?.total ?? 0)) highestMonth = m

  const plotted = isCurrent ? monthlyTotals.slice(0, currentMonth + 1) : monthlyTotals

  return {
    period: 'year',
    year,
    label: String(year),
    isCurrent,
    periodTotal: fromCents(totalCents),
    periodCount: rows.length,
    comparison,
    monthlyTotals,
    monthlyAverage: fromCents(totalCents) / Math.max(1, monthsElapsed),
    monthsElapsed,
    highestMonth,
    topCategories: topCategories(catCents, totalCents),
    sparkline: { values: plotted.map((m) => m.total), labels: plotted.map((m) => m.label) },
    heatmap: heatmapEndingAt(index, isCurrent ? today : range.end),
  }
}

// ─── Last 7 days ──────────────────────────────────────────────────────────────

export function computeWeekAnalytics(index: LedgerIndex, today: DayKey): WeekAnalytics {
  const range = lastNDays(today, 7)
  const prevRange = { start: addDays(today, -13), end: addDays(today, -7) }
  const cur = sumRange(index, range).cents
  const prev = sumRange(index, prevRange).cents
  return {
    range,
    label: `Last 7 days · ${formatRangeLabel(range, today)}`,
    thisWeek: fromCents(cur),
    prevWeek: fromCents(prev),
    changePct: changeOf(cur, prev),
    dailyThisWeek: daySeries(index, enumerateDays(range)).map((d) => ({
      ...d,
      label: weekdayShort(d.date),
    })),
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function colorFromString(str: string): string {
  if (!str) return '#5A6478'
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 65%, 62%)`
}
