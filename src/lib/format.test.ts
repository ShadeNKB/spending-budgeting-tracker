import { describe, expect, it } from 'vitest'
import {
  CURRENCIES,
  currencySymbol,
  formatInt,
  formatMoney,
  isSupportedCurrency,
  resolveDefaultCurrency,
} from './format'

describe('formatMoney', () => {
  it('renders standard USD with two decimals', () => {
    expect(formatMoney(12.5)).toBe('$12.50')
    expect(formatMoney(0)).toBe('$0.00')
  })

  it('prefixes negatives with a minus sign', () => {
    expect(formatMoney(-4.2)).toBe('-$4.20')
  })

  it('returns $0.00 for non-finite input', () => {
    expect(formatMoney(NaN)).toBe('$0.00')
    expect(formatMoney(Infinity)).toBe('$0.00')
  })

  it('compacts thousands and millions when requested', () => {
    expect(formatMoney(1500, { compact: true })).toBe('$1.5k')
    expect(formatMoney(12_500, { compact: true })).toBe('$13k')
    expect(formatMoney(2_400_000, { compact: true })).toBe('$2.4M')
  })

  it('does not compact below the 1000 threshold', () => {
    expect(formatMoney(999, { compact: true })).toBe('$999.00')
  })

  it('adds a leading + when sign is requested for positives', () => {
    expect(formatMoney(10, { sign: true })).toBe('+$10.00')
    expect(formatMoney(0, { sign: true })).toBe('$0.00')
    expect(formatMoney(-10, { sign: true })).toBe('-$10.00')
  })
})

describe('formatInt', () => {
  it('formats with thousands separator and rounds', () => {
    expect(formatInt(1234)).toBe('1,234')
    expect(formatInt(1234.7)).toBe('1,235')
  })
})

describe('formatMoney — multi-currency', () => {
  it('uses the specified currency for formatting', () => {
    expect(formatMoney(12.5, {}, 'EUR')).toBe('€12.50')
    expect(formatMoney(12.5, {}, 'GBP')).toBe('£12.50')
  })

  it('uses currency symbol in compact formatting', () => {
    expect(formatMoney(1500, { compact: true }, 'EUR')).toBe('€1.5k')
  })

  it('returns zero value in the specified currency for non-finite input', () => {
    expect(formatMoney(NaN, {}, 'EUR')).toBe('€0.00')
  })
})

describe('formatMoney — symbols and fraction digits', () => {
  it('shows Singapore dollars as S$, never as a currency code', () => {
    expect(formatMoney(14.6, {}, 'SGD')).toBe('S$14.60')
    expect(formatMoney(1234.5, {}, 'SGD')).toBe('S$1,234.50')
    expect(formatMoney(-4.2, {}, 'SGD')).toBe('-S$4.20')
    expect(formatMoney(10, { sign: true }, 'SGD')).toBe('+S$10.00')
  })

  it('uses the currency’s own fraction digits (yen has none)', () => {
    expect(formatMoney(1500, {}, 'JPY')).toBe('¥1,500')
    expect(formatMoney(14.6, {}, 'JPY')).toBe('¥15')
    expect(formatMoney(-1500, {}, 'JPY')).toBe('-¥1,500')
  })

  it('keeps the k/M compact rule for every currency', () => {
    expect(formatMoney(1500, { compact: true }, 'SGD')).toBe('S$1.5k')
    expect(formatMoney(12_500, { compact: true }, 'SGD')).toBe('S$13k')
    expect(formatMoney(2_400_000, { compact: true }, 'SGD')).toBe('S$2.4M')
    expect(formatMoney(25_000_000, { compact: true }, 'SGD')).toBe('S$25M')
    expect(formatMoney(-1500, { compact: true }, 'SGD')).toBe('-S$1.5k')
    expect(formatMoney(12_500, { compact: true }, 'JPY')).toBe('¥13k')
    expect(formatMoney(999, { compact: true }, 'JPY')).toBe('¥999')
  })

  it('picks the compact unit after rounding, so a boundary never reads 1000k or 10.0k', () => {
    expect(formatMoney(9_960, { compact: true }, 'SGD')).toBe('S$10k')
    expect(formatMoney(999_499, { compact: true }, 'SGD')).toBe('S$999k')
    expect(formatMoney(999_950, { compact: true }, 'SGD')).toBe('S$1.0M')
    expect(formatMoney(9_960_000, { compact: true }, 'SGD')).toBe('S$10M')
    expect(formatMoney(-999_950, { compact: true })).toBe('-$1.0M')
  })

  it.each([
    ['USD', '$1,234.50'],
    ['SGD', 'S$1,234.50'],
    ['EUR', '€1,234.50'],
    ['GBP', '£1,234.50'],
    ['JPY', '¥1,235'],
    ['MYR', 'RM1,234.50'],
    ['AUD', 'A$1,234.50'],
    ['CAD', 'C$1,234.50'],
  ])('formats %s with its table symbol', (code, expected) => {
    expect(formatMoney(1234.5, {}, code)).toBe(expected)
  })

  it.each([
    ['SGD', 'S$0.00'],
    ['JPY', '¥0'],
    ['MYR', 'RM0.00'],
  ])('renders non-finite %s input as zero in that currency', (code, expected) => {
    expect(formatMoney(NaN, {}, code)).toBe(expected)
    expect(formatMoney(Infinity, {}, code)).toBe(expected)
    expect(formatMoney(-Infinity, { sign: true }, code)).toBe(expected)
    expect(formatMoney(NaN, { compact: true }, code)).toBe(expected)
  })

  it('never shows a sign on a value that rounds to zero', () => {
    expect(formatMoney(-0.001)).toBe('$0.00')
    expect(formatMoney(-0)).toBe('$0.00')
    expect(formatMoney(-0.004, { sign: true })).toBe('$0.00')
    expect(formatMoney(0.004, { sign: true })).toBe('$0.00')
    expect(formatMoney(-0.4, {}, 'JPY')).toBe('¥0')
    expect(formatMoney(0.4, { sign: true }, 'JPY')).toBe('¥0')
  })

  it('keeps a sign on the smallest value that does not round to zero', () => {
    expect(formatMoney(-0.01)).toBe('-$0.01')
    expect(formatMoney(0.01, { sign: true }, 'SGD')).toBe('+S$0.01')
  })

  it('formats codes outside the table without throwing', () => {
    expect(formatMoney(12.5, {}, 'CHF')).toBe('CHF\u00a012.50')
    expect(() => formatMoney(12.5, {}, 'not a code')).not.toThrow()
    expect(formatMoney(12.5, {}, 'not a code')).toContain('12.50')
  })
})

