import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storage } from '../../services/storage'
import {
  PREV_KEY,
  forgetPrevious,
  keepPrevious,
  maskCode,
  readPrevious,
  spokenEnd,
  timeAgo,
} from './previousCode'

const CODE = '11111111-2222-4333-8444-55555555a1b2'
const OTHER = '99999999-2222-4333-8444-55555555a1b2'
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60_000

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Reconnect slot (st5:synckey:prev)', () => {
  it('keeps a disconnected code for 30 days, then forgets it', () => {
    keepPrevious(CODE, NOW)
    expect(readPrevious(NOW)).toEqual({ code: CODE, until: NOW + 30 * DAY, established: false })
    expect(readPrevious(NOW + 30 * DAY - 1)?.code).toBe(CODE)
    expect(readPrevious(NOW + 30 * DAY)).toBeNull()
  })

  it('keeps whether this device was established on the code, from its saved setup (P3-5)', () => {
    storage.saveSyncId(CODE) // generated here, or found: it may create the relay copy
    keepPrevious(CODE, NOW)
    expect(readPrevious(NOW)?.established).toBe(true)
    storage.saveSyncId(CODE, false) // joined, and its copy not found yet: it never creates
    keepPrevious(CODE, NOW)
    expect(readPrevious(NOW)?.established).toBe(false)
    storage.saveSyncId(OTHER) // another code's setup says nothing about this one
    keepPrevious(CODE, NOW)
    expect(readPrevious(NOW)?.established).toBe(false)
  })

  it('never removes the slot when it reads it, even when it has expired or is unreadable', () => {
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    keepPrevious(CODE, NOW)
    expect(readPrevious(NOW + 31 * DAY)).toBeNull()
    localStorage.setItem(PREV_KEY, '{"code":')
    expect(readPrevious(NOW)).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', 'x'],
    ['a string', JSON.stringify(CODE)],
    ['null', 'null'],
    ['no code', JSON.stringify({ until: NOW + DAY })],
    ['a code that is not a UUID', JSON.stringify({ code: 'ST5-abc', until: NOW + DAY })],
    ['an upper-case code', JSON.stringify({ code: CODE.toUpperCase(), until: NOW + DAY })],
    ['no until', JSON.stringify({ code: CODE })],
    ['a string until', JSON.stringify({ code: CODE, until: String(NOW + DAY) })],
  ])('reads %s as no slot', (_what, raw) => {
    localStorage.setItem(PREV_KEY, raw)
    expect(readPrevious(NOW)).toBeNull()
  })

  it('writes through safeSet: a full storage keeps nothing and throws nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => {
      keepPrevious(CODE, NOW)
    }).not.toThrow()
    expect(readPrevious(NOW)).toBeNull()
  })

  it('reads nothing and throws nothing where storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(readPrevious(NOW)).toBeNull()
  })

  it('forgets the slot on request', () => {
    keepPrevious(CODE, NOW)
    forgetPrevious()
    expect(localStorage.getItem(PREV_KEY)).toBeNull()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => {
      forgetPrevious()
    }).not.toThrow()
  })

  it('lives under the st5: prefix, so Remove from this device wipes it', () => {
    expect(PREV_KEY).toBe('st5:synckey:prev')
  })

  // A rollback runs the raw export ("Download my data") of an older build: its secret-key
  // pattern must leave the remembered code out too. Both patterns as those releases shipped them.
  it.each([
    [
      '0.10.0',
      /^syncId$|^st5:sync$|^st5:q:syncId:|^st5:q:st5:sync:|secret|token|passphrase|synckey|cryptokey|encryptionkey/i,
    ],
    ['0.9.2', /^syncId$|secret|token|passphrase|synckey|cryptokey|encryptionkey/i],
  ])(
    'is a secret key to the raw export of %s too (a rollback never writes it out)',
    (_release, pattern) => {
      expect(pattern.test(PREV_KEY)).toBe(true)
    },
  )
})

describe('how a code is shown', () => {
  it('masks all but the last 4 characters (F-104)', () => {
    expect(maskCode(CODE)).toBe('••••-…-a1b2')
  })

  it('spells the last 4 characters for a screen reader', () => {
    expect(spokenEnd(CODE)).toBe('a 1 b 2')
  })
})

describe('timeAgo', () => {
  it.each([
    [0, 'just now'],
    [4_000, 'just now'],
    [30_000, '30s ago'],
    [2 * 60_000, '2m ago'],
    [3 * 60 * 60_000, '3h ago'],
    [DAY, '1 day ago'],
    [12 * DAY, '12 days ago'],
  ])('%i ms ago reads "%s"', (age, text) => {
    expect(timeAgo(NOW - age, NOW)).toBe(text)
  })

  it('says "just now" for a time in the future (a clock set back, a skewed peer)', () => {
    expect(timeAgo(NOW + 5 * 60_000, NOW)).toBe('just now')
  })
})
