/** Narrows `T | null | undefined` to `T` or fails the test with a readable message (no `!` in tests). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`must: missing ${what}`)
  return value
}

/** Reads a property of a fresh `{}`: undefined unless Object.prototype was polluted. */
export function protoProbe(name: string): unknown {
  const value: unknown = Reflect.get({}, name)
  return value
}

/** Parses JSON into `unknown` (callers narrow it; no casts). */
export function parseJson(text: string): unknown {
  return JSON.parse(text)
}

/** Reads an own property of an unknown value, or undefined. */
export function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Returns the value as an array of unknowns, or fails. */
export function arr(value: unknown, what = 'array'): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`arr: ${what} is not an array`)
  return value
}

/** Returns the value as a string, or fails. */
export function str(value: unknown, what = 'string'): string {
  if (typeof value !== 'string') throw new Error(`str: ${what} is not a string`)
  return value
}
