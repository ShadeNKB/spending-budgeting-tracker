import { activeCaps, categoryTotals, projectedMonthCents } from '../lib/analytics'
import {
  addDays,
  addMonths,
  daysInMonth,
  keyDay,
  keyMonth,
  keyYear,
  lastNDays,
  monthKeyOf,
  monthName,
  monthRange,
  type DayKey,
} from '../lib/dates'
import { sumRange, toCents, type LedgerIndex } from '../lib/ledgerIndex'
import type { CategoryBudgets } from '../types'

export type InsightTone = 'up' | 'down' | 'warn' | 'info' | 'good'

export interface Insight {
  id: string
  tone: InsightTone
  title: string // the headline fact
  detail?: string // secondary context
}

/**
 * Compute up to 4 narrative insights for the Insights screen, from the shared periods:
 * budget alerts → last 7 days vs the previous 7 → uncategorised → month pace vs last month.
 * Every amount goes through `fmt`, so the copy follows the currency setting.
 */
export function computeInsights(
  index: LedgerIndex,
  budgets: CategoryBudgets,
  today: DayKey,
  fmt: (n: number) => string,
): Insight[] {
  const out: Insight[] = []
  const month = monthKeyOf(today)
  const thisMonth = monthRange(month)
  const dom = keyDay(today)
  const dim = daysInMonth(keyYear(today), keyMonth(today))
  const daysLeft = dim - dom + 1 // today included
  const daysLeftText =
    daysLeft === 1
      ? `Last day of ${monthName(month)}`
      : `${String(daysLeft)} days left in ${monthName(month)}`

  // ── 1. Budget alerts (most urgent first) ───────────────────────
  // "Over" means past the cap, the same rule as Pulse; exactly at the cap reads 100%.
  const monthByCategory = categoryTotals(index, thisMonth)
  for (const [cat, cap] of activeCaps(budgets)) {
    const spent = monthByCategory.get(cat) ?? 0
    const capCents = toCents(cap)
    const pct = spent / capCents
    if (spent > capCents) {
      out.push({
        id: `budget-over-${cat}`,
        tone: 'warn',
        title: `${cat} is over budget`,
        detail: `${fmt(spent / 100)} of ${fmt(cap)} · ${daysLeftText}`,
      })
    } else if (pct >= 0.85) {
      out.push({
        id: `budget-near-${cat}`,
        tone: 'warn',
        title: `${cat} at ${String(Math.round(pct * 100))}% of budget`,
        detail: daysLeftText,
      })
    }
  }

  // ── 2. Last 7 days vs the previous 7, per category ─────────────
  const thisWeek = categoryTotals(index, lastNDays(today, 7))
  const lastWeek = categoryTotals(index, { start: addDays(today, -13), end: addDays(today, -7) })
  const deltas: { cat: string; pct: number; diff: number }[] = []
  for (const [cat, cur] of thisWeek) {
    const prev = lastWeek.get(cat) ?? 0
    if (prev <= 0) continue
    const pct = (cur - prev) / prev
    if (Math.abs(pct) >= 0.3 && Math.abs(cur - prev) >= 500) {
      deltas.push({ cat, pct, diff: (cur - prev) / 100 })
    }
  }
  deltas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  for (const d of deltas.slice(0, 2)) {
    const up = d.pct > 0
    out.push({
      id: `trend-${d.cat}`,
      tone: up ? 'up' : 'down',
      title: `${d.cat} ${up ? 'up' : 'down'} ${String(Math.round(Math.abs(d.pct) * 100))}% in the last 7 days`,
      detail: `vs the previous 7 days (${fmt(Math.abs(d.diff))} ${up ? 'more' : 'less'})`,
    })
  }

  // ── 3. Uncategorized transactions ──────────────────────────────
  let uncat = 0
  for (const e of index.expenses) {
    if (!e.category || e.category === 'Other' || e.category === 'Uncategorized') uncat++
  }
  if (uncat >= 3) {
    out.push({
      id: 'uncategorized',
      tone: 'info',
      title: `${String(uncat)} transactions need a category`,
      detail: 'Assign them to improve your breakdown',
    })
  }

  // ── 4. Month pace (only if nothing else to say) ────────────────
  // The projection Pulse budgets use: rent or a subscription paid on the 1st counts once.
  if (out.length < 2 && dom > 3) {
    const projected = projectedMonthCents(index, today)
    const prevMonth = addMonths(month, -1)
    const lastMonth = sumRange(index, monthRange(prevMonth)).cents

    if (projected > 0 && lastMonth > 0) {
      const pct = (projected - lastMonth) / lastMonth
      if (Math.abs(pct) >= 0.08) {
        const share = String(Math.round(Math.abs(pct) * 100))
        out.push({
          id: 'month-pace',
          tone: pct > 0 ? 'up' : 'good',
          title:
            pct > 0
              ? `Pacing ${share}% higher than last month`
              : `Pacing ${share}% lower than last month`,
          detail: `Projected ${fmt(projected / 100)} · ${monthName(prevMonth)} ${fmt(lastMonth / 100)}`,
        })
      }
    }
  }

  // ── 5. Success state (good news if nothing flagged) ────────────
  if (out.length === 0 && index.expenses.length > 0) {
    out.push({
      id: 'all-clear',
      tone: 'good',
      title: 'Everything looks on track',
      detail: 'No budget overruns or surges detected',
    })
  }

  return out.slice(0, 4)
}
