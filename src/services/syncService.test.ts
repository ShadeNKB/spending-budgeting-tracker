import { describe, it, expect } from "vitest";
import { mergeBackups } from "./syncService";
import type { BackupData, Expense } from "../types";

// Test the per-expense Last-Write-Wins merge + tombstone semantics.
// This is the single most correctness-critical function in the app —
// every cross-device sync round-trip flows through it.

const expense = (over: Partial<Expense> & { id: string; createdAt: string }): Expense => ({
  itemName: "Coffee",
  amount: 4.5,
  category: "Food & Dining",
  date: over.createdAt,
  ...over,
});

const backup = (over: Partial<BackupData> = {}): BackupData => ({
  expenses: [],
  categories: ["Food & Dining"],
  categoryMappings: {},
  budgets: {},
  deletedIds: [],
  exportDate: "2026-05-08T00:00:00.000Z",
  version: "3.0",
  ...over,
});

describe("mergeBackups", () => {
  describe("expense merge — Last-Write-Wins", () => {
    it("keeps both when expense IDs don't overlap", () => {
      const local = backup({
        expenses: [expense({ id: "a", createdAt: "2026-05-01T12:00:00Z" })],
      });
      const remote = backup({
        expenses: [expense({ id: "b", createdAt: "2026-05-02T12:00:00Z" })],
      });
      const out = mergeBackups(local, remote);
      const ids = out.expenses.map((e) => e.id).sort();
      expect(ids).toEqual(["a", "b"]);
    });

    it("picks the newer copy when same ID exists on both, by updatedAt", () => {
      const local = backup({
        expenses: [
          expense({
            id: "a",
            itemName: "Local edit",
            createdAt: "2026-05-01T12:00:00Z",
            updatedAt: "2026-05-03T12:00:00Z",
          }),
        ],
      });
      const remote = backup({
        expenses: [
          expense({
            id: "a",
            itemName: "Remote edit",
            createdAt: "2026-05-01T12:00:00Z",
            updatedAt: "2026-05-02T12:00:00Z",
          }),
        ],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses).toHaveLength(1);
      expect(out.expenses[0].itemName).toBe("Local edit");
    });

    it("falls back to createdAt when updatedAt is absent", () => {
      const local = backup({
        expenses: [
          expense({
            id: "a",
            itemName: "Older",
            createdAt: "2026-05-01T12:00:00Z",
          }),
        ],
      });
      const remote = backup({
        expenses: [
          expense({
            id: "a",
            itemName: "Newer",
            createdAt: "2026-05-05T12:00:00Z",
          }),
        ],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses[0].itemName).toBe("Newer");
    });

    it("local wins when timestamps tie (deterministic)", () => {
      const same = "2026-05-01T12:00:00Z";
      const local = backup({
        expenses: [expense({ id: "a", itemName: "Local", createdAt: same, updatedAt: same })],
      });
      const remote = backup({
        expenses: [expense({ id: "a", itemName: "Remote", createdAt: same, updatedAt: same })],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses[0].itemName).toBe("Local");
    });

    it("sorts merged expenses by date desc", () => {
      const local = backup({
        expenses: [
          expense({ id: "old", createdAt: "2026-04-01T12:00:00Z", date: "2026-04-01T12:00:00Z" }),
          expense({ id: "newest", createdAt: "2026-05-08T12:00:00Z", date: "2026-05-08T12:00:00Z" }),
        ],
      });
      const remote = backup({
        expenses: [
          expense({ id: "mid", createdAt: "2026-05-01T12:00:00Z", date: "2026-05-01T12:00:00Z" }),
        ],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses.map((e) => e.id)).toEqual(["newest", "mid", "old"]);
    });
  });

  describe("tombstones — deletions propagate", () => {
    it("does not resurrect an expense if either side has its ID in deletedIds", () => {
      const local = backup({
        expenses: [],
        deletedIds: ["a"],
      });
      const remote = backup({
        expenses: [expense({ id: "a", itemName: "Should not appear", createdAt: "2026-05-01T12:00:00Z" })],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses).toHaveLength(0);
      expect(out.deletedIds).toContain("a");
    });

    it("unions tombstones across both sides", () => {
      const local = backup({ deletedIds: ["a", "b"] });
      const remote = backup({ deletedIds: ["b", "c"] });
      const out = mergeBackups(local, remote);
      expect((out.deletedIds ?? []).slice().sort()).toEqual(["a", "b", "c"]);
    });

    it("tombstone wins even if the expense was edited on the other device", () => {
      // Device A deleted expense X. Device B edited X (without seeing the delete).
      // The delete must win — otherwise deleted items resurrect after sync.
      const local = backup({
        expenses: [],
        deletedIds: ["x"],
      });
      const remote = backup({
        expenses: [
          expense({
            id: "x",
            itemName: "Edited after delete elsewhere",
            createdAt: "2026-05-01T12:00:00Z",
            updatedAt: "2026-05-09T12:00:00Z", // newer than the delete
          }),
        ],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses.find((e) => e.id === "x")).toBeUndefined();
    });
  });

  describe("categories & budgets", () => {
    it("unions categories with local-first ordering, deduped", () => {
      const local = backup({ categories: ["Food", "Travel"] });
      const remote = backup({ categories: ["Travel", "Subscriptions"] });
      const out = mergeBackups(local, remote);
      expect(out.categories).toEqual(["Food", "Travel", "Subscriptions"]);
    });

    it("falls back to default categories if neither side has any", () => {
      const local = backup({ categories: [] });
      const remote = backup({ categories: [] });
      const out = mergeBackups(local, remote);
      expect(out.categories.length).toBeGreaterThan(0);
    });

    it("merges budgets with remote-wins on key conflict", () => {
      const local = backup({ budgets: { Food: 100, Travel: 200 } });
      const remote = backup({ budgets: { Food: 150, Subscriptions: 50 } });
      const out = mergeBackups(local, remote);
      expect(out.budgets).toEqual({ Food: 150, Travel: 200, Subscriptions: 50 });
    });

    it("merges categoryMappings with remote-wins on key conflict", () => {
      const local = backup({ categoryMappings: { coffee: "Food", uber: "Travel" } });
      const remote = backup({ categoryMappings: { coffee: "Beverages" } });
      const out = mergeBackups(local, remote);
      expect(out.categoryMappings).toEqual({ coffee: "Beverages", uber: "Travel" });
    });
  });

  describe("output shape", () => {
    it("emits a fresh exportDate and the current version", () => {
      const out = mergeBackups(backup(), backup());
      expect(out.version).toBe("3.0");
      expect(new Date(out.exportDate).getTime()).not.toBeNaN();
    });

    it("never returns a non-finite expense or undefined deletedIds", () => {
      const out = mergeBackups(backup(), backup());
      expect(Array.isArray(out.expenses)).toBe(true);
      expect(Array.isArray(out.deletedIds)).toBe(true);
    });
  });

  describe("missing optional fields", () => {
    it("treats undefined deletedIds on either side as empty", () => {
      const local = { ...backup({ expenses: [] }), deletedIds: undefined as unknown as string[] };
      const remote = backup({
        expenses: [expense({ id: "a", createdAt: "2026-05-01T12:00:00Z" })],
      });
      const out = mergeBackups(local, remote);
      expect(out.expenses).toHaveLength(1);
      expect(out.deletedIds).toEqual([]);
    });
  });
});
