import { describe, expect, it } from 'vitest'
import {
  CURRENCIES,
  currencySymbol,
  formatInt,
  formatMoney,
  initialOf,
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
    // Decimals for a code the picker does not offer still come from Intl.
    expect(formatMoney(12.5, {}, 'KWD')).toBe('KWD\u00a012.500')
    expect(formatMoney(12.5, {}, 'KRW')).toBe('KRW\u00a013')
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

describe('initialOf', () => {
  it('upper-cases the first letter', () => {
    expect(initialOf('kopi o')).toBe('K')
    expect(initialOf('  grab')).toBe('G')
    expect(initialOf('')).toBe('')
  })

  it('keeps an emoji, a flag and an accented letter whole (charAt(0) split them)', () => {
    expect(initialOf('\u{1F35C} laksa')).toBe('\u{1F35C}')
    expect(initialOf('\u{1F1F8}\u{1F1EC} trip')).toBe('\u{1F1F8}\u{1F1EC}')
    expect(initialOf('éclair')).toBe('É')
  })
})

describe('fraction digits of the offered currencies', () => {
  it('match what Intl says for each currency the picker offers', () => {
    for (const c of CURRENCIES) {
      const intl = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: c.code,
      }).resolvedOptions().maximumFractionDigits
      expect({ code: c.code, digits: c.fractionDigits }).toEqual({ code: c.code, digits: intl })
    }
  })

  it('formats every offered currency exactly as the Intl-derived digits did', () => {
    const amounts = [0, 0.004, 1, 1.5, -42.005, 1234.567, 999_950, -0.4, NaN]
    const lines = CURRENCIES.flatMap((c) =>
      amounts.map(
        (n) =>
          `${c.code} ${String(n)}: ${formatMoney(n, {}, c.code)} | ${formatMoney(n, { sign: true }, c.code)} | ${formatMoney(n, { compact: true }, c.code)}`,
      ),
    )
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "USD 0: $0.00 | $0.00 | $0.00
      USD 0.004: $0.00 | $0.00 | $0.00
      USD 1: $1.00 | +$1.00 | $1.00
      USD 1.5: $1.50 | +$1.50 | $1.50
      USD -42.005: -$42.01 | -$42.01 | -$42.01
      USD 1234.567: $1,234.57 | +$1,234.57 | $1.2k
      USD 999950: $999,950.00 | +$999,950.00 | $1.0M
      USD -0.4: -$0.40 | -$0.40 | -$0.40
      USD NaN: $0.00 | $0.00 | $0.00
      SGD 0: S$0.00 | S$0.00 | S$0.00
      SGD 0.004: S$0.00 | S$0.00 | S$0.00
      SGD 1: S$1.00 | +S$1.00 | S$1.00
      SGD 1.5: S$1.50 | +S$1.50 | S$1.50
      SGD -42.005: -S$42.01 | -S$42.01 | -S$42.01
      SGD 1234.567: S$1,234.57 | +S$1,234.57 | S$1.2k
      SGD 999950: S$999,950.00 | +S$999,950.00 | S$1.0M
      SGD -0.4: -S$0.40 | -S$0.40 | -S$0.40
      SGD NaN: S$0.00 | S$0.00 | S$0.00
      EUR 0: €0.00 | €0.00 | €0.00
      EUR 0.004: €0.00 | €0.00 | €0.00
      EUR 1: €1.00 | +€1.00 | €1.00
      EUR 1.5: €1.50 | +€1.50 | €1.50
      EUR -42.005: -€42.01 | -€42.01 | -€42.01
      EUR 1234.567: €1,234.57 | +€1,234.57 | €1.2k
      EUR 999950: €999,950.00 | +€999,950.00 | €1.0M
      EUR -0.4: -€0.40 | -€0.40 | -€0.40
      EUR NaN: €0.00 | €0.00 | €0.00
      GBP 0: £0.00 | £0.00 | £0.00
      GBP 0.004: £0.00 | £0.00 | £0.00
      GBP 1: £1.00 | +£1.00 | £1.00
      GBP 1.5: £1.50 | +£1.50 | £1.50
      GBP -42.005: -£42.01 | -£42.01 | -£42.01
      GBP 1234.567: £1,234.57 | +£1,234.57 | £1.2k
      GBP 999950: £999,950.00 | +£999,950.00 | £1.0M
      GBP -0.4: -£0.40 | -£0.40 | -£0.40
      GBP NaN: £0.00 | £0.00 | £0.00
      JPY 0: ¥0 | ¥0 | ¥0
      JPY 0.004: ¥0 | ¥0 | ¥0
      JPY 1: ¥1 | +¥1 | ¥1
      JPY 1.5: ¥2 | +¥2 | ¥2
      JPY -42.005: -¥42 | -¥42 | -¥42
      JPY 1234.567: ¥1,235 | +¥1,235 | ¥1.2k
      JPY 999950: ¥999,950 | +¥999,950 | ¥1.0M
      JPY -0.4: ¥0 | ¥0 | ¥0
      JPY NaN: ¥0 | ¥0 | ¥0
      MYR 0: RM0.00 | RM0.00 | RM0.00
      MYR 0.004: RM0.00 | RM0.00 | RM0.00
      MYR 1: RM1.00 | +RM1.00 | RM1.00
      MYR 1.5: RM1.50 | +RM1.50 | RM1.50
      MYR -42.005: -RM42.01 | -RM42.01 | -RM42.01
      MYR 1234.567: RM1,234.57 | +RM1,234.57 | RM1.2k
      MYR 999950: RM999,950.00 | +RM999,950.00 | RM1.0M
      MYR -0.4: -RM0.40 | -RM0.40 | -RM0.40
      MYR NaN: RM0.00 | RM0.00 | RM0.00
      AUD 0: A$0.00 | A$0.00 | A$0.00
      AUD 0.004: A$0.00 | A$0.00 | A$0.00
      AUD 1: A$1.00 | +A$1.00 | A$1.00
      AUD 1.5: A$1.50 | +A$1.50 | A$1.50
      AUD -42.005: -A$42.01 | -A$42.01 | -A$42.01
      AUD 1234.567: A$1,234.57 | +A$1,234.57 | A$1.2k
      AUD 999950: A$999,950.00 | +A$999,950.00 | A$1.0M
      AUD -0.4: -A$0.40 | -A$0.40 | -A$0.40
      AUD NaN: A$0.00 | A$0.00 | A$0.00
      CAD 0: C$0.00 | C$0.00 | C$0.00
      CAD 0.004: C$0.00 | C$0.00 | C$0.00
      CAD 1: C$1.00 | +C$1.00 | C$1.00
      CAD 1.5: C$1.50 | +C$1.50 | C$1.50
      CAD -42.005: -C$42.01 | -C$42.01 | -C$42.01
      CAD 1234.567: C$1,234.57 | +C$1,234.57 | C$1.2k
      CAD 999950: C$999,950.00 | +C$999,950.00 | C$1.0M
      CAD -0.4: -C$0.40 | -C$0.40 | -C$0.40
      CAD NaN: C$0.00 | C$0.00 | C$0.00"
    `)
  })
})
