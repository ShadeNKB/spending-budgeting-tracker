// Runtime guards for data that crosses a trust boundary. Backup files, relay payloads and
// localStorage are untrusted until they pass the data core's sanitiser (src/data/core); these
// small guards remain for the shell's own reads.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isString = (value: unknown): value is string => typeof value === 'string'

export const isNumber = (value: unknown): value is number => typeof value === 'number'

/** Keeps the items that pass `isItem`; anything that is not an array becomes `[]`. */
export function listOf<T>(value: unknown, isItem: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(isItem) : []
}

/**
 * Keeps the entries that pass `isEntry`; anything that is not a plain object becomes `{}`.
 * Built from entries, so a key named "__proto__" stays a key: assigning it would hit the
 * prototype setter and drop it, and the device holding it would disagree with every other.
 */
export function recordOf<T>(
  value: unknown,
  isEntry: (entry: unknown) => entry is T,
): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, T] => isEntry(pair[1])),
  )
}
