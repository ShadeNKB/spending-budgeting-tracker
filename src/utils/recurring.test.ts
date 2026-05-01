import { afterEach, describe, expect, it, vi } from "vitest";
import { detectRecurring, forecastDailyFromRecurring } from "./recurring";
import type { Expense } from "../types";

const expense = (id: string, itemName: string, date: string, amount = 15): Expense => ({
  id,
  itemName,
  amount,
  category: "Subscriptions",
  date: `${date}T12:00:00.000Z`,
  createdAt: `${date}T12:00:00.000Z`,
});

describe("recurring expenses", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects consistent monthly charges", () => {
    const groups = detectRecurring([
      expense("1", "Netflix", "2026-01-01"),
      expense("2", "Netflix", "2026-02-01"),
      expense("3", "Netflix", "2026-03-01"),
      expense("4", "Coffee", "2026-03-02", 4.5),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "netflix",
      displayName: "Netflix",
      periodicity: "monthly",
      avgAmount: 15,
    });
  });

  it("forecasts recurring charges into the requested window", () => {
    vi.setSystemTime(new Date("2026-04-01T12:00:00"));

    const groups = detectRecurring([
      expense("1", "Spotify", "2026-01-01", 12),
      expense("2", "Spotify", "2026-02-01", 12),
      expense("3", "Spotify", "2026-03-01", 12),
    ]);
    const forecast = forecastDailyFromRecurring(groups, 35);

    expect(forecast.reduce((sum, value) => sum + value, 0)).toBe(12);
  });
});
