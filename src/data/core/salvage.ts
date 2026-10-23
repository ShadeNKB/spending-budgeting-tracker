/**
 * Salvage of a damaged JSON array (DATA-ENGINE-SPEC §9.6.2, §9.6.3; finding F-014).
 *
 * A stored array that no longer parses (a write cut short by a killed tab, a hand edit, a bad copy)
 * is never thrown away. This scanner walks the top-level array and keeps every element that is
 * complete and readable. It tracks strings, escapes and nesting, so a comma or a bracket inside an
 * item name or a note never splits a row.
 *
 * Rules:
 * - an element ends at a comma or at the closing bracket of the array (outside strings and nested
 *   containers), and is kept when `JSON.parse` accepts it; one that does not parse is counted in
 *   `skipped` and the scan carries on with the next element;
 * - empty slots and trailing commas are ignored (not counted);
 * - `null` elements are kept: the sanitiser decides what to do with them;
 * - when the input ends inside the array, the last element is kept only if it is provably finished
 *   (a string or container that closed, or a value followed by whitespace). A bare value touching
 *   the cut may itself be cut (`12` of `125`), so it is dropped without being counted;
 * - anything that is not an array gives `{ items: [], complete: false, skipped: 0 }`.
 *
 * Pure, linear in the input, and never throws.
 */

export interface Salvage {
  /** Every complete, readable element, in order. */
  readonly items: readonly unknown[]
  /** True when the array closed and nothing but whitespace follows it. */
  readonly complete: boolean
  /** Finished elements that were not valid JSON. An element cut by the end of input is not counted. */
  readonly skipped: number
}

const QUOTE = 0x22 // "
const COMMA = 0x2c // ,
const BACKSLASH = 0x5c // \
const OPEN_SQUARE = 0x5b // [
const CLOSE_SQUARE = 0x5d // ]
const OPEN_CURLY = 0x7b // {
const CLOSE_CURLY = 0x7d // }
const BYTE_ORDER_MARK = 0xfeff

/** JSON whitespace only (space, tab, line feed, carriage return), as `JSON.parse` defines it. */
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && isSpace(text.charCodeAt(i))) i++
  return i
}

/** Whether `text[from, to)` holds JSON whitespace only (an empty span counts as blank). */
function isBlank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!isSpace(text.charCodeAt(i))) return false
  return true
}

export function salvageJsonArray(raw: unknown): Salvage {
  if (typeof raw !== 'string') return { items: [], complete: false, skipped: 0 }
  let i = skipSpace(raw, raw.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0)
  if (raw.charCodeAt(i) !== OPEN_SQUARE) return { items: [], complete: false, skipped: 0 }

  const items: unknown[] = []
  let skipped = 0
  const take = (from: number, to: number): void => {
    if (isBlank(raw, from, to)) return
    try {
      const value: unknown = JSON.parse(raw.slice(from, to))
      items.push(value)
    } catch {
      skipped++
    }
  }

  let start = ++i
  let depth = 0
  let inString = false
  let escaped = false
  for (; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (code === BACKSLASH) escaped = true
      else if (code === QUOTE) inString = false
    } else if (code === QUOTE) {
      inString = true
    } else if (code === OPEN_SQUARE || code === OPEN_CURLY) {
      depth++
    } else if (code === CLOSE_CURLY) {
      // A stray closer at depth 0 stays inside the element, which then fails to parse.
      if (depth > 0) depth--
    } else if (code === CLOSE_SQUARE) {
      if (depth === 0) {
        take(start, i)
        return { items, complete: isBlank(raw, i + 1, raw.length), skipped }
      }
      depth--
    } else if (code === COMMA && depth === 0) {
      take(start, i)
      start = i + 1
    }
  }

  // The input ended inside the array.
  if (!inString && depth === 0 && isFinished(raw, start)) take(start, raw.length)
  return { items, complete: false, skipped }
}

/** Whether the text from `start` to the end is a value that cannot have been cut short. */
function isFinished(raw: string, start: number): boolean {
  if (isBlank(raw, start, raw.length)) return false
  const last = raw.charCodeAt(raw.length - 1)
  return isSpace(last) || last === QUOTE || last === CLOSE_CURLY || last === CLOSE_SQUARE
}
