import { describe, expect, it } from 'vitest'
import { RANGES, isRange, isValidYmd } from './ledgerParams'

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
