import { beforeEach, describe, expect, it } from "vitest";
import { storage } from "./storage";
import type { Expense } from "../types";

const sample: Expense = {
  id: "abc",
  itemName: "coffee",
  amount: 4.5,
  category: "Food & Drink",
  date: "2026-05-02T10:00:00.000Z",
  createdAt: "2026-05-02T10:00:00.000Z",
};

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips expenses, categories, mappings, and budgets via saveAll", () => {
    storage.saveAll([sample], ["Food & Drink"], { coffee: "Food & Drink" }, { "Food & Drink": 200 });

    expect(storage.getExpenses()).toEqual([sample]);
    expect(storage.getCategories()).toEqual(["Food & Drink"]);
    expect(storage.getCategoryMappings()).toEqual({ coffee: "Food & Drink" });
    expect(storage.getBudgets()).toEqual({ "Food & Drink": 200 });
  });

  it("returns empty defaults when no data is stored", () => {
    expect(storage.getExpenses()).toEqual([]);
    expect(storage.getCategories()).toBeNull();
    expect(storage.getCategoryMappings()).toEqual({});
    expect(storage.getBudgets()).toEqual({});
  });

  it("recovers from a trailing-comma-corrupted expenses payload", () => {
    localStorage.setItem(
      "expenses",
      '[{"id":"1","itemName":"x","amount":1,"category":"Other","date":"2026-05-01","createdAt":"2026-05-01"},]'
    );
    const result = storage.getExpenses();
    expect(result).toHaveLength(1);
    expect(result[0].itemName).toBe("x");
  });

  it("clears unrecoverable corrupted payloads instead of throwing", () => {
    localStorage.setItem("categoryMappings", "{not valid json}");
    expect(storage.getCategoryMappings()).toEqual({});
    expect(localStorage.getItem("categoryMappings")).toBeNull();
  });

  it("treats an empty array of categories as missing (returns null)", () => {
    storage.saveCategories([]);
    expect(storage.getCategories()).toBeNull();
  });
});
