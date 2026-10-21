import Fuse from 'fuse.js'
import {
  addDays,
  dayKeyOfStored,
  daysInMonth,
  diffDays,
  keyDay,
  keyMonth,
  keyYear,
  makeKey,
  type DayKey,
} from '../lib/dates'
import { itemKey, type LedgerIndex } from '../lib/ledgerIndex'
import type { Expense } from '../types'

export interface RecurringGroup {
  key: string // normalized item name
  displayName: string // most recent original name
  category: string
  occurrences: Expense[] // oldest first
  avgAmount: number
  avgGapDays: number // average spacing between instances, in calendar days
  periodicity: 'weekly' | 'biweekly' | 'monthly' | 'irregular'
  /** Monthly charges: the usual day of the month (1-31). Otherwise `null`. */
  anchorDay: number | null
  /** The next expected charge after the last one seen. */
  nextDue: DayKey
  confidence: number // 0-1 based on gap variance
}

/** A monthly charge's next date is at least this far after the previous one. */
const MIN_MONTHLY_GAP = 15
/** A charge this many days overdue still counts as "due today" in the forecast. */
const OVERDUE_GRACE_DAYS = 3

const firstToken = (key: string) => {
  const space = key.indexOf(' ')
  return space === -1 ? key : key.slice(0, space)
}

/** `anchor` in the given month, clamped to its length (31 → Apr 30 / Feb 28-29). */
const anchored = (year: number, month: number, anchor: number): DayKey =>
  makeKey(year, month, Math.min(anchor, daysInMonth(year, month)))

function anchoredInMonthAfter(key: DayKey, anchor: number): DayKey {
  const month = keyMonth(key)
  return month === 12
    ? anchored(keyYear(key) + 1, 1, anchor)
    : anchored(keyYear(key), month + 1, anchor)
}

/** The most frequent day of the month among `days`; ties go to the one seen latest. */
function usualDayOfMonth(days: readonly DayKey[]): number {
  const counts = new Map<number, number>()
  for (const d of days) counts.set(keyDay(d), (counts.get(keyDay(d)) ?? 0) + 1)
  let best = keyDay(days[days.length - 1] ?? '')
  for (let i = days.length - 1; i >= 0; i--) {
    const dom = keyDay(days[i] ?? '')
    if ((counts.get(dom) ?? 0) > (counts.get(best) ?? 0)) best = dom
  }
  return best
}

/** The occurrence after `due`: the anchored day next month, or `round(avgGap)` days later. */
function stepAfter(group: Pick<RecurringGroup, 'anchorDay' | 'avgGapDays'>, due: DayKey): DayKey {
  return group.anchorDay === null
    ? addDays(due, Math.max(1, Math.round(group.avgGapDays)))
    : anchoredInMonthAfter(due, group.anchorDay)
}

function firstDueAfter(last: DayKey, anchorDay: number | null, avgGapDays: number): DayKey {
  if (anchorDay === null) return addDays(last, Math.max(1, Math.round(avgGapDays)))
  // The anchored date in the same month can still be the next one (a late charge last time).
  let due = anchored(keyYear(last), keyMonth(last), anchorDay)
  while (diffDays(last, due) < MIN_MONTHLY_GAP) due = anchoredInMonthAfter(due, anchorDay)
  return due
}

const cache = new WeakMap<LedgerIndex, RecurringGroup[]>()

/**
 * Detects expenses that repeat 3+ times on similar spacing.
 * Groups by item name (near-identical names sharing a first word are merged), then evaluates
 * gap consistency in calendar days. Memoised per index, so revisiting Insights is free.
 */
export function detectRecurring(index: LedgerIndex): RecurringGroup[] {
  const hit = cache.get(index)
  if (hit) return hit
  const groups = detect(index)
  cache.set(index, groups)
  return groups
}

