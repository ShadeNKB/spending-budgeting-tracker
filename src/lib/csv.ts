import type { Expense } from '../types'
import { KIND_KEY, categoryOf, kindOf } from './kind'
import { entryDay } from './ledgerIndex'

// One CSV writer for every export. The text inside an expense can come from an
// imported backup or a synced device, so each cell is treated as untrusted:
// spreadsheets run any cell that looks like a formula when the file is opened.

/**
 * A cell that Excel, Sheets, Numbers or LibreOffice would read as a formula:
 * it starts with = + - @ (ASCII or full-width), tab or CR, also when the
 * operator sits behind leading whitespace that an importer may trim.
 */
const FORMULA_LEADER = /^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/

// Type is the last column, added in 0.19.0: the five before it are where they always were.
const HEADER = 'Date,Item,Category,Amount,Notes,Type'

// Excel reads a file without a byte order mark as the local code page, so
// non-ASCII item names (鸡饭, café, emoji) would otherwise show as mojibake.
const BOM = '\uFEFF'

// RFC 4180 line ending; it also keeps line breaks inside quoted notes unambiguous.
const EOL = '\r\n'

const quote = (text: string) => `"${text.replace(/"/g, '""')}"`

/**
 * One quoted CSV cell. A finite number is written as is, so amounts (negative
 * ones too) stay numeric. Text that could run as a formula gets a leading
 * apostrophe so it opens as plain text. Missing values, NaN and Infinity give
 * an empty cell, and anything that is not text or a number (corrupt data) does
 * too, so an export never throws.
 */
export function toCsvCell(value: string | number | null | undefined): string {
  if (typeof value === 'string') return quote(FORMULA_LEADER.test(value) ? `'${value}` : value)
  if (typeof value === 'number' && Number.isFinite(value)) return quote(String(value))
  return '""'
}

/**
 * The Date cell of an expense: its day, `yyyy-MM-dd`, read exactly as the Ledger reads it
 * (`entryDay`), so an export can never put an entry on a different day than the screen does.
 * Anything the Ledger shows as "Unknown date" is exported raw.
 */
export function csvDay(expense: Expense): string {
  return entryDay(expense) ?? expense.date
}

/**
 * The Type cell: `expense`, `income`, `refund`, or the kind's own word when a newer SpendTrack wrote one
 * this version does not know (`other` when it is not text).
 */
function csvType(expense: Expense): string {
  const kind = kindOf(expense)
  if (kind !== 'unknown') return kind
  const raw = expense.ext?.[KIND_KEY]
  return typeof raw === 'string' && raw !== '' ? raw : 'other'
}

/**
 * The CSV export of `expenses`: BOM, header, one row per entry, CRLF line endings. Amounts are
 * positive for every type: the Type column says which way the money went. An expense or a refund
 * has a category.
 */
export function expensesToCsv(expenses: readonly Expense[]): string {
  const rows = expenses.map((e) =>
    [
      toCsvCell(csvDay(e)),
      toCsvCell(e.itemName),
      toCsvCell(categoryOf(e) ?? ''),
      toCsvCell(e.amount),
      toCsvCell(e.notes),
      toCsvCell(csvType(e)),
    ].join(','),
  )
  return BOM + [HEADER, ...rows].join(EOL) + EOL
}
