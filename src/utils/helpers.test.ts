import { describe, expect, it } from "vitest";
import {
  generateId,
  validateExpenseData,
  migrateExpenseCategory,
  migrateExpenses,
} from "./helpers";
import type { Expense } from "../types";

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: over.id ?? "x",
  itemName: over.itemName ?? "thing",
  amount: over.amount ?? 1,
  category: over.category ?? "Other",
  date: over.date ?? "2026-05-01",
  createdAt: over.createdAt ?? "2026-05-01",
  ...over,
});

describe("generateId", () => {
  it("returns unique-ish ids on consecutive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});

describe("validateExpenseData", () => {
  it("requires a 2+ char name, positive amount, and date", () => {
    const r = validateExpenseData({ itemName: "a", amount: 0 });
    expect(r.isValid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("passes a valid record", () => {
    const r = validateExpenseData({
      itemName: "coffee",
      amount: 4.5,
      date: "2026-05-01",
    });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("migrateExpenseCategory", () => {
  it("applies flat category renames", () => {
    const e = expense({ category: "Bills & Utilities" });
    expect(migrateExpenseCategory(e).category).toBe("Travel");
  });

  it("applies keyword-based category overrides", () => {
    const e = expense({ itemName: "Netflix subscription", category: "Other" });
    expect(migrateExpenseCategory(e).category).toBe("Subscriptions");
  });

  it("leaves unrelated expenses untouched", () => {
    const e = expense({ itemName: "groceries", category: "Food & Dining" });
    expect(migrateExpenseCategory(e)).toEqual(e);
  });

  it("migrateExpenses applies migration to every entry", () => {
    const out = migrateExpenses([
      expense({ category: "Education" }),
      expense({ category: "Other" }),
    ]);
    expect(out[0].category).toBe("Subscriptions");
    expect(out[1].category).toBe("Other");
  });
});

