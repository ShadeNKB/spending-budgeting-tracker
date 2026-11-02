import type { Json } from './data/core/types'

export type { Json }

export interface Expense {
  id: string
  itemName: string
  amount: number
  category: string
  /** The stored v4 instant. Readers bucket on `day`, never on this. */
  date: string
  /** The owner's calendar day ('yyyy-MM-dd'); every v5 write sets it (P2-2). */
  day?: string
  notes?: string
  createdAt: string
  updatedAt?: string
}

/**
 * What components receive from the store: a live entry, identity-stable while unchanged.
 * `day` is always present (`rec.day ?? localDay(date)` in this device's zone); `ext` holds
 * pass-through fields from newer versions.
 */
export interface ExpenseView extends Expense {
  readonly day: string
  readonly ext: Readonly<Record<string, Json>>
}

export interface Filters {
  dateRange: 'today' | 'week' | 'month' | 'year' | 'all' | 'custom'
  category: string
  search: string
  customStart?: string
  customEnd?: string
}

export interface Analytics {
  total: number
  count: number
  dailyAverage: number
  categoryTotals: Record<string, number>
  sortedCategories: [string, number][]
  highestCategory: string | null
  todayTotal: number
  todayCount: number
  thisMonthTotal: number
  lastMonthTotal: number
  monthOverMonth: number
}

export interface Notification {
  message: string
  type: 'success' | 'error' | 'warning'
  id: number
}

export type CategoryMappings = Record<string, string>
export type CategoryColors = Record<string, string>
export type CategoryBudgets = Record<string, number>
export type CategoryBudgetTimestamps = Record<string, string>
/** When each item mapping was last set (ISO). Keys without a stamp are older than any stamp. */
export type CategoryMappingTimestamps = Record<string, string>

export interface BackupData {
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  mappingUpdatedAt?: CategoryMappingTimestamps
  budgets?: CategoryBudgets
  budgetUpdatedAt?: CategoryBudgetTimestamps
  budgetDeletedAt?: CategoryBudgetTimestamps
  deletedIds?: string[]
  exportDate: string
  version: string
}

export interface DrillPeriod {
  type: 'day' | 'month'
  label: string
}
