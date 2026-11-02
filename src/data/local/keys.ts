// Every storage key SpendTrack owns (DATA-ENGINE-SPEC §9.2, track spec §8.11, P2-3).
// "Remove from this device" and the raw export use exactly this list.
import { MIRROR_ORDER, V4_KEYS } from '../core/constants'

export const DB_KEY = 'st5:db'
export const GEN_KEY = 'st5:gen'
export const SYNC_KEY = 'st5:sync'
export const DEV_KEY = 'st5:dev'
export const QUARANTINE_KEY = 'st5:q'
/** Raw copies of corrupt whole keys: `st5:q:<key>:<ts>`. */
export const QUARANTINE_RAW_PREFIX = 'st5:q:'
export const SNAPS_KEY = 'st5:snaps'
/** Snapshot bodies: `st5:snap:<id>`. */
export const SNAP_PREFIX = 'st5:snap:'
export const JOURNAL_KEY = 'st5:journal'
export const DEMO_KEY = 'st5:demo'

export const APP_KEY = 'spendtrack:app'
export const LEGACY_DEV_KEY = 'spendtrack:dev'
export const CURRENCY_PREF_KEY = 'spendtrack:currency'
export const THEME_PREF_KEY = 'spendtrack:theme'
export const SYNC_ID_KEY = 'syncId'
/** The eighth v4 key (P2-3): per-mapping stamps, written by 0.9.2. */
export const MAPPING_STAMPS_KEY = 'categoryMappingUpdatedAt'
/** The writer marker this build leaves with every mirror write (P2-6). */
export const WRITER_MARK = '5'

const unique = (keys: readonly string[]): readonly string[] => Object.freeze([...new Set(keys)])

/** The v4 data keys: the mirror, read as truth only on migration, rollback and recovery. */
export const V4_DATA_KEYS: readonly string[] = unique([
  ...MIRROR_ORDER,
  ...V4_KEYS,
  MAPPING_STAMPS_KEY,
])

/** The key prefixes that belong to SpendTrack whatever follows them. */
export const KEY_PREFIXES: readonly string[] = Object.freeze(['st5:', 'spendtrack:'])

export const ALL_KEYS: readonly string[] = unique([
  DB_KEY,
  GEN_KEY,
  SYNC_KEY,
  DEV_KEY,
  QUARANTINE_KEY,
  SNAPS_KEY,
  JOURNAL_KEY,
  DEMO_KEY,
  ...V4_DATA_KEYS,
  SYNC_ID_KEY,
  'categoryColors',
  THEME_PREF_KEY,
  CURRENCY_PREF_KEY,
  APP_KEY,
  LEGACY_DEV_KEY,
])

const KNOWN: ReadonlySet<string> = new Set(ALL_KEYS)

export const isSpendTrackKey = (key: string): boolean =>
  KNOWN.has(key) || KEY_PREFIXES.some((p) => key.startsWith(p))

export const isV4DataKey = (key: string): boolean => V4_DATA_KEYS.includes(key)
