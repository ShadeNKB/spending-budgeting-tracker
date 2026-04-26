import { CATEGORY_MIGRATIONS, ITEM_CATEGORY_PATTERNS } from "../constants";
import type { Expense, ValidationResult } from "../types";

export const formatCurrency = (amount: number | string): string => {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(num);
};

export const generateId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

export const validateExpenseData = (data: Partial<Expense>): ValidationResult => {
  const errors: string[] = [];

  if (!data.itemName || data.itemName.trim().length < 2) {
    errors.push("Item name must be at least 2 characters");
  }

  const amount = parseFloat(String(data.amount ?? ""));
  if (isNaN(amount) || amount <= 0) {
    errors.push("Amount must be a positive number");
  }

  if (!data.date) {
    errors.push("Please select a valid date");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

export const debounce = <T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>;
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

export const migrateExpenseCategory = (expense: Expense): Expense => {
  const flatMigrated = CATEGORY_MIGRATIONS[expense.category] ?? expense.category;
  const nameLower = (expense.itemName || "").toLowerCase();

  for (const rule of ITEM_CATEGORY_PATTERNS) {
    if (!rule.fromCategories.includes(flatMigrated) && !rule.fromCategories.includes(expense.category)) {
      continue;
    }
    if (rule.keywords.some((kw) => nameLower.includes(kw))) {
      return { ...expense, category: rule.category };
    }
  }

  return flatMigrated !== expense.category
    ? { ...expense, category: flatMigrated }
    : expense;
};

export const migrateExpenses = (expenses: Expense[]): Expense[] =>
  expenses.map(migrateExpenseCategory);

export const generateColorFromString = (str: string): string => {
  if (!str) return "#9ca3af";

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
};
