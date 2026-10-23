/**
 * Sync codes (DATA-ENGINE-SPEC §11.6, §13.3, §13.7; finding F-104).
 *
 * Two kinds of code reach the Join sheet, and both are checked here before any network call:
 * - a plain code is today's UUID, accepted exactly as v0.8 accepts it (trim, lower-case, 8-4-4-4-12
 *   hex), so a code that works on an old device works here and names the same row;
 * - a private code (ST5) is a 128-bit secret written as 26 Crockford base32 symbols, big-endian
 *   (so the first symbol is 0-7), plus 2 check symbols: bits 31-27 and 26-22 of FNV-1a-32 over
 *   the 16 secret bytes. Displayed as `ST5-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX`. v0.8 rejects these
 *   with its UUID check, so an old device cannot join a private row (it fails closed).
 *
 * Typed input is forgiving: case, spaces, any kind of dash and the `ST5` prefix are ignored, and
 * `I`/`L` read as `1`, `O` as `0` (the letters Crockford leaves out because they look like digits).
 * Only ASCII letters change case, so no other character can turn into a valid symbol.
 *
 * The check is frozen by the §13.7 vector. Measured over every single-symbol typo of 1,500 random
 * secrets, it lets 2.1 in 1,024 through (26 in 1,024 in the 24th symbol: FNV-1a has no final mixing).
 *
 * Pure: no IO, no randomness (the secret comes from the caller).
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SECRET_BYTES = 16
const DATA_SYMBOLS = 26
const CHECK_SYMBOLS = 2
const GROUP = 7
const PREFIX = 'ST5'
const PREFIX_AT_START = /^st5/i
const MASK = '••••'
const SHOWN = 4

/** Whitespace and every dash a phone keyboard or a paste can produce. */
const SEPARATORS = /[-\s\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type St5Failure = 'length' | 'symbol' | 'range' | 'checksum'

export type St5Parse =
  | { readonly ok: true; readonly secret: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: St5Failure }

export type SyncCode =
  | { readonly kind: 'plain'; readonly code: string }
  | { readonly kind: 'e2e'; readonly code: string; readonly secret: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'invalid'; readonly reason: St5Failure }

function buildSymbolTable(): Int8Array {
  const table = new Int8Array(128).fill(-1)
  const set = (chars: string, value: number): void => {
    for (const ch of chars) {
      table[ch.charCodeAt(0)] = value
      table[ch.toLowerCase().charCodeAt(0)] = value
    }
  }
  for (let value = 0; value < ALPHABET.length; value++) set(ALPHABET.charAt(value), value)
  set('IL', 1)
  set('O', 0)
  return table
}

/** Symbol value per character code: the alphabet in either case, `I`/`L` as 1, `O` as 0, else -1. */
const SYMBOL_VALUE = buildSymbolTable()

const symbolValue = (code: number): number => SYMBOL_VALUE[code] ?? -1

/** The 10 check bits: bits 31-22 of FNV-1a-32 over the bytes (not the UTF-16 string hash of `hash.ts`). */
function checkBits(secret: Uint8Array): number {
  let h = 0x811c9dc5
  for (const byte of secret) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 22
}

/** The private code for a 16-byte secret, in display form. */
export function encodeSt5(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new RangeError('A private sync secret is 16 bytes')
  // 26 symbols carry 130 bits: two leading zero bits, then the 128 secret bits.
  let symbols = ''
  let acc = 0
  let bits = 2
  for (const byte of secret) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      symbols += ALPHABET.charAt((acc >>> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  const check = checkBits(secret)
  symbols += ALPHABET.charAt(check >>> 5) + ALPHABET.charAt(check & 31)
  const groups = [PREFIX]
  for (let i = 0; i < symbols.length; i += GROUP) groups.push(symbols.slice(i, i + GROUP))
  return groups.join('-')
}

/** Reads a typed or pasted private code. Returns a fresh secret the caller may keep or wipe. */
export function parseSt5(input: string): St5Parse {
  let s = input.replace(SEPARATORS, '')
  if (PREFIX_AT_START.test(s)) s = s.slice(PREFIX.length)
  if (s.length !== DATA_SYMBOLS + CHECK_SYMBOLS) return { ok: false, reason: 'length' }

  const secret = new Uint8Array(SECRET_BYTES)
  let first = 0
  let acc = 0
  let bits = 0
  let byte = 0
  let check = 0
  for (let i = 0; i < s.length; i++) {
    const value = symbolValue(s.charCodeAt(i))
    if (value < 0) return { ok: false, reason: 'symbol' }
    if (i === 0) {
      // The first symbol is the two leading zero bits (checked below) and the top 3 secret bits.
      first = value
      acc = value & 7
      bits = 3
    } else if (i < DATA_SYMBOLS) {
      acc = (acc << 5) | value
      bits += 5
      if (bits >= 8) {
        bits -= 8
        secret[byte++] = acc >>> bits
        acc &= (1 << bits) - 1
      }
    } else {
      check = (check << 5) | value
    }
  }
  if (first > 7) return { ok: false, reason: 'range' }
  if (check !== checkBits(secret)) return { ok: false, reason: 'checksum' }
  return { ok: true, secret }
}

/** A plain code exactly as v0.8 accepts it (`trim().toLowerCase()` plus its UUID check), or null. */
export function normalizeUuid(input: string): string | null {
  const s = input.trim().toLowerCase()
  return UUID.test(s) ? s : null
}

/** Classifies what was typed or pasted into the Join sheet. A private code comes back in display form. */
export function parseSyncCode(input: string): SyncCode {
  const plain = normalizeUuid(input)
  if (plain !== null) return { kind: 'plain', code: plain }
  const st5 = parseSt5(input)
  if (!st5.ok) return { kind: 'invalid', reason: st5.reason }
  return { kind: 'e2e', code: encodeSt5(st5.secret), secret: st5.secret }
}

/** Masked display (`••••-…-1a2b`): the last 4 characters only, and none of a code too short to spare them. */
export function maskCode(code: string): string {
  const symbols = code.replace(SEPARATORS, '')
  return symbols.length <= SHOWN ? MASK : `${MASK}-…-${symbols.slice(-SHOWN)}`
}
