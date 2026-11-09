import { describe, expect, it } from 'vitest'
import { RANGES, isRange, isValidYmd, ledgerCategoryHref, ledgerEntryHref } from './ledgerParams'

describe('isRange', () => {
  it('accepts every known range', () => {
    for (const r of RANGES) expect(isRange(r)).toBe(true)
  })

  it.each([null, '', 'MONTH', 'decade', 'month ', '__proto__'])('rejects %j', (v) => {
    expect(isRange(v)).toBe(false)
  })
})

describe('isValidYmd', () => {
  it('accepts a real yyyy-MM-dd date', () => {
    expect(isValidYmd('2026-05-02')).toBe(true)
  })

  it.each([null, '', '2026-5-2', '2026-02-30', '2026-13-01', '02-05-2026', '2026-05-02T12:00'])(
    'rejects %j',
    (v) => {
      expect(isValidYmd(v)).toBe(false)
    },
  )
})

describe('ledgerCategoryHref', () => {
  it('opens this month by default, this year, or a past period as its days', () => {
    expect(ledgerCategoryHref('Food & Dining', null)).toBe('/ledger?category=Food%20%26%20Dining')
    expect(ledgerCategoryHref('Transport', 'year')).toBe('/ledger?category=Transport&range=year')
    expect(ledgerCategoryHref('Transport', { start: '2025-01-01', end: '2025-12-31' })).toBe(
      '/ledger?category=Transport&range=custom&customStart=2025-01-01&customEnd=2025-12-31',
    )
  })
})

describe('ledgerEntryHref', () => {
  it('opens the day of the entry, searched for its name, with its Edit sheet asked for', () => {
    expect(ledgerEntryHref({ id: 'e1', day: '2026-10-18', itemName: 'kopi' })).toBe(
      '/ledger?date=2026-10-18&q=kopi&edit=e1',
    )
    expect(ledgerEntryHref({ id: 'a&b=c', day: '2026-10-18', itemName: 'Tea & #2' })).toBe(
      '/ledger?date=2026-10-18&q=Tea%20%26%20%232&edit=a%26b%3Dc',
    )
  })
})
