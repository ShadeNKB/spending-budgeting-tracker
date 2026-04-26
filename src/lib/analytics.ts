import {
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
  startOfYear,
  endOfYear,
  subDays,
  subMonths,
  parseISO,
  differenceInCalendarDays,
  format,
  isSameDay,
  isWithinInterval,
  startOfWeek,
  addDays,
  getDaysInMonth,
  getMonth,
  getYear,
} from "date-fns";
import type { Expense, CategoryBudgets } from "../types";

// ─── Shared types ────────────────────────────────────────────────────────────

export interface CategoryStat {
  category: string;
  total: number;
  share: number;
  budget?: number;
  paceRatio?: number;
}

export interface MonthAnalytics {
  period: "month";
  label: string;          // "April 2026"
  periodTotal: number;
  prevTotal: number;
  changePct: number;      // fractional, e.g. 0.12 = +12%
  todayTotal: number;
  todayCount: number;
  daysElapsed: number;
  daysInPeriod: number;
  daysLeft: number;
  totalBudget: number;
  paceRatio: number;
  topCategories: CategoryStat[];
  categoryBudgets: CategoryStat[];  // all cats with a budget set
  heatmap: { date: string; total: number }[];
  daily: { date: string; total: number }[];  // 30 days
  todayEntries: Expense[];
  recentEntries: Expense[];
}

export interface YearAnalytics {
  period: "year";
  label: string;          // "2026"
  periodTotal: number;
  prevTotal: number;
  changePct: number;
  daysElapsed: number;
  daysInPeriod: number;
  monthlyTotals: { label: string; total: number; month: number }[];  // Jan–Dec
  topCategories: CategoryStat[];
  daily: { date: string; total: number }[];  // 365 days for sparkline
  monthlySparkline: number[];               // 12 monthly totals for the hero sparkline
  recentEntries: Expense[];
}

export interface WeekAnalytics {
  thisWeek: number;
  prevWeek: number;
  changePct: number;
  dailyThisWeek: { date: string; total: number; label: string }[];
}

export type PulseAnalytics = MonthAnalytics | YearAnalytics;

// ─── Month ────────────────────────────────────────────────────────────────────

export function computeMonthAnalytics(
  expenses: Expense[],
  budgets: CategoryBudgets,
  monthOffset = 0  // 0 = current month, 1 = 1 month ago, etc.
): MonthAnalytics {
  const now = new Date();
  const ref = monthOffset === 0 ? now : subMonths(now, monthOffset);
  const isCurrentMonth = monthOffset === 0;

  const monthStart = startOfMonth(ref);
  const monthEnd = endOfMonth(ref);
  const prevStart = startOfMonth(subMonths(ref, 1));
  const prevEnd = endOfMonth(subMonths(ref, 1));
  // todayTotal only makes sense in current month
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  let periodTotal = 0;
  let prevTotal = 0;
  let todayTotal = 0;
  const todayEntries: Expense[] = [];
  const catTotals: Record<string, number> = {};

  for (const e of expenses) {
    const d = parseISO(e.date);
    if (isWithinInterval(d, { start: monthStart, end: monthEnd })) {
      periodTotal += e.amount;
      catTotals[e.category] = (catTotals[e.category] ?? 0) + e.amount;
    } else if (isWithinInterval(d, { start: prevStart, end: prevEnd })) {
      prevTotal += e.amount;
    }
    if (isWithinInterval(d, { start: todayStart, end: todayEnd })) {
      todayTotal += e.amount;
      todayEntries.push(e);
    }
  }

  const daysInPeriod = getDaysInMonth(ref);
  const daysElapsed = isCurrentMonth ? now.getDate() : daysInPeriod;
  const daysLeft = isCurrentMonth ? Math.max(0, daysInPeriod - daysElapsed) : 0;

  const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
  const expectedByNow = totalBudget > 0 ? (totalBudget * daysElapsed) / daysInPeriod : 0;
  const paceRatio = expectedByNow > 0 ? periodTotal / expectedByNow : 0;

  const topCategories: CategoryStat[] = Object.entries(catTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([category, total]) => ({
      category,
      total,
      share: periodTotal > 0 ? total / periodTotal : 0,
      budget: budgets[category],
      paceRatio:
        budgets[category] && daysInPeriod > 0
          ? total / ((budgets[category] * daysElapsed) / daysInPeriod)
          : undefined,
    }));

  const categoryBudgets: CategoryStat[] = Object.entries(budgets)
    .filter(([, cap]) => cap > 0)
    .map(([category, budget]) => {
      const total = catTotals[category] ?? 0;
      const expected = (budget * daysElapsed) / daysInPeriod;
      return {
        category,
        total,
        share: periodTotal > 0 ? total / periodTotal : 0,
        budget,
        paceRatio: expected > 0 ? total / expected : 0,
      };
    })
    .sort((a, b) => (b.paceRatio ?? 0) - (a.paceRatio ?? 0));

  // Heatmap — 14 weeks (always anchored to today regardless of offset)
  const heatStart = startOfWeek(subDays(now, 13 * 7), { weekStartsOn: 0 });
  const heatEnd = endOfDay(now);
  const heatBuckets = new Map<string, number>();
  for (const e of expenses) {
    const d = parseISO(e.date);
    if (d < heatStart || d > heatEnd) continue;
    const key = format(d, "yyyy-MM-dd");
    heatBuckets.set(key, (heatBuckets.get(key) ?? 0) + e.amount);
  }
  const totalHeatDays = differenceInCalendarDays(heatEnd, heatStart) + 1;
  const heatmap = Array.from({ length: totalHeatDays }, (_, i) => {
    const d = addDays(heatStart, i);
    const key = format(d, "yyyy-MM-dd");
    return { date: key, total: heatBuckets.get(key) ?? 0 };
  });

  // Daily — 30 days ending at ref month's last day (or today if current month)
  const dailyEnd = isCurrentMonth ? now : monthEnd;
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = subDays(dailyEnd, 29 - i);
    const key = format(d, "yyyy-MM-dd");
    const total = expenses
      .filter((e) => isSameDay(parseISO(e.date), d))
      .reduce((s, e) => s + e.amount, 0);
    return { date: key, total };
  });

  const recentEntries = [...expenses]
    .sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime())
    .slice(0, 5);

  return {
    period: "month",
    label: format(ref, "MMMM yyyy"),
    periodTotal,
    prevTotal,
    changePct: prevTotal > 0 ? (periodTotal - prevTotal) / prevTotal : 0,
    todayTotal,
    todayCount: todayEntries.length,
    daysElapsed,
    daysInPeriod,
    daysLeft,
    totalBudget,
    paceRatio,
    topCategories,
    categoryBudgets,
    heatmap,
    daily,
    todayEntries: todayEntries.sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime()),
    recentEntries,
  };
}

