// Canonical JSON and FNV-1a lanes (DATA-ENGINE-SPEC §4.4). Integrity only, not security. Pure.

/** Lane offsets of the two independent FNV-1a 32 lanes (P-13). */
export const FNV_A = 0x811c9dc5
export const FNV_B = 0x050c5d1f

/**
 * JSON with object keys sorted, `undefined` members dropped, arrays in order, no whitespace, and
 * numbers as JSON.stringify renders them (NaN and ±Infinity become null).
 */
export function canon(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) {
    let out = '['
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ','
      const item: unknown = v[i]
      out += canon(item)
    }
    return out + ']'
  }
  const keys = Object.keys(v).sort()
  let out = '{'
  let first = true
  for (const k of keys) {
    const item: unknown = Object.getOwnPropertyDescriptor(v, k)?.value
    if (item === undefined) continue
    if (!first) out += ','
    first = false
    out += JSON.stringify(k) + ':' + canon(item)
  }
  return out + '}'
}

/** FNV-1a 32 over UTF-16 code units, starting from `offset`. Returns an unsigned 32-bit int. */
export function fnvLane(s: string, offset: number): number {
  let h = offset >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** Lane A rendered in base 36 (≤ 7 chars). */
export const fnv36 = (s: string): string => fnvLane(s, FNV_A).toString(36)

export const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
