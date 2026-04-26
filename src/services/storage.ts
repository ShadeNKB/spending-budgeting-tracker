import type { Expense, CategoryMappings, CategoryColors, CategoryBudgets } from "../types";

const KEY_EXPENSES = "expenses";
const KEY_CATEGORIES = "categories";
const KEY_MAPPINGS = "categoryMappings";
const KEY_COLORS = "categoryColors";
const KEY_BUDGETS = "categoryBudgets";

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
    localStorage.setItem(KEY_EXPENSES, JSON.stringify(data));
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
    localStorage.setItem(KEY_CATEGORIES, JSON.stringify(data));
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
    localStorage.setItem(KEY_MAPPINGS, JSON.stringify(data));
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
    localStorage.setItem(KEY_COLORS, JSON.stringify(data));
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
    localStorage.setItem(KEY_BUDGETS, JSON.stringify(data));
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
};