// ─── Year ─────────────────────────────────────────────────────────────────────

export function computeYearAnalytics(
  expenses: Expense[],
  budgets: CategoryBudgets,
  yearOffset = 0  // 0 = current year, 1 = last year, etc.
): YearAnalytics {
  const now = new Date();
  const refYear = getYear(now) - yearOffset;
  const refDate = new Date(refYear, now.getMonth(), now.getDate());
  const isCurrentYear = yearOffset === 0;

  const yearStart = startOfYear(new Date(refYear, 0, 1));
  const yearEnd = endOfYear(new Date(refYear, 0, 1));
  const prevYearStart = startOfYear(new Date(refYear - 1, 0, 1));
  const prevYearEnd = endOfYear(new Date(refYear - 1, 0, 1));

  let periodTotal = 0;
  let prevTotal = 0;
  const catTotals: Record<string, number> = {};
  const monthlyBuckets: number[] = new Array(12).fill(0);

  for (const e of expenses) {
    const d = parseISO(e.date);
    if (isWithinInterval(d, { start: yearStart, end: yearEnd })) {
      periodTotal += e.amount;
      catTotals[e.category] = (catTotals[e.category] ?? 0) + e.amount;
      monthlyBuckets[getMonth(d)] += e.amount;
    } else if (isWithinInterval(d, { start: prevYearStart, end: prevYearEnd })) {
      prevTotal += e.amount;
    }
  }

  const daysInPeriod = differenceInCalendarDays(yearEnd, yearStart) + 1;
  const daysElapsed = isCurrentYear
    ? differenceInCalendarDays(now, yearStart) + 1
    : daysInPeriod;

  const monthlyTotals = monthlyBuckets.map((total, i) => ({
    label: format(new Date(refYear, i, 1), "MMM"),
    total,
    month: i,
  }));

  const topCategories: CategoryStat[] = Object.entries(catTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([category, total]) => ({
      category,
      total,
      share: periodTotal > 0 ? total / periodTotal : 0,
      budget: budgets[category] ? budgets[category] * 12 : undefined,
    }));

  // Daily for sparkline (year's days, anchored to year end or today)
  const dailyAnchor = isCurrentYear ? now : yearEnd;
  const daily = Array.from({ length: 365 }, (_, i) => {
    const d = subDays(dailyAnchor, 364 - i);
    const key = format(d, "yyyy-MM-dd");
    const total = expenses
      .filter((e) => isSameDay(parseISO(e.date), d))
      .reduce((s, e) => s + e.amount, 0);
    return { date: key, total };
  });

  const recentEntries = [...expenses]
    .sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime())
    .slice(0, 5);

  const monthlySparkline = monthlyBuckets.slice();

  // suppress unused var warning
  void refDate;

  return {
    period: "year",
    label: String(refYear),
    periodTotal,
    prevTotal,
    changePct: prevTotal > 0 ? (periodTotal - prevTotal) / prevTotal : 0,
    daysElapsed,
    daysInPeriod,
    monthlyTotals,
    topCategories,
    daily,
    monthlySparkline,
    recentEntries,
  };
}

// ─── Week comparison ──────────────────────────────────────────────────────────

export function computeWeekAnalytics(expenses: Expense[]): WeekAnalytics {
  const now = new Date();
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const thisWeekDays = Array.from({ length: 7 }, (_, i) => subDays(now, 6 - i));
  const prevWeekDays = Array.from({ length: 7 }, (_, i) => subDays(now, 13 - i));

  const bucket = (d: Date) =>
    expenses
      .filter((e) => isSameDay(parseISO(e.date), d))
      .reduce((s, e) => s + e.amount, 0);

  const thisWeekDailyTotals = thisWeekDays.map(bucket);
  const prevWeekTotal = prevWeekDays.map(bucket).reduce((s, v) => s + v, 0);
  const thisWeekTotal = thisWeekDailyTotals.reduce((s, v) => s + v, 0);

  return {
    thisWeek: thisWeekTotal,
    prevWeek: prevWeekTotal,
    changePct: prevWeekTotal > 0 ? (thisWeekTotal - prevWeekTotal) / prevWeekTotal : 0,
    dailyThisWeek: thisWeekDays.map((d, i) => ({
      date: format(d, "yyyy-MM-dd"),
      total: thisWeekDailyTotals[i],
      label: DAYS[d.getDay()],
    })),
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function colorFromString(str: string): string {
  if (!str) return "#5A6478";
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 62%)`;
}
