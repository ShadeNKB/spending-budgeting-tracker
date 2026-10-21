import type { Expense } from '../types'

// One CSV writer for every export. The text inside an expense can come from an
// imported backup or a synced device, so each cell is treated as untrusted:
// spreadsheets run any cell that looks like a formula when the file is opened.

/**
 * A cell that Excel, Sheets, Numbers or LibreOffice would read as a formula:
 * it starts with = + - @ (ASCII or full-width), tab or CR, also when the
 * operator sits behind leading whitespace that an importer may trim.
 */
const FORMULA_LEADER = /^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const HEADER = 'Date,Item,Category,Amount,Notes'

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

const pad = (n: number, width: number) => String(n).padStart(width, '0')

/**
 * The calendar day of a stored expense date, as `yyyy-MM-dd` in local time.
 * A date-only string is returned unchanged (parsing it would read it as UTC
 * midnight and shift it a day west of Greenwich). A noon-stored or legacy
 * timestamp gives its local day, matching what the Ledger shows. Anything that
 * does not parse is returned raw.
 */
export function csvDate(date: string): string {
  if (DATE_ONLY.test(date)) return date
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return date
  // Built by hand rather than with date-fns format(), which is about four
  // times slower and would dominate a 5,000-row export on a phone.
  return `${pad(parsed.getFullYear(), 4)}-${pad(parsed.getMonth() + 1, 2)}-${pad(parsed.getDate(), 2)}`
}

/** The CSV export of `expenses`: BOM, header, one row per expense, CRLF line endings. */
export function expensesToCsv(expenses: readonly Expense[]): string {
  const rows = expenses.map((e) =>
    [
      toCsvCell(csvDate(e.date)),
      toCsvCell(e.itemName),
      toCsvCell(e.category),
      toCsvCell(e.amount),
      toCsvCell(e.notes),
    ].join(','),
  )
  return BOM + [HEADER, ...rows].join(EOL) + EOL
}