describe('currency table', () => {
  it('lists the supported currencies with the labels Settings shows', () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual([
      'USD',
      'SGD',
      'EUR',
      'GBP',
      'JPY',
      'MYR',
      'AUD',
      'CAD',
    ])
    for (const c of CURRENCIES) expect(c.label).toBe(`${c.code} — ${c.symbol}`)
  })

  it('returns the display symbol for a code', () => {
    expect(currencySymbol('SGD')).toBe('S$')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('MYR')).toBe('RM')
    expect(currencySymbol('JPY')).toBe('¥')
  })

  it('recognises only supported codes', () => {
    expect(isSupportedCurrency('SGD')).toBe(true)
    expect(isSupportedCurrency('usd')).toBe(false)
    expect(isSupportedCurrency('CHF')).toBe(false)
    expect(isSupportedCurrency(undefined)).toBe(false)
    expect(isSupportedCurrency(null)).toBe(false)
  })
})

describe('resolveDefaultCurrency', () => {
  it.each([
    ['Asia/Singapore', ['en-US'], 'SGD'],
    ['Singapore', [], 'SGD'],
    ['Asia/Kuala_Lumpur', ['en-US'], 'MYR'],
    ['Asia/Kuching', [], 'MYR'],
    ['Asia/Tokyo', ['en-US'], 'JPY'],
    ['Europe/London', ['en-US'], 'GBP'],
    ['Australia/Sydney', ['en-US'], 'AUD'],
    ['Australia/Perth', [], 'AUD'],
  ] as const)('maps the %s time zone first', (timeZone, languages, expected) => {
    expect(resolveDefaultCurrency({ timeZone, languages })).toBe(expected)
  })

  it.each([
    ['UTC', ['en-SG'], 'SGD'],
    ['America/New_York', ['en-US'], 'USD'],
    ['America/Toronto', ['en-CA'], 'CAD'],
    ['Europe/Berlin', ['de-DE'], 'EUR'],
    ['Europe/Sofia', ['bg-BG'], 'EUR'],
    ['Europe/Paris', ['fr', 'fr-FR'], 'EUR'],
    ['UTC', ['en', 'en-GB'], 'GBP'],
    ['Asia/Shanghai', ['zh-Hans-SG'], 'SGD'],
    ['UTC', ['en_MY'], 'MYR'],
    ['UTC', ['ja-JP'], 'JPY'],
    ['UTC', ['en-AU'], 'AUD'],
    ['UTC', ['en-US-u-ca-buddhist'], 'USD'],
    ['UTC', ['es-419', 'en-SG'], 'SGD'],
  ] as const)('falls back to the first mapped language region (%s, %j)', (tz, langs, expected) => {
    expect(resolveDefaultCurrency({ timeZone: tz, languages: langs })).toBe(expected)
  })

  it('defaults to USD when nothing maps or nothing is known', () => {
    expect(resolveDefaultCurrency({})).toBe('USD')
    expect(resolveDefaultCurrency({ timeZone: undefined, languages: undefined })).toBe('USD')
    expect(resolveDefaultCurrency({ timeZone: 'Asia/Shanghai', languages: ['zh-CN'] })).toBe('USD')
    expect(resolveDefaultCurrency({ timeZone: '', languages: ['', '*', 'en'] })).toBe('USD')
  })
})

describe('formatMoney performance', () => {
  // AC-16 reports 1,000 warm calls in < 3 ms (about 1 ms on a dev machine). A wall-clock bound
  // that tight fails on a loaded CI box, so the guard is relative and measured interleaved: the
  // cached formatter must stay at least 10x faster per call than building an Intl.NumberFormat
  // per call, which is what the old formatter did (about 50x slower). A formatter rebuilt per
  // call again makes the two equal and fails this.
  it('is at least 10x faster per call than a formatter built per call', () => {
    const codes = CURRENCIES.map((c) => c.code)
    const cached = () => {
      for (let i = 0; i < 1000; i++) {
        formatMoney(i * 1.37, { compact: i % 3 === 0, sign: i % 5 === 0 }, codes[i % codes.length])
      }
    }
    const perCall = () => {
      for (let i = 0; i < 200; i++) {
        new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(i * 1.37)
      }
    }
    cached()
    perCall()
    let bestCached = Infinity
    let bestPerCall = Infinity
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now()
      cached()
      bestCached = Math.min(bestCached, (performance.now() - t0) / 1000)
      const t1 = performance.now()
      perCall()
      bestPerCall = Math.min(bestPerCall, (performance.now() - t1) / 200)
    }
    expect(bestCached * 10).toBeLessThan(bestPerCall)
  })
})
