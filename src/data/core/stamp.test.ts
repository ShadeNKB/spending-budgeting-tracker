// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_AHEAD, MAX_T, MIN_T } from './constants'
import { iso, observe, ps, tick, vs } from './stamp'
import type { Hlc } from './types'

const T0 = Date.UTC(2026, 9, 19, 8)
const DAY = 86_400_000

describe('vs / ps / iso (§4.1)', () => {
  it('orders stamps outside [2000, 2100) as 0, independent of any clock', () => {
    expect(vs(MIN_T)).toBe(MIN_T)
    expect(vs(MIN_T - 1)).toBe(0)
    expect(vs(MAX_T - 1)).toBe(MAX_T - 1)
    expect(vs(MAX_T)).toBe(0)
    expect(vs(NaN)).toBe(0)
    expect(vs(Infinity)).toBe(0)
    expect(vs(-Infinity)).toBe(0)
    expect(vs(T0 + 0.9)).toBe(T0)
    expect(ps('9999-12-31T00:00:00.000Z')).toBe(0)
    expect(ps('2199-12-31T00:00:00.000Z')).toBe(0)
    expect(ps('1970-01-01T00:00:00.000Z')).toBe(0)
    expect(ps('1999-12-31T23:59:59.999Z')).toBe(0)
    expect(ps('garbage')).toBe(0)
    expect(ps('')).toBe(0)
    expect(ps(null)).toBe(0)
    expect(ps({ t: T0 })).toBe(0)
    expect(ps(T0)).toBe(T0)
    expect(ps('2026-10-19T08:00:00.000Z')).toBe(T0)
    expect(ps('2099-12-31T00:00:00.000Z')).toBe(Date.UTC(2099, 11, 31))
  })

  it('parses ISO text identically in every zone and engine: no offset means UTC (I4)', () => {
    // golden numbers: the Singapore, Honolulu and Kiritimati runs must all agree
    const noon = Date.UTC(2026, 9, 18, 12)
    expect(noon).toBe(1_792_324_800_000)
    for (const text of [
      '2026-10-18T12:00:00',
      '2026-10-18 12:00:00',
      '2026-10-18T12:00',
      '2026-10-18T12:00:00.000',
      '2026-10-18T12:00:00Z',
      '2026-10-18T20:00:00+08:00',
      '2026-10-18T20:00:00+0800',
      '2026-10-18T20:00+08',
      '2026-10-18T02:00:00-10:00',
      '2026-10-19T02:00:00+14:00',
    ]) {
      expect(ps(text), text).toBe(noon)
    }
    expect(ps('2026-10-18')).toBe(Date.UTC(2026, 9, 18))
    expect(ps('2026-10-18T24:00:00Z')).toBe(Date.UTC(2026, 9, 19))
    expect(ps('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29))
    // fractions truncate to whole ms, like the engines do
    expect(ps('2026-10-18T12:00:00.5')).toBe(noon + 500)
    expect(ps('2026-10-18T12:00:00.123999999Z')).toBe(noon + 123)
    // the canonical toISOString form agrees with Date.parse exactly
    for (let t = MIN_T; t < MAX_T; t += 7_777_777_777 + 777) {
      expect(ps(iso(t))).toBe(t)
      expect(ps(iso(t))).toBe(Date.parse(iso(t)))
    }
  })

  it('orders every other text as 0 instead of an engine-specific guess', () => {
    for (const text of [
      '2026-02-29T00:00:00Z',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-10-18T25:00:00Z',
      '2026-10-18T24:00:01Z',
      '2026-10-18T12:60:00Z',
      '2026-10-18T12:00:60Z',
      '2026-10-18T12:00:00+24:00',
      '2026-10-18T12:00:00+08:60',
      '2026-10-18T12',
      '2026-10-18T1200',
      '2026-10-18Z',
      '2026-10-18T12:00:00.Z',
      '+002026-10-18T00:00:00.000Z',
      '2026-W42-7',
      '2026/10/18',
      '18/10/2026',
      'Oct 18 2026',
      'Sun, 18 Oct 2026 12:00:00 GMT',
      ' 2026-10-18',
      '2026-10-18T12:00:00z',
    ]) {
      expect(ps(text), text).toBe(0)
    }
  })

  it('iso renders ms precision with Z', () => {
    expect(iso(T0)).toBe('2026-10-19T08:00:00.000Z')
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('tick / observe (§4.2)', () => {
  it('issues strictly increasing stamps on one clock', () => {
    const c: Hlc = { last: 0 }
    const a = tick(c, T0)
    const b = tick(c, T0)
    const d = tick(c, T0 - 5000)
    expect(a).toBe(T0)
    expect(b).toBe(T0 + 1)
    expect(d).toBe(T0 + 2)
  })

  it('is strictly above the superseded base (causal floor), even a day ahead', () => {
    const c: Hlc = { last: 0 }
    const base = T0 + DAY
    expect(tick(c, T0, base)).toBe(base + 1)
    // the clock follows the base only up to wall + MAX_AHEAD
    expect(c.last).toBe(Math.min(base + 1, T0 + MAX_AHEAD))
  })

  it('clamps to MAX_T - 1 and never follows more than 24 h ahead', () => {
    const c: Hlc = { last: 0 }
    expect(tick(c, T0, MAX_T + 5)).toBe(MAX_T - 1)
    expect(c.last).toBe(T0 + MAX_AHEAD)
    const c2: Hlc = { last: 0 }
    observe(c2, T0, MAX_T - 1)
    expect(c2.last).toBe(T0 + MAX_AHEAD)
    observe(c2, T0, T0 - 1)
    expect(c2.last).toBe(T0 + MAX_AHEAD)
    const c3: Hlc = { last: T0 }
    observe(c3, T0, T0 + 1000)
    expect(c3.last).toBe(T0 + 1000)
  })

  it('a wall clock before 2000 (a phone reset to 1970) still stamps inside the window, increasing', () => {
    for (const wall of [0, Date.UTC(1970, 0, 1, 0, 5), MIN_T - 3_600_000, MIN_T - 1]) {
      const c: Hlc = { last: 0 }
      const a = tick(c, wall)
      const b = tick(c, wall)
      const e = tick(c, wall, b)
      expect([a, b, e]).toEqual([MIN_T, MIN_T + 1, MIN_T + 2])
      for (const t of [a, b, e]) expect(vs(t)).toBe(t)
      expect(c.last).toBe(MIN_T + 2)
      // it still follows a peer's stamps only up to 24 h past the window start
      observe(c, wall, T0)
      expect(c.last).toBe(MIN_T + MAX_AHEAD)
    }
    // inside the window nothing changes
    const c: Hlc = { last: 0 }
    expect(tick(c, MIN_T + 5)).toBe(MIN_T + 5)
  })

  it('a slow device (-1 day) that observed a fast stamp still issues later stamps', () => {
    const fast: Hlc = { last: 0 }
    const slow: Hlc = { last: 0 }
    const f = tick(fast, T0)
    observe(slow, T0 - DAY, f)
    expect(tick(slow, T0 - DAY + 1000)).toBeGreaterThan(f)
  })
})
