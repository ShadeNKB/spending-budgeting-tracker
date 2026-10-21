// Canonical JSON and a cheap content hash. Used to compare documents by content
// (sync "push only news", structure sharing) independent of key order.

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/** JSON with object keys sorted, `undefined` members dropped and arrays kept in order. */
export function canon(value: unknown): string {
  if (!isObject(value)) {
    // JSON has no undefined, function or symbol (in arrays JSON.stringify writes null).
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return 'null'
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    return `[${items.map(canon).join(',')}]`
  }
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const member: unknown = Reflect.get(value, key)
    if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue
    parts.push(`${JSON.stringify(key)}:${canon(member)}`)
  }
  return `{${parts.join(',')}}`
}

// Rows are immutable once stored, so their canonical form is cached per object.
const rowCache = new WeakMap<object, string>()

/** `canon` with a per-object cache, for expense rows. */
export function canonRow(row: unknown): string {
  if (!isObject(row)) return canon(row)
  const cached = rowCache.get(row)
  if (cached !== undefined) return cached
  const text = canon(row)
  rowCache.set(row, text)
  return text
}

/** FNV-1a 32-bit over UTF-16 code units, in base 36. Detects change; it is not security. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
