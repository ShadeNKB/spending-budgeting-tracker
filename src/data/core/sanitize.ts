// Field- and collection-level guards used at every boundary (DATA-ENGINE-SPEC §8.1, F-005, F-010,
// P-3). Never throws; reads own data properties only; repairs are deterministic, so two devices
// always turn the same raw input into the same output and can never push-loop over a repair.
import {
  AMOUNT_MAX,
  CURRENCY_RE,
  EXTRA_BYTES_MAX,
  EXTRA_KEYS_MAX,
  EXTRA_KEY_RE,
  FIELD_KEYS,
  HASH_MAX,
  ID_MAX,
  KNOWN_RECORD_KEYS,
  OTHER,
  isReserved,
  nullRecord,
} from './constants'
import { isDateText, validDay } from './dates'
import type { Extras, FieldKey, Json } from './types'

/** A per-field stamp on the wire: a number (rank 2) or [stamp, rank 0|1] (§5.2). */
export type FsEntry = number | readonly [number, 0 | 1]
export type FsMap = Readonly<Partial<Record<FieldKey, FsEntry>>>

/** A record that passed §8.1: every field typed and bounded, extras null-prototype. */
export interface CleanExpense {
  readonly id: string
  readonly itemName: string
  readonly amount: number
  readonly category: string
  readonly date: string
  readonly notes?: string
  readonly createdAt: string
  readonly updatedAt?: string
  readonly day?: string
  readonly fs?: FsMap
  readonly h?: string
  readonly extras: Extras
}

export type QuarantineReason =
  | 'not-object'
  | 'bad-id'
  | 'bad-name'
  | 'bad-amount'
  | 'bad-date'
  | 'internal'

export type SanitizeExpenseResult =
  | { readonly kind: 'ok'; readonly rec: CleanExpense }
  | { readonly kind: 'repaired'; readonly rec: CleanExpense; readonly notes: readonly string[] }
  | { readonly kind: 'quarantine'; readonly reason: QuarantineReason }

/** C0 control characters and DEL. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

export function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** An own data property, never an inherited one, never a getter call (F-010). */
export function own(o: object, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k)
  return d === undefined ? undefined : d.value
}

/** Own enumerable string-keyed entries of a plain object, or null for any other shape. */
export function ownEntries(v: unknown): readonly (readonly [string, unknown])[] | null {
  if (!isPlainObject(v)) return null
  return Object.keys(v).map((k) => [k, own(v, k)] as const)
}

const isReservedLoose = (s: string): boolean => isReserved(s) || isReserved(s.trim())

export const validId = (x: unknown): x is string =>
  typeof x === 'string' && x.length >= 1 && x.length <= ID_MAX && !hasControl(x) && !isReserved(x)

// Names on the boundary have no length cap: v0.8 never capped item or category names, so a cap here
// would quarantine a real expense or re-file it to Other on migration (R1, R5), exactly as a notes
// cap would. New input is capped by the ops (NAME_MAX, CATEGORY_MAX); relay and file size caps bound
// hostile text.

/** A category name (§7.4): not blank, no control chars, not reserved (raw or trimmed, case-sensitive). */
export function validName(x: unknown): x is string {
  if (typeof x !== 'string') return false
  return x.trim().length >= 1 && !hasControl(x) && !isReservedLoose(x)
}

/** Item names are stored as-is (lossless); only a blank name is unreadable. */
export const validItemName = (x: unknown): x is string =>
  typeof x === 'string' && x.trim().length >= 1

/** A mapping key: the trimmed, lower-cased item name, not empty, not reserved (§7.6). */
export const validMapKey = (x: unknown): x is string =>
  typeof x === 'string' && x.length >= 1 && !isReservedLoose(x)

export const validCurrency = (x: unknown): x is string =>
  typeof x === 'string' && CURRENCY_RE.test(x)

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** Amounts and budgets: finite, 0 < x ≤ 1e7. A numeric string is repaired into a number. */
export function cleanAmount(x: unknown): { value: number; repaired: boolean } | null {
  let value: number
  let repaired = false
  if (typeof x === 'number') value = x
  else if (typeof x === 'string' && NUMERIC.test(x.trim())) {
    value = Number(x.trim())
    repaired = true
  } else return null
  return Number.isFinite(value) && value > 0 && value <= AMOUNT_MAX ? { value, repaired } : null
}

const isIsoText = (x: unknown): x is string => typeof x === 'string' && isDateText(x)

function cleanFs(x: unknown): FsMap | null {
  const entries = ownEntries(x)
  if (entries === null) return null
  const out: Partial<Record<FieldKey, FsEntry>> = {}
  for (const [k, v] of entries) {
    const f = FIELD_KEYS.find((key) => key === k)
    if (f === undefined) return null
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null
      out[f] = v
    } else if (Array.isArray(v) && v.length === 2) {
      const s: unknown = v[0]
      const r: unknown = v[1]
      if (typeof s !== 'number' || !Number.isFinite(s) || (r !== 0 && r !== 1)) return null
      out[f] = [s, r]
    } else return null
  }
  return out
}

