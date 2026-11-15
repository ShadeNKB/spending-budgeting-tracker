/**
 * Unpadded base64url and the compression check: the two things the local engine (snapshots) and
 * the private sync codec (`e2e.ts`) both need. A module of their own, so the local engine, which
 * every boot downloads, does not carry the codec with it (scripts/check-relay-weight.mjs).
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function buildB64urlTable(): Int8Array {
  const table = new Int8Array(128).fill(-1)
  for (let value = 0; value < B64URL.length; value++) table[B64URL.charCodeAt(value)] = value
  return table
}

/** Value of each base64url character by character code; -1 (or out of range) for anything else. */
const B64URL_VALUE = buildB64urlTable()

/** Unpadded base64url (RFC 4648 §5). */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64URL.charAt((acc >>> bits) & 63)
    }
    acc &= (1 << bits) - 1
  }
  // The last 2 or 4 bits, padded with zero bits to a whole character.
  return bits > 0 ? out + B64URL.charAt(acc << (6 - bits)) : out
}

/**
 * Strict decoder: the base64url alphabet only, no padding, no whitespace, and zero leftover bits,
 * so every byte string has exactly one accepted spelling. Anything else is null.
 */
export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let acc = 0
  let bits = 0
  let j = 0
  for (let i = 0; i < text.length; i++) {
    const value = B64URL_VALUE[text.charCodeAt(i)] ?? -1
    if (value < 0) return null
    acc = ((acc << 6) | value) & 0xfff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[j++] = acc >>> bits
    }
  }
  return (acc & ((1 << bits) - 1)) === 0 ? out : null
}

/** Whether this platform can gzip and gunzip (Compression Streams API). */
export function canCompress(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}
