// Limits, thresholds and fixed key lists of the v5 data core (DATA-ENGINE-SPEC §3.2).
import type { FieldKey, V4Key } from './types'

/** Fixed stamp validity window [MIN_T, MAX_T): wall-clock independent (§4.1). */
export const MIN_T = Date.UTC(2000, 0, 1)
export const MAX_T = Date.UTC(2100, 0, 1)
/** How far the local clock follows peer stamps (§4.2). */
export const MAX_AHEAD = 86_400_000

export const AMOUNT_MAX = 10_000_000
/**
 * What a new op accepts for an item name and a NEW category name (P-18). The sanitiser keeps longer
 * names that already exist: v0.8 never capped either, so a cap at the boundary would quarantine a
 * real expense or re-file it to Other on migration (R1, R5), as it would for notes.
 */
export const NAME_MAX = 200
export const CATEGORY_MAX = 60
/**
 * What a new op accepts (the UI caps notes at 500; P-18). The sanitiser keeps existing notes of any
 * length: v0.8 never capped them, so the contract's 2,000 boundary would have dropped real data.
 */
export const NOTES_INPUT_MAX = 500
export const ID_MAX = 64
export const HASH_MAX = 16

export const EXTRA_KEYS_MAX = 16
export const EXTRA_BYTES_MAX = 2048
export const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

/**
 * Names that must never become a plain-object key (F-010, P-4). A frozen literal, not
 * `Object.getOwnPropertyNames(Object.prototype)`, so every engine sanitises identically.
 */
export const RESERVED_NAMES: readonly string[] = Object.freeze([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  'prototype',
])
const RESERVED = new Set(RESERVED_NAMES)
/** Case-sensitive. */
export const isReserved = (name: string): boolean => RESERVED.has(name)

/** A fresh null-prototype record: user text as a key can never reach Object.prototype (F-010). */
export function nullRecord<V>(): Record<string, V> {
  const out: Record<string, V> = {}
  Object.setPrototypeOf(out, null)
  return out
}

/** Relay row ≤ 1 MB; warn from 70 % (§10.1, F-016). */
export const WIRE_PUSH_MAX = 900_000
export const WIRE_WARN = 630_000
export const PULL_MAX = 5_000_000
export const IMPORT_MAX_BYTES = 8_000_000
export const IMPORT_MAX_ROWS = 50_000
/** Records accepted from one source; the excess is quarantined as `cap` (§8.2). */
export const RECORDS_MAX = 50_000

/** Mass-removal guard: removed ≥ 10 and (≥ 50 or ≥ 10 % of live) (§11.9). */
export const GUARD_MIN = 10
export const GUARD_ABS = 50
export const GUARD_FRAC = 0.1

/** Old-writer loop breaker and ext-refresh period (§11.4). */
export const MEMO_WINDOW = 600_000
export const CAS_FORCE_AFTER = 3
export const CYCLE_ATTEMPTS_MAX = 6
export const PUSH_QUIET = 1500
export const PUSH_MAX_WAIT = 5000
export const UNDO_MS = 5000

/** Local persistence budgets (§9.7, §9.8, §9.11), consumed by the IO shell (PR-2). */
export const JOURNAL_BYTES = 262_144
export const QUARANTINE_BYTES = 524_288
export const SNAP_DAILY = 3
export const SNAP_PRE = 5
export const SNAP_BYTES = 1_000_000
export const LS_BUDGET = 2_000_000

/** Sync timing (§3.2, §11.2, §11.8), consumed by the sync engine (PR-3). */
export const BACKOFF_BASE = 2000
export const BACKOFF_CAP = 60_000
export const BACKOFF_JITTER = 0.2
export const POLL_VISIBLE = 60_000
export const STORM_CYCLES = 20
export const STORM_WINDOW = 60_000
export const REMOTE_COALESCE = 300
/** One quarantine entry keeps at most this many characters of the raw value. */
export const QUARANTINE_RAW_MAX = 65_536

export const FIELD_KEYS: readonly FieldKey[] = Object.freeze(['n', 'a', 'c', 'd', 'o', 'x'])

/** Known record keys on the wire; everything else is an extra (§5.2). */
export const KNOWN_RECORD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'itemName',
  'amount',
  'category',
  'date',
  'notes',
  'createdAt',
  'updatedAt',
  'day',
  'fs',
  'h',
])

export const OTHER = 'Other'
/**
 * Report reason of a record a source lists both live and deleted that does not stay live (the
 * tombstone won, or a fold left the id out); its original is kept in `SanitizeReport.repairs`.
 */
export const LIVE_AND_DELETED = 'live-and-deleted'
export const CURRENCY_KEY = 'currency'
export const CURRENCY_RE = /^[A-Z]{3}$/
/** v0.8 hydrate fills missing budget stamps with the 1970 epoch; it decodes to stamp 0. */
export const LEGACY_EPOCH_ISO = '1970-01-01T00:00:00.000Z'
export const DEMO_PREFIX = 'demo-'

export const V4_KEYS: readonly V4Key[] = Object.freeze([
  'expenses',
  'categories',
  'categoryMappings',
  'categoryBudgets',
  'categoryBudgetUpdatedAt',
  'categoryBudgetDeletedAt',
  'deletedExpenseIds',
])

/** Crash-safe write order of the v4 mirror: tombstones before expenses (§9.10, I10). */
export const MIRROR_ORDER: readonly V4Key[] = Object.freeze([
  'categoryBudgetDeletedAt',
  'categoryBudgets',
  'categoryBudgetUpdatedAt',
  'categoryMappings',
  'categories',
  'deletedExpenseIds',
  'expenses',
])

/** The writer schema of this build and the lowest client level allowed to push a plain row. */
export const SCHEMA = 5
export const SCHEMA_MINOR = 0
export const PLAIN_MIN = 4
export const MOVED_MIN = 99
