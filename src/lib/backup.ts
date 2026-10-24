import { isValid, parseISO } from 'date-fns'
import type { BackupData, Expense } from '../types'

// Runtime validation for data that crosses a trust boundary. Backup files and
// localStorage are untrusted until they pass through these guards.

export const MAX_IMPORT_EXPENSES = 50_000 // sanity cap to avoid freezing the browser

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isString = (value: unknown): value is string => typeof value === 'string'

export const isNumber = (value: unknown): value is number => typeof value === 'number'

/** Keeps the items that pass `isItem`; anything that is not an array becomes `[]`. */
export function listOf<T>(value: unknown, isItem: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(isItem) : []
}

/**
 * Keeps the entries that pass `isEntry`; anything that is not a plain object becomes `{}`.
 * Built from entries, so a key named "__proto__" stays a key: assigning it would hit the
 * prototype setter and drop it, and the device holding it would disagree with every other.
 */
export function recordOf<T>(
  value: unknown,
  isEntry: (entry: unknown) => entry is T,
): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, T] => isEntry(pair[1])),
  )
}

export class BackupTooLargeError extends Error {
  constructor(public readonly count: number) {
    super(`Backup has ${count.toLocaleString()} entries — too large to import safely.`)
    this.name = 'BackupTooLargeError'
  }
}

// Optional text fields: absent or null means "not set"; any other non-string is corrupt.
function optionalString(value: unknown, field: string, itemName: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`bad ${field} on "${itemName}"`)
  return value
}

/**
 * Validates one expense from a backup file and returns a typed copy. Throws with a
 * user-readable reason on anything that would corrupt analytics or sync downstream.
 * Older backups without `createdAt` fall back to the expense date.
 */
export function parseBackupExpense(value: unknown): Expense {
  if (!isRecord(value)) throw new Error('malformed expense')
  const { id, itemName, amount, date, category } = value
  if (typeof id !== 'string' || !id) throw new Error('missing id')
  if (typeof itemName !== 'string') throw new Error('missing itemName')
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`bad amount on "${itemName}"`)
  }
  if (typeof date !== 'string' || !isValid(parseISO(date))) {
    throw new Error(`bad date on "${itemName}"`)
  }
  if (typeof category !== 'string') throw new Error('missing category')
  const createdAt = optionalString(value.createdAt, 'createdAt', itemName) ?? date
  const updatedAt = optionalString(value.updatedAt, 'updatedAt', itemName)
  const notes = optionalString(value.notes, 'notes', itemName)
  return {
    id,
    itemName,
    amount,
    category,
    date,
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(notes === undefined ? {} : { notes }),
  }
}

/**
 * Builds a BackupData from a parsed backup file. Every expense must be valid or the
 * whole import is rejected; the other collections keep only well-typed entries.
 */
export function parseBackup(raw: unknown): BackupData {
  if (!isRecord(raw)) throw new Error('not an object')
  const rawExpenses = raw.expenses
  if (!Array.isArray(rawExpenses)) throw new Error('missing expenses[]')
  if (rawExpenses.length > MAX_IMPORT_EXPENSES) throw new BackupTooLargeError(rawExpenses.length)
  return {
    expenses: rawExpenses.map((x: unknown) => parseBackupExpense(x)),
    categories: listOf(raw.categories, isString),
    categoryMappings: recordOf(raw.categoryMappings, isString),
    mappingUpdatedAt: recordOf(raw.mappingUpdatedAt, isString),
    budgets: recordOf(raw.budgets, isNumber),
    budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
    budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
    deletedIds: listOf(raw.deletedIds, isString),
    exportDate: typeof raw.exportDate === 'string' ? raw.exportDate : new Date().toISOString(),
    version: typeof raw.version === 'string' ? raw.version : '4.0',
  }
}
