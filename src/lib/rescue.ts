// "Download my data" for the error screens.
//
// It has to work when the data itself is what crashed the app, so it never parses, migrates
// or validates anything: every localStorage value is copied as the raw string it is, and
// the stores are not touched. Secret-like keys (the sync code, auth tokens) stay behind
// so the file is safe to keep or share for support.

import { format } from 'date-fns'
import { downloadJSON } from './download'

/** Keys left out of the dump. Name any new secret key so it matches this. */
export const SECRET_KEY_PATTERN =
  /^syncId$|secret|token|passphrase|synckey|cryptokey|encryptionkey/i

export type RawStorage = Pick<Storage, 'length' | 'key' | 'getItem'>

export interface RescueFile {
  filename: string
  payload: {
    app: 'SpendTrack'
    kind: 'raw-browser-backup'
    version: 1
    exportedAt: string
    note: string
    keys: Record<string, string>
  }
}

export type RescueOutcome =
  | { kind: 'downloaded'; filename: string }
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

const NOTE =
  'Raw copy of everything SpendTrack saved in this browser, exactly as it was stored. Values were not checked or repaired. Your sync code is not included.'

export function collectRawStorage(storage: RawStorage): Record<string, string> {
  const entries: [string, string][] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key === null || SECRET_KEY_PATTERN.test(key)) continue
    const value = storage.getItem(key)
    if (value !== null) entries.push([key, value])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  // fromEntries defines own properties, so even a key named "__proto__" survives.
  return Object.fromEntries(entries)
}

export function buildRescueFile(raw: Record<string, string>, now: Date): RescueFile {
  return {
    // Local time: the date the user sees on their clock, not the UTC date.
    filename: `spendtrack-backup-raw-${format(now, 'yyyy-MM-dd-HHmm')}.json`,
    payload: {
      app: 'SpendTrack',
      kind: 'raw-browser-backup',
      version: 1,
      exportedAt: now.toISOString(),
      note: NOTE,
      keys: raw,
    },
  }
}

export interface RescueDeps {
  getStorage?: () => RawStorage
  now?: () => Date
  save?: (filename: string, data: unknown) => void
}

export function downloadRescueFile(deps: RescueDeps = {}): RescueOutcome {
  const {
    getStorage = () => window.localStorage,
    now = () => new Date(),
    save = downloadJSON,
  } = deps

  let raw: Record<string, string>
  try {
    raw = collectRawStorage(getStorage())
  } catch {
    return { kind: 'unavailable' }
  }
  if (Object.keys(raw).length === 0) return { kind: 'empty' }

  const file = buildRescueFile(raw, now())
  try {
    save(file.filename, file.payload)
  } catch {
    return { kind: 'failed' }
  }
  return { kind: 'downloaded', filename: file.filename }
}
