// The one tolerant JSON read of the local layer. Stored strings, raw exports and backup files are
// untrusted: a parse failure is a value (null), never an exception, and what parses is `unknown`
// until it is narrowed.

/** `{value}` when `text` is JSON, else null. */
export function parseJson(text: string): { readonly value: unknown } | null {
  try {
    const value: unknown = JSON.parse(text)
    return { value }
  } catch {
    return null
  }
}

/** The elements of an array, or none for anything else. */
export const listOf = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** The array elements stored under `text`, or none when it is absent or not JSON. */
export const storedList = (text: string | null): readonly unknown[] =>
  text === null ? [] : listOf(parseJson(text)?.value)
