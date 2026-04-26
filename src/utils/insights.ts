import { parseISO, differenceInDays, startOfMonth, endOfMonth } from "date-fns";
import type { Expense, CategoryBudgets } from "../types";

export type InsightTone = "up" | "down" | "warn" | "info" | "good";

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;    // the headline fact
  detail?: string;  // secondary context
}

function sumBy(items: Expense[], pred: (e: Expense) => boolean): number {
  let s = 0;
  for (const e of items) if (pred(e)) s += e.amount;
  return s;
}

function groupByCategory(items: Expense[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) out[e.category] = (out[e.category] ?? 0) + e.amount;
  return out;
}

/**
 * Compute 2–4 narrative insights for the Dashboard.
 * Ordering: budget alerts → week deltas → uncategorized → month-pace.
 */
export function computeInsights(
  allExpenses: Expense[],
  budgets: CategoryBudgets
): Insight[] {
  const out: Insight[] = [];
  const now = new Date();

  const sevenAgo = new Date(now); sevenAgo.setDate(now.getDate() - 7);
  const fourteenAgo = new Date(now); fourteenAgo.setDate(now.getDate() - 14);
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);
  const daysInMonth = monthEnd.getDate();
  const dayOfMonth = now.getDate();
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);

  const withinRange = (e: Expense, start: Date, end: Date) => {
    const d = parseISO(e.date);
    return d >= start && d < end;
  };

  // ── 1. Budget alerts (most urgent first) ───────────────────────
  const budgetEntries = Object.entries(budgets).filter(([, cap]) => cap > 0);
  for (const [cat, cap] of budgetEntries) {
    const spent = sumBy(allExpenses, (e) => e.category === cat && withinRange(e, monthStart, monthEnd));
    const pct = spent / cap;
    if (pct >= 1) {
      out.push({
        id: `budget-over-${cat}`,
        tone: "warn",
        title: `${cat} is over budget`,
        detail: `$${spent.toFixed(0)} of $${cap.toFixed(0)} · ${daysLeft}d left in ${now.toLocaleString("en-US", { month: "long" })}`,
      });
    } else if (pct >= 0.85) {
      out.push({
        id: `budget-near-${cat}`,
        tone: "warn",
        title: `${cat} at ${Math.round(pct * 100)}% of budget`,
        detail: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left this month`,
      });
    }
  }

  // ── 2. Week-over-week category jumps ───────────────────────────
  const thisWeek = groupByCategory(allExpenses.filter((e) => withinRange(e, sevenAgo, now)));
  const lastWeek = groupByCategory(allExpenses.filter((e) => withinRange(e, fourteenAgo, sevenAgo)));
  const deltas: { cat: string; pct: number; diff: number }[] = [];
  for (const [cat, cur] of Object.entries(thisWeek)) {
    const prev = lastWeek[cat] ?? 0;
    if (prev === 0) continue;
    const pct = (cur - prev) / prev;
    if (Math.abs(pct) >= 0.3 && Math.abs(cur - prev) >= 5) {
      deltas.push({ cat, pct, diff: cur - prev });
    }
  }
  deltas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  for (const d of deltas.slice(0, 2)) {
    const up = d.pct > 0;
    out.push({
      id: `trend-${d.cat}`,
      tone: up ? "up" : "down",
      title: `${d.cat} ${up ? "up" : "down"} ${Math.round(Math.abs(d.pct) * 100)}% this week`,
      detail: `vs last 7 days ($${Math.abs(d.diff).toFixed(0)} ${up ? "more" : "less"})`,
    });
  }

  // ── 3. Uncategorized transactions ──────────────────────────────
  const uncat = allExpenses.filter(
    (e) => !e.category || e.category === "Other" || e.category === "Uncategorized"
  ).length;
  if (uncat >= 3) {
    out.push({
      id: "uncategorized",
      tone: "info",
      title: `${uncat} transactions need a category`,
      detail: "Assign them to improve your breakdown",
    });
  }

  // ── 4. Month pace (only if nothing else to say) ────────────────
  if (out.length < 2 && dayOfMonth > 3) {
    const thisMonth = sumBy(allExpenses, (e) => withinRange(e, monthStart, monthEnd));
    const fraction = dayOfMonth / daysInMonth;
    const projected = fraction > 0 ? thisMonth / fraction : 0;

    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const lastMonthTotal = sumBy(allExpenses, (e) => withinRange(e, lastMonthStart, lastMonthEnd));

    if (projected > 0 && lastMonthTotal > 0) {
      const diff = projected - lastMonthTotal;
      const pct = diff / lastMonthTotal;
      if (Math.abs(pct) >= 0.08) {
        out.push({
          id: "month-pace",
          tone: pct > 0 ? "up" : "good",
          title:
            pct > 0
              ? `Pacing ${Math.round(pct * 100)}% higher than last month`
              : `Pacing ${Math.round(Math.abs(pct) * 100)}% lower than last month`,
          detail: `Projected $${projected.toFixed(0)} · last month $${lastMonthTotal.toFixed(0)}`,
        });
      }
    }
  }

  // ── 5. Success state (good news if nothing flagged) ────────────
  if (out.length === 0 && allExpenses.length > 0) {
    out.push({
      id: "all-clear",
      tone: "good",
      title: "Everything looks on track",
      detail: "No budget overruns or surges detected",
    });
  }

  return out.slice(0, 4);
}

export function daysLeftInMonth(): number {
  const now = new Date();
  const end = endOfMonth(now);
  return Math.max(0, differenceInDays(end, now));
}
