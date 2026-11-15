// The move's own record (PRIVATE-SYNC 4.2): what "Make sync private" keeps while it retires the
// old plain row, in a key no shipped writer touches. Every setup of release 1 rewrites `st5:sync`
// and `st5:synckey` from scratch, so state kept in either would be erased by the next start-up,
// or by a tab still running 0.21.0.
// Lazy: only the sync engine imports it (and, later, the Settings › Sync panel, itself lazy), so
// none of it ships on the start-up path. It reads and writes storage; it never touches the relay.

import { parseSt5 } from '../core/codes'
import { deriveKeys } from '../core/e2e'
import { FNV_A, FNV_B, fnvLane } from '../core/hash'
import { safeSet, storage } from '../../services/storage'

/**
 * The record's key. It holds the plain code (`from`), so its name says `synckey`: the rescue
 * export leaves out every such key (lib/rescue.ts), in older builds too, and "Remove from this
 * device" removes every `st5:` key.
 */
export const MOVE_KEY = 'st5:synckey:move'

export interface MoveRecord {
  readonly v: 1
  /** `moveFingerprint` of the private row id this move made: never the code or its secret. */
  readonly for: string
  /** The plain code the device moved from (`U`): it asks about the plain row with it. */
  readonly from: string
  /** When the switch was made (epoch ms). */
  readonly at: number
  /** `retiring` until the plain row has been seen holding a marker, then `retired`. */
  readonly phase: 'retiring' | 'retired'
  /** The token of the one plain payload merged at step 5, or null. */
  readonly absorbed: string | null
  /** The plain row's token when it was last seen holding a marker, or null. */
  readonly retired: string | null
  /** When the plain row was last asked about (epoch ms), or null. */
  readonly checkedAt: number | null
  /** Compare-and-sets of the marker that conflicted in a row (kept here across reloads). */
  readonly conflicts: number
  /** Step 5 found another device's marker; cleared when another private device joins. */
  readonly contested: boolean
}

const FIELDS: readonly string[] = [
  'v',
  'for',
  'from',
  'at',
  'phase',
  'absorbed',
  'retired',
  'checkedAt',
  'conflicts',
  'contested',
]
const FINGERPRINT = /^[0-9a-z]{14}$/
/** A plain code the relay can hold: a lower-case UUID (004 refuses any other row id). */
const PLAIN_ROW = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOKEN_MAX = 64

/**
 * A fingerprint of a private row id: both 32-bit FNV-1a lanes of the data core, 7 base36
 * characters each. The row id is 122 bits derived from the secret, so 64 bits cannot be turned
 * back into it, and a stale record matching another bucket by chance is a 2^-64 event. It is
 * synchronous, so the engine checks a record against the bucket it holds with no await between
 * reading storage and acting on it.
 */
export function moveFingerprint(rowId: string): string {
  const lane = (offset: number): string => fnvLane(rowId, offset).toString(36).padStart(7, '0')
  return lane(FNV_A) + lane(FNV_B)
}

const isRecordLike = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const isToken = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v !== '' && v.length <= TOKEN_MAX)

/** The record a parsed value is, or null for anything else: a field missing, extra or wrong. */
function moveOf(v: unknown): MoveRecord | null {
  if (!isRecordLike(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== FIELDS.length || !keys.every((k) => FIELDS.includes(k))) return null
  const { for: fp, from, at, phase, absorbed, retired, checkedAt, conflicts, contested } = v
  if (
    v.v !== 1 ||
    typeof fp !== 'string' ||
    !FINGERPRINT.test(fp) ||
    typeof from !== 'string' ||
    !PLAIN_ROW.test(from) ||
    !isTime(at) ||
    (phase !== 'retiring' && phase !== 'retired') ||
    !isToken(absorbed) ||
    !isToken(retired) ||
    !(checkedAt === null || isTime(checkedAt)) ||
    typeof conflicts !== 'number' ||
    !Number.isInteger(conflicts) ||
    conflicts < 0 ||
    typeof contested !== 'boolean'
  ) {
    return null
  }
  return { v: 1, for: fp, from, at, phase, absorbed, retired, checkedAt, conflicts, contested }
}

/** The storage this module works on: the page's own, bound the first time it is needed. */
let bound: Storage | null = null
const page = (): Storage => (bound ??= localStorage)

/** The stored text; null when absent or when storage refused the read. */
function readRaw(): string | null {
  try {
    return page().getItem(MOVE_KEY)
  } catch {
    return null
  }
}

function parsed(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
}

/** The move's record, or null when there is none or what is stored is not one. */
export function readMove(): MoveRecord | null {
  const raw = readRaw()
  return raw === null ? null : moveOf(parsed(raw))
}

/**
 * Writes the record and reads it back. Throws a RangeError for a value that is not a record
 * (nothing is written), the quota error `safeSet` throws, or an Error when storage did not keep
 * it: the caller stops the move then, with nothing switched.
 */
export function writeMove(record: MoveRecord): void {
  const checked = moveOf(parsed(JSON.stringify(record)))
  if (checked === null) throw new RangeError('Not a move record.')
  const value = JSON.stringify(checked)
  safeSet(MOVE_KEY, value, page())
  if (readRaw() !== value) throw new Error('This browser did not keep the move record.')
}

/** Removes the record. Best effort: a key that cannot be removed is judged again next time. */
export function removeMove(): void {
  try {
    page().removeItem(MOVE_KEY)
  } catch {
    // storage refused: the next sweep decides again
  }
}

/**
 * The void rule: a record belongs to the private bucket whose row id it was made for. With no
 * private key (`rowId` null), or another bucket's, it belongs to nothing and is never acted on.
 */
export function isVoidMove(record: MoveRecord, rowId: string | null): boolean {
  return rowId === null || record.for !== moveFingerprint(rowId)
}

/** A stored value of a later format (`v` above 1): a newer build's, kept as it is. */
const isNewer = (v: unknown): boolean =>
  isRecordLike(v) && typeof v.v === 'number' && Number.isInteger(v.v) && v.v > 1

/**
 * The record for the bucket with this private row id (null: the device holds no private key),
 * or null. A void record is removed, and so is a damaged one (it may hold the plain code and can
 * never be acted on); a newer build's is left alone.
 */
export function dropVoidMove(rowId: string | null): MoveRecord | null {
  const raw = readRaw()
  if (raw === null) return null
  const value = parsed(raw)
  const record = moveOf(value)
  if (record !== null && !isVoidMove(record, rowId)) return record
  if (record === null && isNewer(value)) return null
  removeMove()
  return null
}

/** The private code `st5:synckey` holds now, or null (the reader rule of storage.ts). */
function heldCode(): string | null {
  const cfg = storage.getSyncConfig()
  return cfg?.kind === 'e2e' ? cfg.code : null
}

/**
 * `dropVoidMove` for a caller that holds no bucket (engine start, Settings › Sync, the button):
 * the row id is derived from the code in `st5:synckey`. Decides nothing (null, the record left
 * as it is) when the row id cannot be derived, or when the setup changed while it was.
 */
export async function sweepVoidMove(): Promise<MoveRecord | null> {
  const code = heldCode()
  let rowId: string | null = null
  if (code !== null) {
    const parsedCode = parseSt5(code)
    if (!parsedCode.ok) return null
    try {
      rowId = (await deriveKeys(parsedCode.secret)).rowId
    } catch {
      return null
    } finally {
      parsedCode.secret.fill(0)
    }
  }
  // another tab may have joined, disconnected or moved meanwhile: its next sweep decides
  if (heldCode() !== code) return null
  return dropVoidMove(rowId)
}
