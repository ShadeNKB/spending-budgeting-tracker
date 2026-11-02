// Backup files into the doc (DATA-ENGINE-SPEC §7.7, track spec §8.10): what previewImport accepts
// (a v5 file, a v4 BackupData, or a raw browser export from lib/rescue) decoded as a 'file', and
// the record list a mass-removal Undo revives. Every shape goes through decodeWire: bad rows are
// counted as unreadable, never thrown.
import { EMPTY_DOC } from '../core/doc'
import { isPlainObject, own } from '../core/sanitize'
import type { ExpenseRec, SanitizeReport, SanitizeResult } from '../core/types'
import { decodeWire, fromV4Keys } from '../core/wire'
import { envelopeBody } from './envelope'
import { parseJson } from './json'
import { DB_KEY } from './keys'
import { readV4 } from './migrate'

const EMPTY_REPORT: SanitizeReport = {
  quarantined: [],
  repaired: 0,
  repairs: [],
  deduped: 0,
  liveAndDeleted: 0,
  droppedKeys: [],
}

/** A file of records to revive (the mass-removal Undo): an import restore of exactly these. */
export const recordsFile = (recs: readonly ExpenseRec[]): SanitizeResult => ({
  doc: { ...EMPTY_DOC, expenses: new Map(recs.map((r) => [r.id, r])) },
  writer: 'v5',
  report: EMPTY_REPORT,
  legacyTs: new Map(),
  rev: null,
})

/** A raw export (`lib/rescue`): its envelope if it has one, else its v4 keys. */
function decodeRawExport(keys: Readonly<Record<string, unknown>>, at: number): SanitizeResult {
  const env = own(keys, DB_KEY)
  if (typeof env === 'string') {
    const parts = envelopeBody(env)
    const body = parts === null ? null : parseJson(parts.body)
    const doc = body !== null && isPlainObject(body.value) ? own(body.value, 'doc') : undefined
    if (doc !== undefined) return decodeWire(doc, 'file', { at })
  }
  const text = (k: string): string | null => {
    const v = own(keys, k)
    return typeof v === 'string' ? v : null
  }
  return decodeWire(fromV4Keys(readV4(text).parsed), 'file', { at })
}

/** A backup file in any accepted shape (§7.7): v5 file, v4 BackupData or a raw export. */
export function decodeFile(value: unknown, at: number): SanitizeResult {
  if (
    isPlainObject(value) &&
    own(value, 'app') === 'SpendTrack' &&
    own(value, 'kind') === 'raw-browser-backup'
  ) {
    const keys = own(value, 'keys')
    if (isPlainObject(keys)) return decodeRawExport(keys, at)
  }
  return decodeWire(value, 'file', { at })
}

/** The text of a picked file (FileReader where Blob.text is missing, as on older WebKit). */
export async function blobText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '')
    }
    reader.onerror = () => {
      reject(new Error("This file couldn't be read."))
    }
    reader.readAsText(file)
  })
}
