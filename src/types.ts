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
  /**
   * Fields beside the ones above, as the data core carries them. `kind` is read from here
   * (lib/kind.ts): absent for an expense, `'income'` for money in, `'refund'` for money back.
   */
  ext?: Readonly<Record<string, Json>>
}

/**
 * What components receive from the store: a live entry, identity-stable while unchanged.
 * `day` is always present (`rec.day ?? localDay(date)` in this device's zone); `ext` holds the
 * entry's kind and pass-through fields from newer versions.
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

export type CategoryMappings = Record<string, string>
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
