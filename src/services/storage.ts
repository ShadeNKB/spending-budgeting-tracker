import type {
  Expense,
  CategoryMappings,
  CategoryColors,
  CategoryBudgets,
  CategoryBudgetTimestamps,
} from '../types'
import { isNumber, isString, listOf, recordOf } from '../lib/backup'

const KEY_EXPENSES = 'expenses'
const KEY_CATEGORIES = 'categories'
const KEY_MAPPINGS = 'categoryMappings'
const KEY_COLORS = 'categoryColors'
const KEY_BUDGETS = 'categoryBudgets'
const KEY_BUDGET_UPDATED_AT = 'categoryBudgetUpdatedAt'
const KEY_BUDGET_DELETED_AT = 'categoryBudgetDeletedAt'
const KEY_DELETED_IDS = 'deletedExpenseIds'
const KEY_SYNC_ID = 'syncId'
const KEY_APP = 'spendtrack:app'
const KEY_DEVICE = 'spendtrack:dev'

/**
 * Protocol version of this writer, not the display version: it marks local data written by
 * this build (`spendtrack:app`) and every push (`wr.app`), so later engines know the writer.
 */
export const WRITER_VERSION = '0.8.5'

const DEVICE_ID_PATTERN = /^[0-9a-z]{6}$/
// Kept for the session when storage refuses the write, so pushes keep one device id.
let sessionDeviceId: string | null = null

function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

/**
 * Quota-aware setItem — every persistence write goes through this.
 * If quota is exhausted (5 MB on most browsers, sometimes 2 MB on iOS Safari),
 * we surface the error to subscribers so the app can warn the user instead of
 * silently losing data. The custom event fires once per quota incident.
 */
export class StorageQuotaError extends Error {
  constructor(
    public key: string,
    public bytes: number,
  ) {
    super(`localStorage quota exceeded while writing "${key}" (${bytes} bytes).`)
    this.name = 'StorageQuotaError'
  }
}

let quotaWarned = false
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    // Match on `name` — the deprecated numeric `code` (22 / 1014) is derived from it.
    // NS_ERROR_DOM_QUOTA_REACHED is the legacy Firefox name.
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    if (isQuota) {
      if (!quotaWarned && typeof window !== 'undefined') {
        quotaWarned = true
        window.dispatchEvent(
          new CustomEvent('spendtrack:quota-exceeded', { detail: { key, bytes: value.length } }),
        )
      }
      throw new StorageQuotaError(key, value.length)
    }
    throw err
  }
}

