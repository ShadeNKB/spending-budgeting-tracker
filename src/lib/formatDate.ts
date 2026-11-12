/**
 * The app's date formatter: date-fns `format` for the tokens the app uses, in English, without
 * its 19 KB of formatters and locale. Local time, as date-fns reads it. A token outside the table
 * throws, as an unknown letter does there, so a new pattern fails its first test instead of
 * printing its own letters. `formatDate.test.ts` holds it to date-fns, pattern by pattern.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number, length = 2): string => String(n).padStart(length, '0')

const TOKENS: Readonly<Record<string, (d: Date) => string>> = {
  // Year 0 and before count from 1 BC, as date-fns has them.
  yyyy: (d) => pad(d.getFullYear() > 0 ? d.getFullYear() : 1 - d.getFullYear(), 4),
  MMMM: (d) => MONTHS[d.getMonth()] ?? '',
  MMM: (d) => (MONTHS[d.getMonth()] ?? '').slice(0, 3),
  MM: (d) => pad(d.getMonth() + 1),
  dd: (d) => pad(d.getDate()),
  d: (d) => String(d.getDate()),
  EEEE: (d) => DAYS[d.getDay()] ?? '',
  EEE: (d) => (DAYS[d.getDay()] ?? '').slice(0, 3),
  HH: (d) => pad(d.getHours()),
  mm: (d) => pad(d.getMinutes()),
}

/** The patterns' tokens, for the test that walks them. */
export const DATE_TOKENS: readonly string[] = Object.keys(TOKENS)

export function formatDate(date: Date | number, pattern: string): string {
  const d = typeof date === 'number' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid time value')
  return pattern.replace(/([A-Za-z])\1*|'/g, (run) => {
    const token = Object.hasOwn(TOKENS, run) ? TOKENS[run] : undefined
    if (token === undefined) throw new RangeError(`Unsupported date pattern: ${run}`)
    return token(d)
  })
}
