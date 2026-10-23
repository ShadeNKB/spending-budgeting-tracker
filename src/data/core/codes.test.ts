// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { encodeSt5, maskCode, normalizeUuid, parseSt5, parseSyncCode } from './codes'

/** CPU- and WebCrypto-heavy suites: generous so a fully loaded parallel run (all time zones, simulations) cannot flake. */
const HEAVY = { timeout: 60_000 }

// ---------------------------------------------------------------------------------------------
// Helpers (local on purpose: U2 imports nothing from the rest of the data layer)
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('must: missing value')
  return value
}

/** Seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (r: () => number, n: number): number => Math.floor(r() * n)

function bytes(r: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = int(r, 256)
  return out
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const KAT_SECRET = Uint8Array.from({ length: 16 }, (_, i) => i)
const KAT_CODE = 'ST5-0004106-1050R3G-G28A1C6-0T3GFS3'
const CODE_RE = /^ST5-[0-7][0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{7}){3}$/

/** Independent oracle: BigInt base-32 digits plus the FNV-1a-32 check symbols of section 13.3. */
function referenceSymbols(secret: Uint8Array): string {
  let v = 0n
  for (const b of secret) v = (v << 8n) | BigInt(b)
  let s = ''
  for (let i = 0; i < 26; i++) {
    s = ALPHABET.charAt(Number(v & 31n)) + s
    v >>= 5n
  }
  let h = 0x811c9dc5
  for (const b of secret) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return s + ALPHABET.charAt((h >>> 27) & 31) + ALPHABET.charAt((h >>> 22) & 31)
}

const symbolsOf = (code: string): string => code.replace(/^ST5/, '').replace(/-/g, '')

function secretOf(input: string): Uint8Array {
  const res = parseSt5(input)
  if (!res.ok) throw new Error('expected a valid code, got ' + res.reason)
  return res.secret
}

// ---------------------------------------------------------------------------------------------

describe('ST5 codes (section 13.3)', HEAVY, () => {
  it('matches the frozen known-answer vector of section 13.7', () => {
    expect(encodeSt5(KAT_SECRET)).toBe(KAT_CODE)
    expect(Array.from(secretOf(KAT_CODE))).toEqual(Array.from(KAT_SECRET))
  })

  it('round-trips 10,000 random secrets and agrees with the BigInt reference', () => {
    const r = rng(11)
    for (let i = 0; i < 10_000; i++) {
      const secret = bytes(r, 16)
      const code = encodeSt5(secret)
      expect(code).toMatch(CODE_RE)
      expect(symbolsOf(code)).toBe(referenceSymbols(secret))
      expect(Array.from(secretOf(code))).toEqual(Array.from(secret))
    }
  })

  it('round-trips the edges: zero, all ones, and every single bit', () => {
    const edges = [new Uint8Array(16), new Uint8Array(16).fill(255)]
    for (let bit = 0; bit < 128; bit++) {
      const one = new Uint8Array(16)
      one[bit >> 3] = 0x80 >> (bit & 7)
      edges.push(one)
    }
    for (const secret of edges) {
      const code = encodeSt5(secret)
      expect(code).toMatch(CODE_RE)
      expect(symbolsOf(code)).toBe(referenceSymbols(secret))
      expect(Array.from(secretOf(code))).toEqual(Array.from(secret))
    }
    expect(encodeSt5(new Uint8Array(16).fill(255)).charAt(4)).toBe('7')
  })

  it('refuses to encode a secret that is not exactly 16 bytes', () => {
    expect(() => encodeSt5(new Uint8Array(15))).toThrow(RangeError)
    expect(() => encodeSt5(new Uint8Array(17))).toThrow(RangeError)
  })

  it('returns a fresh secret the caller may keep or wipe', () => {
    const a = secretOf(KAT_CODE)
    a.fill(0)
    expect(Array.from(secretOf(KAT_CODE))).toEqual(Array.from(KAT_SECRET))
  })
})

