import type { Expense, CategoryMappings, CategoryColors, CategoryBudgets } from "../types";

const KEY_EXPENSES = "expenses";
const KEY_CATEGORIES = "categories";
const KEY_MAPPINGS = "categoryMappings";
const KEY_COLORS = "categoryColors";
const KEY_BUDGETS = "categoryBudgets";
const KEY_SYNC_ID = "syncId";

/**
 * Quota-aware setItem — every persistence write goes through this.
 * If quota is exhausted (5 MB on most browsers, sometimes 2 MB on iOS Safari),
 * we surface the error to subscribers so the app can warn the user instead of
 * silently losing data. The custom event fires once per quota incident.
 */
export class StorageQuotaError extends Error {
  constructor(public key: string, public bytes: number) {
    super(`localStorage quota exceeded while writing "${key}" (${bytes} bytes).`);
    this.name = "StorageQuotaError";
  }
}

let quotaWarned = false;
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    const isQuota =
      err instanceof DOMException &&
      // 22 = QuotaExceededError; 1014 = NS_ERROR_DOM_QUOTA_REACHED (Firefox)
      (err.code === 22 || err.code === 1014 || err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    if (isQuota) {
      if (!quotaWarned && typeof window !== "undefined") {
        quotaWarned = true;
        window.dispatchEvent(new CustomEvent("spendtrack:quota-exceeded", { detail: { key, bytes: value.length } }));
      }
      throw new StorageQuotaError(key, value.length);
    }
    throw err;
  }
}

export const storage = {
  getExpenses(): Expense[] {
    try {
      const raw = localStorage.getItem(KEY_EXPENSES);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as Expense[];
    } catch {
      try {
        const raw = localStorage.getItem(KEY_EXPENSES);
        if (raw) {
          const repaired = raw.replace(/,(\s*[}\]])/g, "$1");
          const parsed = JSON.parse(repaired) as unknown;
          if (Array.isArray(parsed)) return parsed as Expense[];
        }
      } catch {
        localStorage.removeItem(KEY_EXPENSES);
      }
    }
    return [];
  },

  saveExpenses(data: Expense[]): void {
    safeSet(KEY_EXPENSES, JSON.stringify(data));
  },

  getCategories(): string[] | null {
    try {
      const raw = localStorage.getItem(KEY_CATEGORIES);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
    } catch {
      localStorage.removeItem(KEY_CATEGORIES);
    }
    return null;
  },

  saveCategories(data: string[]): void {
    safeSet(KEY_CATEGORIES, JSON.stringify(data));
  },

  getCategoryMappings(): CategoryMappings {
    try {
      const raw = localStorage.getItem(KEY_MAPPINGS);
      if (raw) return JSON.parse(raw) as CategoryMappings;
    } catch {
      localStorage.removeItem(KEY_MAPPINGS);
    }
    return {};
  },

  saveCategoryMappings(data: CategoryMappings): void {
    safeSet(KEY_MAPPINGS, JSON.stringify(data));
  },

  getCategoryColors(): CategoryColors {
    try {
      const raw = localStorage.getItem(KEY_COLORS);
      if (raw) return JSON.parse(raw) as CategoryColors;
    } catch {
      localStorage.removeItem(KEY_COLORS);
    }
    return {};
  },

  saveCategoryColors(data: CategoryColors): void {
    safeSet(KEY_COLORS, JSON.stringify(data));
  },

  getBudgets(): CategoryBudgets {
    try {
      const raw = localStorage.getItem(KEY_BUDGETS);
      if (raw) return JSON.parse(raw) as CategoryBudgets;
    } catch {
      localStorage.removeItem(KEY_BUDGETS);
    }
    return {};
  },

  saveBudgets(data: CategoryBudgets): void {
    safeSet(KEY_BUDGETS, JSON.stringify(data));
  },

  saveAll(
    expenses: Expense[],
    categories: string[],
    mappings: CategoryMappings,
    budgets?: CategoryBudgets
  ): void {
    this.saveExpenses(expenses);
    this.saveCategories(categories);
    this.saveCategoryMappings(mappings);
    if (budgets !== undefined) this.saveBudgets(budgets);
  },

  getSyncId(): string | null {
    return localStorage.getItem(KEY_SYNC_ID);
  },

  saveSyncId(id: string | null): void {
    if (id === null) {
      localStorage.removeItem(KEY_SYNC_ID);
    } else {
      safeSet(KEY_SYNC_ID, id);
    }
  },
};
