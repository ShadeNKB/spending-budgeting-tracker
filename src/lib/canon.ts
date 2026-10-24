// Canonical JSON and a cheap content hash. Used to compare documents by content
// (sync "push only news", structure sharing) independent of key order.

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/**
 * Deeper than this, `canon` writes a value as one opaque token instead of recursing, so a
 * hostile payload nested thousands of levels deep cannot overflow the stack (and how deep an
 * engine's stack goes never decides what two devices compare). Nothing SpendTrack or v5 writes
 * nests more than a few levels.
 */
export const CANON_MAX_DEPTH = 64
// JSON.stringify escapes U+0000, so no JSON text equals this token.
const TOO_DEEP = '\u0000'

function write(value: unknown, depth: number): string {
  if (!isObject(value)) {
    // JSON has no undefined, function or symbol (in arrays JSON.stringify writes null).
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return 'null'
    }
    return JSON.stringify(value)
  }
  if (depth >= CANON_MAX_DEPTH) return TOO_DEEP
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    return `[${items.map((item) => write(item, depth + 1)).join(',')}]`
  }
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const member: unknown = Reflect.get(value, key)
    if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue
    parts.push(`${JSON.stringify(key)}:${write(member, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

/** JSON with object keys sorted, `undefined` members dropped and arrays kept in order. */
export function canon(value: unknown): string {
  return write(value, 0)
}

/**
 * Whether `value` nests objects and arrays no more than `max` levels below itself. Iterative,
 * so it is safe on a value of any depth.
 */
export function nestsWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, depth] = next
    if (!isObject(item)) continue
    if (depth > max) return false
    const children: readonly unknown[] = Array.isArray(item) ? item : Object.values(item)
    for (const child of children) stack.push([child, depth + 1])
  }
  return true
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