export const storage = {
  getExpenses(): Expense[] {
    try {
      const raw = localStorage.getItem(KEY_EXPENSES)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed as Expense[]
    } catch {
      try {
        const raw = localStorage.getItem(KEY_EXPENSES)
        if (raw) {
          const repaired = raw.replace(/,(\s*[}\]])/g, '$1')
          const parsed = JSON.parse(repaired) as unknown
          if (Array.isArray(parsed)) return parsed as Expense[]
        }
      } catch {
        localStorage.removeItem(KEY_EXPENSES)
      }
    }
    return []
  },

  saveExpenses(data: Expense[]): void {
    safeSet(KEY_EXPENSES, JSON.stringify(data))
  },

  getCategories(): string[] | null {
    try {
      const raw = localStorage.getItem(KEY_CATEGORIES)
      if (!raw) return null
      const categories = listOf(JSON.parse(raw), isString)
      if (categories.length > 0) return categories
    } catch {
      localStorage.removeItem(KEY_CATEGORIES)
    }
    return null
  },

  saveCategories(data: string[]): void {
    safeSet(KEY_CATEGORIES, JSON.stringify(data))
  },

  getCategoryMappings(): CategoryMappings {
    try {
      const raw = localStorage.getItem(KEY_MAPPINGS)
      if (raw) return recordOf(JSON.parse(raw), isString)
    } catch {
      localStorage.removeItem(KEY_MAPPINGS)
    }
    return {}
  },

  saveCategoryMappings(data: CategoryMappings): void {
    safeSet(KEY_MAPPINGS, JSON.stringify(data))
  },

  getCategoryColors(): CategoryColors {
    try {
      const raw = localStorage.getItem(KEY_COLORS)
      if (raw) return JSON.parse(raw) as CategoryColors
    } catch {
      localStorage.removeItem(KEY_COLORS)
    }
    return {}
  },

  saveCategoryColors(data: CategoryColors): void {
    safeSet(KEY_COLORS, JSON.stringify(data))
  },

  getBudgets(): CategoryBudgets {
    try {
      const raw = localStorage.getItem(KEY_BUDGETS)
      if (raw) return recordOf(JSON.parse(raw), isNumber)
    } catch {
      localStorage.removeItem(KEY_BUDGETS)
    }
    return {}
  },

  saveBudgets(data: CategoryBudgets): void {
    safeSet(KEY_BUDGETS, JSON.stringify(data))
  },

  getBudgetUpdatedAt(): CategoryBudgetTimestamps {
    try {
      const raw = localStorage.getItem(KEY_BUDGET_UPDATED_AT)
      if (raw) return recordOf(JSON.parse(raw), isString)
    } catch {
      localStorage.removeItem(KEY_BUDGET_UPDATED_AT)
    }
    return {}
  },

  saveBudgetUpdatedAt(data: CategoryBudgetTimestamps): void {
    safeSet(KEY_BUDGET_UPDATED_AT, JSON.stringify(data))
  },

  getBudgetDeletedAt(): CategoryBudgetTimestamps {
    try {
      const raw = localStorage.getItem(KEY_BUDGET_DELETED_AT)
      if (raw) return recordOf(JSON.parse(raw), isString)
    } catch {
      localStorage.removeItem(KEY_BUDGET_DELETED_AT)
    }
    return {}
  },

  saveBudgetDeletedAt(data: CategoryBudgetTimestamps): void {
    safeSet(KEY_BUDGET_DELETED_AT, JSON.stringify(data))
  },

  getDeletedIds(): string[] {
    try {
      const raw = localStorage.getItem(KEY_DELETED_IDS)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string')
    } catch {
      localStorage.removeItem(KEY_DELETED_IDS)
    }
    return []
  },

  saveDeletedIds(data: string[]): void {
    safeSet(KEY_DELETED_IDS, JSON.stringify(data))
  },

  saveAll(
    expenses: Expense[],
    categories: string[],
    mappings: CategoryMappings,
    budgets?: CategoryBudgets,
    budgetUpdatedAt?: CategoryBudgetTimestamps,
    budgetDeletedAt?: CategoryBudgetTimestamps,
    deletedIds?: string[],
  ): void {
    this.saveExpenses(expenses)
    this.saveCategories(categories)
    this.saveCategoryMappings(mappings)
    if (budgets !== undefined) this.saveBudgets(budgets)
    if (budgetUpdatedAt !== undefined) this.saveBudgetUpdatedAt(budgetUpdatedAt)
    if (budgetDeletedAt !== undefined) this.saveBudgetDeletedAt(budgetDeletedAt)
    if (deletedIds !== undefined) this.saveDeletedIds(deletedIds)
    try {
      safeSet(KEY_APP, WRITER_VERSION)
    } catch {
      // The marker is best-effort; the data keys above are what matter.
    }
  },

  /** This device's id for writer stamps: 6 base36 chars, created once (`spendtrack:dev`). */
  getDeviceId(): string {
    try {
      const stored = localStorage.getItem(KEY_DEVICE)
      if (stored !== null && DEVICE_ID_PATTERN.test(stored)) return stored
    } catch {
      // Storage unavailable: fall through to the session id.
    }
    sessionDeviceId ??= newDeviceId()
    try {
      safeSet(KEY_DEVICE, sessionDeviceId)
    } catch {
      // Not persisted; the id still holds for this session.
    }
    return sessionDeviceId
  },

  getSyncId(): string | null {
    return localStorage.getItem(KEY_SYNC_ID)
  },

  saveSyncId(id: string | null): void {
    if (id === null) {
      localStorage.removeItem(KEY_SYNC_ID)
    } else {
      safeSet(KEY_SYNC_ID, id)
    }
  },
}
