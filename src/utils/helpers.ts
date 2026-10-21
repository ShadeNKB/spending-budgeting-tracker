import type { Expense, ValidationResult } from '../types'

// NOTE: For currency display, use `formatMoney` from `src/lib/format.ts` (the canonical formatter).
// For category colours, use `colorFromString` from `src/lib/analytics.ts`.

export const generateId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export const validateExpenseData = (data: Partial<Expense>): ValidationResult => {
  const errors: string[] = []

  if (!data.itemName || data.itemName.trim().length < 2) {
    errors.push('Item name must be at least 2 characters')
  }

  const amount = parseFloat(String(data.amount ?? ''))
  if (isNaN(amount) || amount <= 0) {
    errors.push('Amount must be a positive number')
  }

  if (!data.date) {
    errors.push('Please select a valid date')
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

export const debounce = <T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout)
      func(...args)
    }
    clearTimeout(timeout)
    timeout = setTimeout(later, wait)
  }
}