describe('ST5 input normalisation', HEAVY, () => {
  const expected = Array.from(KAT_SECRET)

  it('accepts lower case, spaces, hyphens anywhere, and the prefix or none', () => {
    const symbols = symbolsOf(KAT_CODE)
    const inputs = [
      KAT_CODE.toLowerCase(),
      symbols,
      symbols.toLowerCase(),
      '  ' + KAT_CODE + '  ',
      'st5 ' + symbols.replace(/(.{4})/g, '$1 '),
      'ST5' + symbols,
      symbols.split('').join('-'),
      'ST5\u00a0' + symbols.slice(0, 14) + '\t' + symbols.slice(14) + '\n',
      'ST5\u2013' +
        symbols.slice(0, 7) +
        '\u2010' +
        symbols.slice(7, 14) +
        '\u2212' +
        symbols.slice(14),
    ]
    for (const input of inputs) {
      expect(Array.from(secretOf(input))).toEqual(expected)
    }
  })

  it('reads I and L as 1 and O as 0, in either case', () => {
    const variants = [
      KAT_CODE.replace(/1/g, 'I'),
      KAT_CODE.replace(/1/g, 'l'),
      KAT_CODE.replace(/1/g, 'L'),
      KAT_CODE.replace(/0/g, 'O'),
      KAT_CODE.replace(/0/g, 'o'),
      KAT_CODE.replace(/0/g, 'O').replace(/1/g, 'i'),
    ]
    for (const input of variants) {
      expect(input).not.toBe(KAT_CODE)
      expect(Array.from(secretOf(input))).toEqual(expected)
    }
  })

  it('rejects the wrong length', () => {
    const symbols = symbolsOf(KAT_CODE)
    for (const input of [
      '',
      '   ',
      'ST5',
      'ST5-',
      symbols.slice(1),
      symbols + '0',
      'ST5ST5' + symbols,
    ]) {
      expect(parseSt5(input)).toEqual({ ok: false, reason: 'length' })
    }
  })

  it('rejects symbols outside the alphabet (U, punctuation, letters with accents)', () => {
    const symbols = symbolsOf(KAT_CODE)
    for (const bad of ['U', 'u', '*', '.', 'É', '_', '+']) {
      const input = bad + symbols.slice(1)
      expect(parseSt5(input)).toEqual({ ok: false, reason: 'symbol' })
    }
  })

  it('rejects values of 2^128 and above (first symbol 8 to Z)', () => {
    const rest = symbolsOf(KAT_CODE).slice(1)
    for (const first of ALPHABET.slice(8)) {
      expect(parseSt5(first + rest)).toEqual({ ok: false, reason: 'range' })
    }
  })

  it('catches every typo in a check symbol', () => {
    const r = rng(12)
    for (let i = 0; i < 300; i++) {
      const symbols = symbolsOf(encodeSt5(bytes(r, 16)))
      for (const pos of [26, 27]) {
        for (const sym of ALPHABET) {
          if (sym === symbols.charAt(pos)) continue
          const typo = symbols.slice(0, pos) + sym + symbols.slice(pos + 1)
          expect(parseSt5(typo)).toEqual({ ok: false, reason: 'checksum' })
        }
      }
    }
  })

  it('lets a single-symbol typo in the secret through at about 2 in 1,024 (the frozen check)', () => {
    // Every position, every other symbol, for 120 seeded secrets (93,840 typos). An ideal 10-bit
    // check would pass 1 in 1,024; FNV-1a-32 has no final mixing, so typos in the 24th symbol
    // (the second-to-last byte) pass at about 26 in 1,024 and lift the average to 2.1 in 1,024
    // (1.17 M typos measured). The check is frozen by the section 13.7 vector, so this pins what
    // it really does; the bounds are about 4 standard deviations wide.
    const r = rng(13)
    let trials = 0
    let passed = 0
    const passedAt = new Array<number>(26).fill(0)
    for (let n = 0; n < 120; n++) {
      const secret = symbolsOf(encodeSt5(bytes(r, 16)))
      for (let pos = 0; pos < 26; pos++) {
        for (const sym of ALPHABET) {
          if (sym === secret.charAt(pos)) continue
          const res = parseSt5(secret.slice(0, pos) + sym + secret.slice(pos + 1))
          if (pos === 0 && ALPHABET.indexOf(sym) > 7) {
            expect(res).toEqual({ ok: false, reason: 'range' })
            continue
          }
          trials++
          if (res.ok) {
            passed++
            passedAt[pos] = (passedAt[pos] ?? 0) + 1
          } else {
            expect(res.reason).toBe('checksum')
          }
        }
      }
    }
    expect(trials).toBe(93_840)
    expect(passed / trials).toBeGreaterThan(1.5 / 1024)
    expect(passed / trials).toBeLessThan(2.7 / 1024)
    // A typo in the last symbol only touches the final byte, which the multiply always carries
    // into the check bits: never missed.
    expect(passedAt[25]).toBe(0)
  })
})

