import { describe, expect, it } from 'vitest'
import { format, parseISO } from 'date-fns'
import {
  addDays,
  addMonths,
  dayKeyOfStored,
  dayOfWeek,
  daysInMonth,
  diffDays,
  enumerateDays,
  formatKey,
  formatRangeLabel,
  keyToLocalNoon,
  lastNDays,
  ledgerRange,
  ledgerRangeLabel,
  longDate,
  monthKeyOf,
  monthLabel,
  monthName,
  monthRange,
  prevMonthLikeForLike,
  prevYearLikeForLike,
  readStored,
  shortDate,
  sundayOnOrBefore,
  todayKey,
  toDayKey,
  weekdayShort,
  yearRange,
} from './dates'

/** Deterministic PRNG so the property tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The reference the fast path must agree with: date-fns parse + format, `null` when invalid. */
function referenceKey(s: string): string | null {
  try {
    return format(parseISO(s), 'yyyy-MM-dd')
  } catch {
    return null
  }
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

describe('calendar arithmetic', () => {
  it('knows month lengths, leap years included', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-10-18', -6)).toBe('2026-10-12')
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01')
    expect(addDays('2026-10-18', 0)).toBe('2026-10-18')
  })

  it('counts whole calendar days, never 24 h periods', () => {
    expect(diffDays('2026-10-11', '2026-10-18')).toBe(7)
    expect(diffDays('2026-10-18', '2026-10-11')).toBe(-7)
    // US / EU DST weekends: still exactly two days.
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2)
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2)
    expect(diffDays('2027-12-31', '2028-12-31')).toBe(366)
  })

  it('reads the weekday from the key (Sunday = 0)', () => {
    expect(dayOfWeek('2026-10-18')).toBe(0)
    expect(dayOfWeek('2026-10-17')).toBe(6)
    expect(dayOfWeek('2028-02-29')).toBe(2)
    expect(sundayOnOrBefore('2026-10-18')).toBe('2026-10-18')
    expect(sundayOnOrBefore('2026-10-17')).toBe('2026-10-11')
    expect(sundayOnOrBefore('2027-01-02')).toBe('2026-12-27')
  })

  it('steps months and builds month / year ranges', () => {
    expect(monthKeyOf('2026-10-18')).toBe('2026-10')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-10', -13)).toBe('2025-09')
    expect(addMonths('2026-10', 0)).toBe('2026-10')
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(yearRange(2026)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('enumerates inclusive day lists', () => {
    expect(enumerateDays({ start: '2026-02-27', end: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
    expect(enumerateDays({ start: '2026-10-18', end: '2026-10-18' })).toEqual(['2026-10-18'])
    expect(enumerateDays({ start: '2026-10-19', end: '2026-10-18' })).toEqual([])
  })
})

describe('period table', () => {
  it('last 7 days is today and the six days before it', () => {
    expect(lastNDays('2026-10-18', 7)).toEqual({ start: '2026-10-12', end: '2026-10-18' })
    expect(lastNDays('2026-01-03', 7)).toEqual({ start: '2025-12-28', end: '2026-01-03' })
    expect(lastNDays('2026-10-18', 30)).toEqual({ start: '2026-09-19', end: '2026-10-18' })
  })

  it.each([
    ['2026-10-18', '2026-09-01', '2026-09-18', 'vs Sep 1–18'],
    ['2026-03-30', '2026-02-01', '2026-02-28', 'vs February'],
    ['2026-10-01', '2026-09-01', '2026-09-01', 'vs Sep 1'],
    ['2026-10-31', '2026-09-01', '2026-09-30', 'vs September'],
    ['2026-09-30', '2026-08-01', '2026-08-30', 'vs Aug 1–30'],
    ['2026-01-15', '2025-12-01', '2025-12-15', 'vs Dec 1–15'],
    ['2028-03-29', '2028-02-01', '2028-02-29', 'vs February'],
    ['2028-03-28', '2028-02-01', '2028-02-28', 'vs Feb 1–28'],
  ])('previous month like for like on %s', (today, start, end, label) => {
    expect(prevMonthLikeForLike(today)).toEqual({
      range: { start, end },
      against: label.slice(3),
      label,
    })
  })

  it.each([
    ['2026-10-18', '2025-01-01', '2025-10-18', 'vs 2025 to Oct 18'],
    ['2028-02-29', '2027-01-01', '2027-02-28', 'vs 2027 to Feb 28'],
    ['2027-01-01', '2026-01-01', '2026-01-01', 'vs 2026 to Jan 1'],
    ['2026-12-31', '2025-01-01', '2025-12-31', 'vs 2025'],
  ])('previous year like for like on %s', (today, start, end, label) => {
    expect(prevYearLikeForLike(today)).toEqual({
      range: { start, end },
      against: label.slice(3),
      label,
    })
  })

  it('maps every ledger range onto whole local days', () => {
    const today = '2026-10-18'
    expect(ledgerRange('today', today)).toEqual({ start: today, end: today })
    expect(ledgerRange('week', today)).toEqual({ start: '2026-10-12', end: today })
    expect(ledgerRange('month', today)).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(ledgerRange('year', today)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(ledgerRange('all', today)).toBeNull()
    // A specific day always wins over the range.
    expect(ledgerRange('year', today, { date: '2026-05-02' })).toEqual({
      start: '2026-05-02',
      end: '2026-05-02',
    })
  })

  it('normalises custom ranges: swapped ends, open start = all time, open end = today', () => {
    const today = '2026-10-18'
    expect(
      ledgerRange('custom', today, { customStart: '2026-10-10', customEnd: '2026-10-01' }),
    ).toEqual({ start: '2026-10-01', end: '2026-10-10' })
    expect(ledgerRange('custom', today, { customStart: '2026-10-10' })).toEqual({
      start: '2026-10-10',
      end: today,
    })
    const open = ledgerRange('custom', today, { customEnd: '2026-02-01' })
    expect(open?.end).toBe('2026-02-01')
    expect((open?.start ?? '') < '1000-01-01').toBe(true)
  })

  it('labels each range from the same definition', () => {
    const today = '2026-10-18'
    expect(ledgerRangeLabel('today', today)).toBe('Today · Sun, Oct 18')
    expect(ledgerRangeLabel('week', today)).toBe('Last 7 days · Oct 12 – Oct 18')
    expect(ledgerRangeLabel('week', '2026-01-03')).toBe('Last 7 days · Dec 28, 2025 – Jan 3')
    expect(ledgerRangeLabel('month', today)).toBe('October 2026')
    expect(ledgerRangeLabel('year', today)).toBe('2026')
    expect(ledgerRangeLabel('all', today)).toBe('All time')
    expect(ledgerRangeLabel('month', today, { date: '2025-05-02' })).toBe('May 2, 2025')
    expect(
      ledgerRangeLabel('custom', today, { customStart: '2026-10-01', customEnd: '2026-10-10' }),
    ).toBe('Oct 1, 2026 – Oct 10, 2026')
    expect(ledgerRangeLabel('custom', today, { customStart: '2026-10-01' })).toBe(
      'From Oct 1, 2026',
    )
    expect(ledgerRangeLabel('custom', today, { customEnd: '2026-10-10' })).toBe(
      'Until Oct 10, 2026',
    )
    expect(ledgerRangeLabel('custom', today)).toBe('Custom range')
  })

  it('formats ranges with the year only when it differs from today', () => {
    const today = '2026-10-18'
    expect(formatRangeLabel({ start: '2026-10-12', end: '2026-10-18' }, today)).toBe(
      'Oct 12 – Oct 18',
    )
    expect(formatRangeLabel({ start: '2025-10-12', end: '2025-10-18' }, today)).toBe(
      'Oct 12 – Oct 18, 2025',
    )
    expect(formatRangeLabel({ start: '2025-12-28', end: '2026-01-03' }, today)).toBe(
      'Dec 28, 2025 – Jan 3',
    )
    expect(formatRangeLabel({ start: '2024-12-28', end: '2025-01-03' }, today)).toBe(
      'Dec 28, 2024 – Jan 3, 2025',
    )
    expect(formatRangeLabel({ start: '2026-10-18', end: '2026-10-18' }, today)).toBe('Oct 18')
  })
})

describe('display helpers', () => {
  it('formats keys the way date-fns does at local noon', () => {
    for (const key of ['2026-10-18', '2028-02-29', '2027-01-01', '2026-05-02']) {
      const noon = keyToLocalNoon(key)
      expect(noon.getHours()).toBe(12)
      expect(toDayKey(noon)).toBe(key)
      expect(shortDate(key)).toBe(format(noon, 'MMM d'))
      expect(longDate(key)).toBe(format(noon, 'MMMM d'))
      expect(weekdayShort(key)).toBe(format(noon, 'EEE'))
      expect(formatKey(key, 'EEE, MMM d')).toBe(format(noon, 'EEE, MMM d'))
    }
    expect(monthName('2026-10')).toBe('October')
    expect(monthLabel('2026-10')).toBe('October 2026')
  })

  it('derives today from the local clock', () => {
    expect(todayKey(new Date(2026, 9, 18, 0, 5))).toBe('2026-10-18')
    expect(todayKey(new Date(2026, 9, 18, 23, 59, 59))).toBe('2026-10-18')
    expect(toDayKey(new Date(2028, 1, 29, 12))).toBe('2028-02-29')
  })
})

describe('dayKeyOfStored / readStored time', () => {
  const edges = [
    '2026-02-30',
    '2026-02-29',
    '2028-02-29',
    '2026-02-30T12:00:00',
    '2026-02-30T12:00:00Z',
    '2026-04-31T12:00:00+08:00',
    '2026-13-01',
    '2026-00-10',
    '',
    'garbage',
    '2026-10-18T24:00:00',
    '2026-10-18T23:59:59.999+14:00',
    '2026-10-18T00:00:00-12:00',
    '2026-10-18T00:00:00+14:00',
    '2026-10-18T12:00:00+25:00',
    '2026-10-18T12:00:00.1234',
    '2026-10-18 12:00',
    '2026-10-18t12:00',
    '2026-10-18T12',
    '20261018',
    '+002026-10-18',
    '0999-01-01',
    '0050-06-01',
    '2026-10-18T12:00:00Z',
    '2026-10-18T12:00:00.000Z',
    '2026-10-18T12:00',
    '2026-10-18T16:00:00.000Z',
    '2026-10-17T16:00:00.000Z',
    '1999-12-31T23:59:59.999',
  ]

  it.each(edges)('agrees with date-fns on %j', (s) => {
    const expected = referenceKey(s)
    expect(dayKeyOfStored(s)).toBe(expected?.length === 10 ? expected : null)
    const t = readStored(s).time
    if (expected === null) expect(t).toBeNaN()
    else expect(Math.abs(t - parseISO(s).getTime())).toBeLessThanOrEqual(1)
  })

  it('returns null / NaN for values that are not strings at runtime (corrupt storage)', () => {
    const notStrings: unknown[] = [undefined, null, 42, {}, [], new Date(2026, 9, 18)]
    for (const v of notStrings) {
      expect(dayKeyOfStored(v)).toBeNull()
      expect(readStored(v).time).toBeNaN()
    }
  })

  it('agrees with format(parseISO(s)) for 10,000 random instants in every stored form', () => {
    const rand = mulberry32(20261018)
    const lo = Date.UTC(1999, 0, 1)
    const hi = Date.UTC(2031, 0, 1)
    let checked = 0
    for (let i = 0; i < 10_000; i++) {
      const d = new Date(lo + Math.floor(rand() * (hi - lo)))
      const offMin = Math.round(rand() * 26 - 12) * 60 + (rand() < 0.2 ? 30 : 0)
      const shifted = new Date(d.getTime() + offMin * 60_000)
      const sign = offMin < 0 ? '-' : '+'
      const forms = [
        d.toISOString(),
        format(d, "yyyy-MM-dd'T'12:00:00"),
        format(d, "yyyy-MM-dd'T'HH:mm:ss"),
        format(d, "yyyy-MM-dd'T'HH:mm:ss.SSS"),
        format(d, "yyyy-MM-dd'T'HH:mm"),
        format(d, 'yyyy-MM-dd'),
        `${shifted.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`,
      ]
      for (const s of forms) {
        const expected = referenceKey(s)
        expect(dayKeyOfStored(s), s).toBe(expected)
        expect(Math.abs(readStored(s).time - parseISO(s).getTime()), s).toBeLessThanOrEqual(1)
        checked++
      }
    }
    expect(checked).toBe(70_000)
  }, 60_000)
})
