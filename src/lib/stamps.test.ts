import { describe, expect, it, vi } from 'vitest'
import { LEGACY_STAMP_ISO, STAMP_MAX, STAMP_MIN, nextStampIso, stampMs } from './stamps'

const T = Date.UTC(2026, 9, 19, 8, 0, 0)

describe('stampMs', () => {
  it('parses an ISO instant inside the window', () => {
    expect(stampMs('2026-10-19T08:00:00.000Z')).toBe(T)
  })

  it('orders anything outside [2000, 2100) as 0', () => {
    expect(stampMs('9999-12-31T00:00:00.000Z')).toBe(0)
    expect(stampMs('2100-01-01T00:00:00.000Z')).toBe(0)
    expect(stampMs('1999-12-31T23:59:59.999Z')).toBe(0)
    expect(stampMs(LEGACY_STAMP_ISO)).toBe(0)
  })

  it('accepts the window edges as specified', () => {
    expect(stampMs('2000-01-01T00:00:00.000Z')).toBe(STAMP_MIN)
    expect(stampMs('2099-12-31T23:59:59.999Z')).toBe(STAMP_MAX - 1)
  })

  it('returns 0 for unparseable or non-string values', () => {
    expect(stampMs('last tuesday')).toBe(0)
    expect(stampMs(undefined)).toBe(0)
    expect(stampMs(null)).toBe(0)
    expect(stampMs(T)).toBe(0)
    expect(stampMs({})).toBe(0)
  })

  // Measured with Playwright: Chromium and WebKit disagree on every one of these. A device that
  // orders a pair of copies differently from the other keeps its own and pushes forever.
  it('orders the texts the JS engines disagree on as 0 on every engine', () => {
    for (const text of [
      '2026-10-19t08:00:00z', // Chromium reads it, WebKit: NaN
      '2026-10-19T08:00:00.000z',
      '2026-11-31T08:00:00.000Z',
      '2026-02-30T08:00:00Z',
      'x 2026-10-19',
      '2026-10-19T08:00:60.000Z', // WebKit reads it, Chromium: NaN
      ' 2026-10-19T08:00:00.000Z',
    ]) {
      expect(stampMs(text), text).toBe(0)
    }
  })

  it('never asks the engine (Date.parse is implementation-defined)', () => {
    const parse = vi.spyOn(Date, 'parse').mockImplementation(() => {
      throw new Error('Date.parse called')
    })
    try {
      expect(stampMs('2026-10-19T08:00:00.000Z')).toBe(T)
      expect(stampMs('2026-10-19T16:00:00+08:00')).toBe(T)
      expect(stampMs('2026-10-19t08:00:00z')).toBe(0)
    } finally {
      parse.mockRestore()
    }
  })

  // The v5 engine's grammar (src/data/core/stamp.ts): both versions order every v4 stamp alike.
  it('reads ISO text the same in every time zone: no offset means UTC', () => {
    const noon = Date.UTC(2026, 9, 18, 12)
    expect(noon).toBe(1_792_324_800_000) // golden: the Singapore, Honolulu and Kiritimati runs agree
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
      expect(stampMs(text), text).toBe(noon)
    }
    expect(stampMs('2026-10-18')).toBe(Date.UTC(2026, 9, 18))
    expect(stampMs('2026-10-18T24:00:00Z')).toBe(Date.UTC(2026, 9, 19))
    expect(stampMs('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29))
    expect(stampMs('2026-10-18T12:00:00.5')).toBe(noon + 500)
    expect(stampMs('2026-10-18T12:00:00.123999999Z')).toBe(noon + 123)
  })

  it('reads every stamp this app writes (toISOString) exactly as the engines do', () => {
    for (let t = STAMP_MIN; t < STAMP_MAX; t += 7_777_777_777 + 777) {
      const text = new Date(t).toISOString()
      expect(stampMs(text)).toBe(t)
      expect(stampMs(text)).toBe(Date.parse(text))
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
      expect(stampMs(text), text).toBe(0)
    }
  })
})

describe('nextStampIso', () => {
  it('uses the wall clock when no base is newer', () => {
    expect(nextStampIso(T, T - 5000)).toBe('2026-10-19T08:00:00.000Z')
  })

  it('is strictly greater than every base', () => {
    expect(nextStampIso(T, T + 86_400_000)).toBe('2026-10-20T08:00:00.001Z')
    expect(nextStampIso(T, T, T + 10)).toBe('2026-10-19T08:00:00.011Z')
  })

  it('treats an unknown (0) base as older than now', () => {
    expect(nextStampIso(T, 0)).toBe('2026-10-19T08:00:00.000Z')
  })

  it('never leaves the window at the top', () => {
    expect(stampMs(nextStampIso(T, STAMP_MAX - 1))).toBe(STAMP_MAX - 1)
  })
})