function detect(index: LedgerIndex): RecurringGroup[] {
  if (index.validCount < 3) return []

  // 1. Bucket rows (readable dates only) by exact normalized name.
  const buckets = new Map<string, number[]>()
  for (let p = 0; p < index.validCount; p++) {
    const r = index.order[p] ?? 0
    const k = itemKey(index.expenses[r]?.itemName ?? '')
    if (!k) continue
    const bucket = buckets.get(k)
    if (bucket) bucket.push(r)
    else buckets.set(k, [r])
  }

  // 2. Absorb near-identical buckets ("spotify" / "spotify premium"). Fuzzy matching only
  //    runs inside blocks of names sharing a first word, so the cost stays near-linear.
  const blocks = new Map<string, string[]>()
  for (const k of buckets.keys()) {
    const block = blocks.get(firstToken(k))
    if (block) block.push(k)
    else blocks.set(firstToken(k), [k])
  }
  const merged: [string, number[]][] = []
  for (const keys of blocks.values()) {
    let blockRows = 0
    for (const k of keys) blockRows += buckets.get(k)?.length ?? 0
    if (blockRows < 3) continue // nothing in here can reach three occurrences
    if (keys.length === 1) {
      for (const k of keys) merged.push([k, buckets.get(k) ?? []])
      continue
    }
    const fuse = new Fuse(keys, { threshold: 0.25 })
    const claimed = new Set<string>()
    for (const k of keys) {
      if (claimed.has(k)) continue
      claimed.add(k)
      const rows = [...(buckets.get(k) ?? [])]
      for (const { item } of fuse.search(k)) {
        if (claimed.has(item)) continue
        claimed.add(item)
        rows.push(...(buckets.get(item) ?? []))
      }
      merged.push([k, rows])
    }
  }

  const groups: RecurringGroup[] = []
  for (const [key, rows] of merged) {
    if (rows.length < 3) continue
    const sorted = rows
      .map((r) => ({ r, day: index.dayKeys[r] ?? '' }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : b.r - a.r))
    const days = sorted.map((s) => s.day)

    const gaps: number[] = []
    for (let i = 1; i < days.length; i++) {
      const g = diffDays(days[i - 1] ?? '', days[i] ?? '')
      if (g > 0) gaps.push(g)
    }
    if (gaps.length < 2) continue

    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length
    const variance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length
    const relativeStdDev = avgGap > 0 ? Math.sqrt(variance) / avgGap : 1
    const confidence = Math.max(0, Math.min(1, 1 - relativeStdDev))
    // 0.55 reduces false positives from near-equal gaps by chance.
    if (confidence < 0.55) continue

    let periodicity: RecurringGroup['periodicity']
    if (avgGap <= 10) periodicity = 'weekly'
    else if (avgGap <= 18) periodicity = 'biweekly'
    else if (avgGap <= 45) periodicity = 'monthly'
    else periodicity = 'irregular'

    // Irregular cadence with only 3 occurrences is unreliable — require 4+ data points.
    if (periodicity === 'irregular' && rows.length < 4) continue

    const occurrences: Expense[] = []
    let cents = 0
    for (const { r } of sorted) {
      const e = index.expenses[r]
      if (!e) continue
      occurrences.push(e)
      cents += index.cents[r] ?? 0
    }
    const last = occurrences[occurrences.length - 1]
    const lastDay = days[days.length - 1]
    if (!last || !lastDay) continue
    const anchorDay = periodicity === 'monthly' ? usualDayOfMonth(days.slice(-6)) : null

    groups.push({
      key,
      displayName: last.itemName,
      category: last.category,
      occurrences,
      avgAmount: cents / occurrences.length / 100,
      avgGapDays: avgGap,
      periodicity,
      anchorDay,
      nextDue: firstDueAfter(lastDay, anchorDay, avgGap),
      confidence,
    })
  }

  return groups.sort((a, b) => b.confidence - a.confidence)
}

/** Iterates a group's expected charges from `nextDue`, never more than a century of steps. */
function* dueDates(group: RecurringGroup): Generator<DayKey> {
  if (dayKeyOfStored(group.nextDue) !== group.nextDue) return
  let due = group.nextDue
  for (let i = 0; i < 1200; i++) {
    yield due
    due = stepAfter(group, due)
  }
}

/**
 * A group's expected charges from today on. The latest charge before today still counts, once,
 * as due today when it is 1-3 days late and nothing is due today (a cadence shorter than the
 * grace never piles several missed charges into today); older missed charges are skipped.
 */
function* chargesFrom(group: RecurringGroup, today: DayKey): Generator<DayKey> {
  let missed: DayKey | null = null
  let first = true
  for (const due of dueDates(group)) {
    if (due < today) {
      missed = due
      continue
    }
    if (first && due !== today && missed !== null) {
      if (diffDays(missed, today) <= OVERDUE_GRACE_DAYS) yield today
    }
    first = false
    yield due
  }
}

/** The group's next charge as seen from `today`; never before today (a late one is due today). */
export function upcomingDue(group: RecurringGroup, today: DayKey): DayKey | null {
  for (const day of chargesFrom(group, today)) return day
  return null
}

/**
 * Projects expected spending for the next `days` days based on recurring groups.
 * Returns one number per day (slot 0 = today). A charge 1-3 days late counts once, as due
 * today; older missed charges are skipped.
 */
export function forecastDailyFromRecurring(
  groups: readonly RecurringGroup[],
  today: DayKey,
  days: number,
): number[] {
  const bins = new Array<number>(days).fill(0)
  for (const g of groups) {
    if (g.confidence < 0.5) continue
    for (const day of chargesFrom(g, today)) {
      const offset = diffDays(today, day)
      if (offset >= days) break
      bins[offset] = (bins[offset] ?? 0) + g.avgAmount
    }
  }
  return bins
}
