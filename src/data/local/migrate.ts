// Reading the v4 keys (DATA-ENGINE-SPEC §9.6.2, track spec §8.2, P2-6). Each key is read on its
// own: one that does not parse never blocks another, an array key is salvaged element by element,
// and the raw string of a broken key is kept for the quarantine. Nothing is re-filed, no stamp is
// invented and no date or amount is rewritten: decodeWire reads exactly what 0.9.x stored.
import { MIRROR_ORDER } from '../core/constants'
import { salvageJsonArray } from '../core/salvage'
import type { DecodeOptions } from '../core/wire'
import { decodeWire, fromV4Keys, mirrorSum } from '../core/wire'
import type { SanitizeResult } from '../core/types'
import { parseJson } from './json'
import { APP_KEY, V4_DATA_KEYS } from './keys'

/** Reads one stored string (null when absent): storage, a raw export or a snapshot. */
export type KeyReader = (key: string) => string | null

/** The v4 keys that hold arrays: a damaged one is salvaged element by element. */
const ARRAY_KEYS: ReadonlySet<string> = new Set(['expenses', 'deletedExpenseIds', 'categories'])

export interface V4Read {
  /** Parsed (or salvaged) value per present key. */
  readonly parsed: Readonly<Record<string, unknown>>
  /** The raw string of every present key. */
  readonly raws: Readonly<Record<string, string>>
  /** Keys whose value did not parse as JSON (their raw copy goes to the quarantine). */
  readonly broken: readonly string[]
  /** Rows a salvage could not keep (finished elements that were not JSON). */
  readonly salvageSkipped: number
  /** Any v4 data key present at all. */
  readonly present: boolean
  /** Rows in the stored expenses array as far as it could be read. */
  readonly rows: number
}

export function readV4(get: KeyReader): V4Read {
  const parsed: Record<string, unknown> = {}
  Object.setPrototypeOf(parsed, null)
  const raws: Record<string, string> = {}
  Object.setPrototypeOf(raws, null)
  const broken: string[] = []
  let salvageSkipped = 0
  let rows = 0
  for (const key of V4_DATA_KEYS) {
    const raw = get(key)
    if (raw === null) continue
    raws[key] = raw
    const p = parseJson(raw)
    if (p !== null) {
      parsed[key] = p.value
      if (key === 'expenses' && Array.isArray(p.value)) rows = p.value.length
      continue
    }
    broken.push(key)
    if (ARRAY_KEYS.has(key)) {
      const s = salvageJsonArray(raw)
      parsed[key] = s.items
      salvageSkipped += s.skipped
      if (key === 'expenses') rows = s.items.length
    }
  }
  return { parsed, raws, broken, salvageSkipped, present: Object.keys(raws).length > 0, rows }
}

/** Whether any v4 data key exists (cheap: no parse). */
export function anyV4(get: KeyReader): boolean {
  return V4_DATA_KEYS.some((k) => get(k) !== null)
}

/** mirrorSum of the stored v4 strings: equal to meta.mirrorSum iff the mirror is ours. */
export function hashV4(get: KeyReader): string {
  const strings: Record<string, string | null> = {}
  for (const k of MIRROR_ORDER) strings[k] = get(k)
  return mirrorSum(strings)
}

/**
 * P2-6: local v4 keys decode at srcRank 1 iff `spendtrack:app` is a dotted numeric version at or
 * above 0.8.5 by segment ('0.8.5' from 0.9.x, '5' from this build); absent or older → 0.
 */
export function legacyRankOf(app: string | null): 0 | 1 {
  if (app === null || !/^\d+(\.\d+)*$/.test(app)) return 0
  const have = app.split('.').map(Number)
  const floor = [0, 8, 5]
  for (let i = 0; i < floor.length; i++) {
    const a = have[i] ?? 0
    const b = floor[i] ?? 0
    if (a !== b) return a > b ? 1 : 0
  }
  return 1
}

export const rankOf = (io: { get: KeyReader }): 0 | 1 => legacyRankOf(io.get(APP_KEY))

/** decodeWire of the read keys as local v4 data (a migration, or a fold with `fold: true`). */
export function decodeV4(v4: V4Read, opts: DecodeOptions): SanitizeResult {
  return decodeWire(fromV4Keys(v4.parsed), 'local-v4', opts)
}
