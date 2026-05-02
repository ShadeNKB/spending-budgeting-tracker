export interface Expense {
  id: string;
  itemName: string;
  amount: number;
  category: string;
  date: string;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Filters {
  dateRange: "today" | "week" | "month" | "year" | "all" | "custom";
  category: string;
  search: string;
  customStart?: string;
  customEnd?: string;
}

export interface Analytics {
  total: number;
  count: number;
  dailyAverage: number;
  categoryTotals: Record<string, number>;
  sortedCategories: [string, number][];
  highestCategory: string | null;
  todayTotal: number;
  todayCount: number;
  thisMonthTotal: number;
  lastMonthTotal: number;
  monthOverMonth: number;
}

export interface Notification {
  message: string;
  type: "success" | "error" | "warning";
  id: number;
}

export type CategoryMappings = Record<string, string>;
export type CategoryColors = Record<string, string>;
export type CategoryBudgets = Record<string, number>;

export interface BackupData {
  expenses: Expense[];
  categories: string[];
  categoryMappings: CategoryMappings;
  budgets?: CategoryBudgets;
  deletedIds?: string[];
  exportDate: string;
  version: string;
}

export interface DrillPeriod {
  type: "day" | "month";
  label: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ItemCategoryPattern {
  category: string;
  fromCategories: string[];
  keywords: string[];
}
