import { describe, expect, it } from 'vitest'
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
