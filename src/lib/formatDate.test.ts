import { format } from 'date-fns'
import { describe, expect, it } from 'vitest'
import { DATE_TOKENS, formatDate } from './formatDate'

/**
 * The app's own formatter against date-fns `format`, which it replaced (T8a: 19 KB of formatters
 * and locale for ten tokens). date-fns stays in the project for `parseISO`, so it is here to
 * compare with. The source walk below finds every pattern the app passes, so a new pattern is
 * held to date-fns the day it is written.
 */
const SOURCES = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Quoted text made only of the tokens and the separators the app writes between them. */
const PATTERN = /'([yMdEHm]+(?:[ ,:\-/.]+[yMdEHm]+)*)'/g

/** Every pattern literal in a module that formats dates. */
function patternsInSource(): string[] {
  const found = new Set<string>()
  for (const [path, text] of Object.entries(SOURCES)) {
    if (path.endsWith('/lib/formatDate.ts')) continue
    if (!/\b(formatDate|formatKey)\(/.test(text)) continue
    for (const m of text.matchAll(PATTERN)) if (m[1] !== undefined) found.add(m[1])
  }
  return [...found].sort()
}

/** Each token alone, the app's patterns, and every pair of tokens side by side. */
const PATTERNS = [
  ...DATE_TOKENS,
  ...patternsInSource(),
  ...DATE_TOKENS.flatMap((a) => DATE_TOKENS.map((b) => `${a} ${b}`)),
]

/** Every day of a leap year and of a common year, at five times of day, and the edges of years. */
function sampleDates(): Date[] {
  const out: Date[] = []
  for (const year of [2024, 2026]) {
    for (let day = 0; day < 366; day++) {
      for (const [h, m] of [
        [0, 0],
        [0, 5],
        [9, 59],
        [12, 0],
        [23, 59],
      ] as const) {
        out.push(new Date(year, 0, 1 + day, h, m, 7))
      }
    }
  }
  for (const year of [1970, 1999, 2000, 2099, 2100, 9999, 987, 12]) {
    const d = new Date(2000, 0, 1, 12)
    d.setFullYear(year, 11, 31)
    out.push(d)
    const first = new Date(2000, 0, 1, 12)
    first.setFullYear(year, 0, 1)
    out.push(first)
  }
  return out
}

describe('formatDate', () => {
  it('finds the patterns the app uses', () => {
    const found = patternsInSource()
    // The walk is the guard: if it found nothing, it would hold nothing to date-fns.
    expect(found).toEqual(
      expect.arrayContaining([
        'yyyy-MM-dd',
        'yyyy-MM-dd-HHmm',
        'd MMM',
        'd MMM yyyy',
        'MMM d',
        'MMM d, yyyy',
        'HH:mm',
        'EEE, MMM d',
        'EEEE, MMMM d',
        'EEEE, MMMM d, yyyy',
      ]),
    )
  })

  it('gives exactly what date-fns gives, for every pattern on every sample date', () => {
    const dates = sampleDates()
    let checked = 0
    for (const pattern of PATTERNS) {
      for (const d of dates) {
        const ours = formatDate(d, pattern)
        if (ours !== format(d, pattern)) {
          // One readable failure instead of thousands.
          expect(`${pattern} @ ${d.toISOString()} → ${ours}`).toBe(
            `${pattern} @ ${d.toISOString()} → ${format(d, pattern)}`,
          )
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(400_000)
  })

  it('reads a timestamp as date-fns does', () => {
    const at = new Date(2026, 10, 12, 20, 15).getTime()
    expect(formatDate(at, 'd MMM yyyy, HH:mm')).toBe(format(at, 'd MMM yyyy, HH:mm'))
    expect(formatDate(at, 'd MMM yyyy, HH:mm')).toBe('12 Nov 2026, 20:15')
  })

  it('refuses an invalid date, as date-fns does', () => {
    expect(() => formatDate(new Date(Number.NaN), 'yyyy-MM-dd')).toThrow(RangeError)
    expect(() => format(new Date(Number.NaN), 'yyyy-MM-dd')).toThrow(RangeError)
  })

  it('refuses a token it does not know, instead of printing its letters', () => {
    for (const pattern of ['yy', 'M', 'MMMMM', 'EEEEE', 'h:mm a', 'do', 'ss', "d 'of' MMM"]) {
      expect(() => formatDate(new Date(2026, 0, 1), pattern), pattern).toThrow(RangeError)
    }
  })

  it('no module formats dates with date-fns any more', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, text]) => /import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*'date-fns'/.test(text))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
