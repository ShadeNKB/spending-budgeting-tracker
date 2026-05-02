import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorFromString,
  computeMonthAnalytics,
  computeWeekAnalytics,
} from "./analytics";
import type { Expense } from "../types";

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  itemName: over.itemName ?? "coffee",
  amount: over.amount ?? 5,
  category: over.category ?? "Food & Drink",
  date: over.date ?? "2026-05-02T10:00:00.000Z",
  createdAt: over.createdAt ?? "2026-05-02T10:00:00.000Z",
  ...over,
});

describe("colorFromString", () => {
  it("returns a stable color for the same input", () => {
    expect(colorFromString("Food")).toBe(colorFromString("Food"));
  });

  it("returns a fallback for empty input", () => {
    expect(colorFromString("")).toBe("#5A6478");
  });

  it("produces an hsl() value", () => {
    expect(colorFromString("Transport")).toMatch(/^hsl\(\d+, 65%, 62%\)$/);
  });
});

describe("computeMonthAnalytics", () => {
  afterEach(() => vi.useRealTimers());

  it("sums month total, today total, and computes prev-month change", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

    const expenses: Expense[] = [
      expense({ amount: 10, date: "2026-05-15T10:00:00.000Z" }), // today
      expense({ amount: 20, date: "2026-05-10T10:00:00.000Z" }), // this month
      expense({ amount: 30, date: "2026-04-20T10:00:00.000Z" }), // prev month
      expense({ amount: 40, date: "2026-03-01T10:00:00.000Z" }), // not counted
    ];

    const a = computeMonthAnalytics(expenses, {});
    expect(a.periodTotal).toBe(30);
    expect(a.prevTotal).toBe(30);
    expect(a.changePct).toBe(0);
    expect(a.todayTotal).toBe(10);
    expect(a.todayCount).toBe(1);
    expect(a.label).toBe("May 2026");
  });

  it("ranks topCategories by amount descending and computes share", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

    const expenses: Expense[] = [
      expense({ amount: 100, category: "Food", date: "2026-05-01T10:00:00.000Z" }),
      expense({ amount: 50, category: "Transport", date: "2026-05-02T10:00:00.000Z" }),
      expense({ amount: 50, category: "Food", date: "2026-05-03T10:00:00.000Z" }),
    ];

    const a = computeMonthAnalytics(expenses, {});
    expect(a.topCategories[0].category).toBe("Food");
    expect(a.topCategories[0].total).toBe(150);
    expect(a.topCategories[0].share).toBeCloseTo(0.75, 2);
    expect(a.topCategories[1].category).toBe("Transport");
  });

  it("computes paceRatio against budget proportional to days elapsed", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z")); // day 15 of 31

    const expenses: Expense[] = [
      expense({ amount: 200, date: "2026-05-10T10:00:00.000Z" }),
    ];
    const budgets = { "Food & Drink": 620 }; // expectedByNow = 620 * 15/31 = 300

    const a = computeMonthAnalytics(expenses, budgets);
    expect(a.paceRatio).toBeCloseTo(200 / 300, 2);
  });

  it("returns zero pace when no budget set", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    const a = computeMonthAnalytics([expense({ amount: 50 })], {});
    expect(a.paceRatio).toBe(0);
    expect(a.totalBudget).toBe(0);
  });
});

describe("computeWeekAnalytics", () => {
  afterEach(() => vi.useRealTimers());

  it("totals last 7 days vs the prior 7 days", () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

    const expenses: Expense[] = [
      expense({ amount: 30, date: "2026-05-14T10:00:00.000Z" }), // this week
      expense({ amount: 10, date: "2026-05-09T10:00:00.000Z" }), // this week (day 6)
      expense({ amount: 50, date: "2026-05-05T10:00:00.000Z" }), // prev week
    ];

    const w = computeWeekAnalytics(expenses);
    expect(w.thisWeek).toBe(40);
    expect(w.prevWeek).toBe(50);
    expect(w.dailyThisWeek).toHaveLength(7);
  });
});