describe('normalizeUuid (identical to the v0.8 connect check)', HEAVY, () => {
  const v08 = (input: string): string | null => {
    const trimmed = input.trim().toLowerCase()
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)
      ? trimmed
      : null
  }

  it('trims, lower-cases and accepts any 8-4-4-4-12 hex code', () => {
    expect(normalizeUuid('  3F0B4B0E-6C35-4A6C-9B1E-0D1C2E3F4A5B\n')).toBe(
      '3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b',
    )
    expect(normalizeUuid('00000000-0000-4000-8000-000000000000')).toBe(
      '00000000-0000-4000-8000-000000000000',
    )
  })

  it('rejects near misses', () => {
    for (const bad of [
      '',
      '3f0b4b0e6c354a6c9b1e0d1c2e3f4a5b',
      '{3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b}',
      'urn:uuid:3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b',
      '3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5g',
      '3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5',
      '3f0b4b0e-6c35-4a6c-9b1e 0d1c2e3f4a5b',
      KAT_CODE,
    ]) {
      expect(normalizeUuid(bad)).toBeNull()
    }
  })

  it('agrees with the shipped v0.8 logic on random near-UUID strings', () => {
    const r = rng(14)
    const chars = '0123456789abcdefABCDEFg- \t'
    const base = '3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b'
    for (let i = 0; i < 5000; i++) {
      let s = i % 2 === 0 ? base : ''
      for (let m = int(r, 4); m >= 0; m--) {
        const pos = int(r, s.length + 1)
        const c = chars.charAt(int(r, chars.length))
        s =
          int(r, 2) === 0
            ? s.slice(0, pos) + c + s.slice(pos + 1)
            : s.slice(0, pos) + c + s.slice(pos)
      }
      expect(normalizeUuid(s)).toBe(v08(s))
    }
  })
})

describe('parseSyncCode', HEAVY, () => {
  it('reads a UUID as a plaintext code', () => {
    expect(parseSyncCode(' 3F0B4B0E-6C35-4A6C-9B1E-0D1C2E3F4A5B ')).toEqual({
      kind: 'plain',
      code: '3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b',
    })
  })

  it('reads an ST5 code as a private code, returning the canonical display form', () => {
    const res = parseSyncCode('st5 ' + symbolsOf(KAT_CODE).toLowerCase().replace(/0/g, 'o'))
    expect(res.kind).toBe('e2e')
    if (res.kind !== 'e2e') return
    expect(res.code).toBe(KAT_CODE)
    expect(Array.from(res.secret)).toEqual(Array.from(KAT_SECRET))
  })

  it('reports why anything else is invalid, before any network call could happen', () => {
    expect(parseSyncCode('')).toEqual({ kind: 'invalid', reason: 'length' })
    expect(parseSyncCode('3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5')).toEqual({
      kind: 'invalid',
      reason: 'length',
    })
    expect(parseSyncCode(KAT_CODE.slice(0, -1) + '4')).toEqual({
      kind: 'invalid',
      reason: 'checksum',
    })
    expect(parseSyncCode('ST5-U004106-1050R3G-G28A1C6-0T3GFS3')).toEqual({
      kind: 'invalid',
      reason: 'symbol',
    })
  })

  it('never reads a UUID as ST5 or an ST5 code as a UUID', () => {
    const r = rng(15)
    for (let i = 0; i < 500; i++) {
      const code = encodeSt5(bytes(r, 16))
      expect(normalizeUuid(code)).toBeNull()
      const hex = Array.from(bytes(r, 16), (b) => b.toString(16).padStart(2, '0')).join('')
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      expect(parseSt5(uuid).ok).toBe(false)
      expect(parseSyncCode(uuid)).toEqual({ kind: 'plain', code: uuid })
    }
  })
})

describe('maskCode (F-104: masked by default)', HEAVY, () => {
  const MASK = '••••-…-'

  it('shows only the last 4 characters of a UUID or an ST5 code', () => {
    expect(maskCode('3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b')).toBe(MASK + '4a5b')
    expect(maskCode(KAT_CODE)).toBe(MASK + 'GFS3')
  })

  it('reveals nothing of a code too short to keep 4 characters back', () => {
    for (const short of ['', 'a', 'ab-c', '1234', ' 12-34 ']) {
      expect(maskCode(short)).toBe('••••')
    }
    expect(maskCode('12345')).toBe(MASK + '2345')
  })

  it('never leaks any other character of a random code', () => {
    const r = rng(16)
    for (let i = 0; i < 2000; i++) {
      const code =
        i % 2 === 0 ? encodeSt5(bytes(r, 16)) : must(normalizeUuid(uuidFrom(bytes(r, 16))))
      const masked = maskCode(code)
      const tail = code.replace(/-/g, '').slice(-4)
      expect(masked).toBe(MASK + tail)
    }
  })

  function uuidFrom(b: Uint8Array): string {
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
})