/** JSON text of a value, or null when it is not serialisable (cycles, depth, functions). */
function jsonText(v: unknown): string | null {
  try {
    const text: unknown = JSON.stringify(v)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** Narrows a JSON.parse result to Json (always true for parser output; total for safety). */
export function isJson(v: unknown): v is Json {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((item: unknown) => isJson(item))
  if (!isPlainObject(v)) return false
  return Object.keys(v).every((k) => isJson(own(v, k)))
}

/** Unknown keys: ≤ 16 matching EXTRA_KEY_RE, not reserved, ≤ 2 KB as JSON, sorted-key order. */
/** Shared by every record without unknown keys (nearly all of them): frozen, null-prototype. */
const NO_EXTRAS: Extras = Object.freeze(nullRecord<Json>())

function cleanExtras(o: Readonly<Record<string, unknown>>): { extras: Extras; dropped: boolean } {
  const keys = Object.keys(o)
  if (keys.every((k) => KNOWN_RECORD_KEYS.has(k))) return { extras: NO_EXTRAS, dropped: false }
  const extras = nullRecord<Json>()
  let dropped = false
  let count = 0
  let length = 2
  for (const k of keys.sort()) {
    if (KNOWN_RECORD_KEYS.has(k)) continue
    if (!EXTRA_KEY_RE.test(k) || isReserved(k) || count >= EXTRA_KEYS_MAX) {
      dropped = true
      continue
    }
    const text = jsonText(own(o, k))
    const copy: unknown = text === null ? undefined : JSON.parse(text)
    const next =
      text === null
        ? Infinity
        : length + (count > 0 ? 1 : 0) + JSON.stringify(k).length + 1 + text.length
    if (text === null || next > EXTRA_BYTES_MAX || !isJson(copy)) {
      dropped = true
      continue
    }
    Object.defineProperty(extras, k, { value: copy, enumerable: true })
    count++
    length = next
  }
  return { extras: Object.freeze(extras), dropped }
}

function sanitizeUnsafe(raw: unknown): SanitizeExpenseResult {
  if (!isPlainObject(raw)) return { kind: 'quarantine', reason: 'not-object' }
  const id = own(raw, 'id')
  if (!validId(id)) return { kind: 'quarantine', reason: 'bad-id' }
  const itemName = own(raw, 'itemName')
  if (!validItemName(itemName)) return { kind: 'quarantine', reason: 'bad-name' }
  const amount = cleanAmount(own(raw, 'amount'))
  if (amount === null) return { kind: 'quarantine', reason: 'bad-amount' }
  const date = own(raw, 'date')
  if (!isIsoText(date)) return { kind: 'quarantine', reason: 'bad-date' }

  const notes: string[] = []
  if (amount.repaired) notes.push('amount')
  const categoryRaw = own(raw, 'category')
  const category = validName(categoryRaw) ? categoryRaw : OTHER
  if (category !== categoryRaw) notes.push('category')
  const createdAtRaw = own(raw, 'createdAt')
  const createdAt = isIsoText(createdAtRaw) ? createdAtRaw : date
  if (createdAt !== createdAtRaw) notes.push('createdAt')

  const updatedAtRaw = own(raw, 'updatedAt')
  const updatedAt = isIsoText(updatedAtRaw) ? updatedAtRaw : undefined
  if (updatedAtRaw !== undefined && updatedAt === undefined) notes.push('updatedAt')
  const notesRaw = own(raw, 'notes')
  // any string, stored as-is: v0.8 never capped notes, so a cap here would drop real data (R1);
  // new input is capped by the ops (NOTES_INPUT_MAX)
  const note = typeof notesRaw === 'string' ? notesRaw : undefined
  if (notesRaw !== undefined && notesRaw !== null && note === undefined) notes.push('notes')
  const dayRaw = own(raw, 'day')
  const day = validDay(dayRaw) ? dayRaw : undefined
  if (dayRaw !== undefined && day === undefined) notes.push('day')
  const fsRaw = own(raw, 'fs')
  const fs = fsRaw === undefined ? null : cleanFs(fsRaw)
  if (fsRaw !== undefined && fs === null) notes.push('fs')
  const hRaw = own(raw, 'h')
  const h = typeof hRaw === 'string' && hRaw.length <= HASH_MAX ? hRaw : undefined
  if (hRaw !== undefined && h === undefined) notes.push('h')
  const { extras, dropped } = cleanExtras(raw)
  if (dropped) notes.push('extras')

  const rec: CleanExpense = {
    id,
    itemName,
    amount: amount.value,
    category,
    date,
    ...(note === undefined ? {} : { notes: note }),
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(day === undefined ? {} : { day }),
    ...(fs === null ? {} : { fs }),
    ...(h === undefined ? {} : { h }),
    extras,
  }
  return notes.length === 0 ? { kind: 'ok', rec } : { kind: 'repaired', rec, notes }
}

/** §8.1. Never throws: an internal error becomes a quarantine with reason `internal`. */
export function sanitizeExpense(raw: unknown): SanitizeExpenseResult {
  try {
    return sanitizeUnsafe(raw)
  } catch {
    return { kind: 'quarantine', reason: 'internal' }
  }
}

/**
 * The canonical wire object of a clean record (known keys in wire order, then extras sorted).
 * Used to detect identical copies and to derive dedupe ids (§7.9).
 */
export function cleanWire(rec: CleanExpense): Readonly<Record<string, unknown>> {
  const out = nullRecord<unknown>()
  const put = (k: string, v: unknown): void => {
    if (v !== undefined) Object.defineProperty(out, k, { value: v, enumerable: true })
  }
  put('id', rec.id)
  put('itemName', rec.itemName)
  put('amount', rec.amount)
  put('category', rec.category)
  put('date', rec.date)
  put('notes', rec.notes)
  put('createdAt', rec.createdAt)
  put('updatedAt', rec.updatedAt)
  put('day', rec.day)
  put('fs', rec.fs)
  put('h', rec.h)
  for (const k of Object.keys(rec.extras)) put(k, rec.extras[k])
  return out
}
