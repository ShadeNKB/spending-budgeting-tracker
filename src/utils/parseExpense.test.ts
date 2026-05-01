import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExpense } from "./parseExpense";

describe("parseExpense", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts item, amount, learned category, and yesterday date", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00"));

    const parsed = parseExpense("coffee 4.50 yesterday", {
      coffee: "Food & Drink",
    });

    expect(parsed).toMatchObject({
      itemName: "coffee",
      amount: 4.5,
      suggestedCategory: "Food & Drink",
      confidence: 1,
      parsedDate: "2026-04-30",
    });
  });

  it("returns an incomplete result for empty input", () => {
    expect(parseExpense("   ", {})).toEqual({
      itemName: "",
      amount: null,
      raw: "",
    });
  });

  it("keeps uncategorized parsed entries usable when no mapping matches", () => {
    const parsed = parseExpense("spotify premium 15", {
      coffee: "Food & Drink",
    });

    expect(parsed.itemName).toBe("spotify premium");
    expect(parsed.amount).toBe(15);
    expect(parsed.suggestedCategory).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });
});
