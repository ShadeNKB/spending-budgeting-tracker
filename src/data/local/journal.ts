// The journal (DATA-ENGINE-SPEC §9.8, track spec §8.7, P2-21): what a sync merge changed here, so
// nothing a remote copy replaced or removed is ever unrecoverable. Device-local, never synced.
// Classified inside applyRemote only (cross-tab merges are this device's own actions). PR-2 writes
// it; the lists arrive with PR-4.
import { JOURNAL_BYTES } from '../core/constants'
import { EMPTY_DOC } from '../core/doc'
import { newRev } from '../core/ids'
import { encodeRecord, maxStampRec } from '../core/record'
import { isPlainObject, own } from '../core/sanitize'
import type { ExpenseRec, MergeResult, OutboxKey, Stamp, WireRecord } from '../core/types'
import { wireString } from '../core/wire'
import { listOf, storedList } from './json'
import type { Io, WriteResult } from './io'
import { JOURNAL_KEY } from './keys'

export type JournalKind = 'conflict' | 'replaced' | 'removed' | 'edit-after-delete' | 'mass'

export interface JournalEntry {
  readonly id: string
  readonly at: number
  readonly seen: boolean
  readonly kind: JournalKind
  /** The record id the entry is about (dedupe key with kind and the after stamp). */
  readonly rec?: string
  readonly stamp?: Stamp
  readonly before?: WireRecord
  readonly after?: WireRecord
  readonly count?: number
  readonly ids?: readonly string[]
  readonly snapshotId?: string
  /**
   * A mass removal whose snapshot could not be stored keeps the removed records here instead, as
   * a snapshot body (a wire doc of just those records), so it stays restorable (P2-20).
   */
  readonly body?: string
}

const KINDS: ReadonlySet<string> = new Set([
  'conflict',
  'replaced',
  'removed',
  'edit-after-delete',
  'mass',
])

const isKind = (v: unknown): v is JournalKind => typeof v === 'string' && KINDS.has(v)

export const isPinned = (e: JournalEntry): boolean => e.kind === 'conflict' || e.kind === 'mass'

const dedupeKey = (e: JournalEntry): string => `${e.kind}|${e.rec ?? e.id}|${String(e.stamp ?? 0)}`

function parse(text: string | null): JournalEntry[] {
  const out: JournalEntry[] = []
  for (const e of storedList(text)) {
    if (!isPlainObject(e)) continue
    const id = own(e, 'id')
    const at = own(e, 'at')
    const kind = own(e, 'kind')
    if (typeof id !== 'string' || typeof at !== 'number' || !isKind(kind)) continue
    const before = own(e, 'before')
    const after = own(e, 'after')
    const ids = own(e, 'ids')
    const rec = own(e, 'rec')
    const stamp = own(e, 'stamp')
    const count = own(e, 'count')
    const snapshotId = own(e, 'snapshotId')
    const body = own(e, 'body')
    out.push({
      id,
      at,
      seen: own(e, 'seen') === true,
      kind,
      ...(typeof rec === 'string' ? { rec } : {}),
      ...(typeof stamp === 'number' ? { stamp } : {}),
      ...(isPlainObject(before) ? { before } : {}),
      ...(isPlainObject(after) ? { after } : {}),
      ...(typeof count === 'number' ? { count } : {}),
      ...(Array.isArray(ids)
        ? { ids: listOf(ids).filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(typeof snapshotId === 'string' ? { snapshotId } : {}),
      ...(typeof body === 'string' ? { body } : {}),
    })
  }
  return out
}

/** FIFO within JOURNAL_BYTES for quiet entries; a pinned entry stays until it is seen. */
function bound(list: readonly JournalEntry[]): JournalEntry[] {
  let size = JSON.stringify(list).length
  const out = [...list]
  while (size > JOURNAL_BYTES) {
    const i = out.findIndex((e) => !isPinned(e) || e.seen)
    if (i < 0) break
    const [gone] = out.splice(i, 1)
    size -= gone === undefined ? 0 : JSON.stringify(gone).length + 1
  }
  return out
}

export interface MassNote {
  readonly ids: readonly string[]
  readonly snapshotId: string | null
  /** The removed records, kept in the entry when no snapshot holds them (empty otherwise). */
  readonly records: readonly ExpenseRec[]
}

/** The journal entries of one remote merge (§9.8 table). */
export function classify(
  m: MergeResult,
  outbox: ReadonlyMap<OutboxKey, Stamp>,
  at: number,
  rng: () => number,
  mass: MassNote | null,
): JournalEntry[] {
  const out: JournalEntry[] = []
  const pending = (id: string): boolean => outbox.has(`ex:${id}`)
  const base = (kind: JournalKind, rec: ExpenseRec): JournalEntry => ({
    id: newRev(rng),
    at,
    seen: false,
    kind,
    rec: rec.id,
    stamp: maxStampRec(rec),
  })
  for (const r of m.replaced) {
    const oldWroteOverV5 = r.fields.some((f) => r.after[f].r <= 1 && r.before[f].r === 2)
    const kind = pending(r.before.id) || oldWroteOverV5 ? 'conflict' : 'replaced'
    out.push({
      ...base(kind, r.after),
      before: encodeRecord(r.before),
      after: encodeRecord(r.after),
    })
  }
  const quiet = mass === null ? m.removed : m.removed.filter((rec) => pending(rec.id))
  for (const rec of quiet) {
    out.push({ ...base(pending(rec.id) ? 'conflict' : 'removed', rec), before: encodeRecord(rec) })
  }
  if (mass !== null) {
    out.push({
      id: newRev(rng),
      at,
      seen: false,
      kind: 'mass',
      count: mass.ids.length,
      ids: mass.ids,
      ...(mass.snapshotId === null ? {} : { snapshotId: mass.snapshotId }),
      ...(mass.records.length === 0
        ? {}
        : {
            body: wireString({
              ...EMPTY_DOC,
              expenses: new Map(mass.records.map((x) => [x.id, x])),
            }),
          }),
    })
  }
  for (const rec of m.editAfterDelete) {
    out.push({ ...base('edit-after-delete', rec), after: encodeRecord(rec) })
  }
  return out
}

export class Journal {
  constructor(
    private readonly io: Io,
    private readonly writeShed: (key: string, value: string) => WriteResult,
  ) {}

  read(): JournalEntry[] {
    return parse(this.io.get(JOURNAL_KEY))
  }

  find(id: string): JournalEntry | undefined {
    return this.read().find((e) => e.id === id)
  }

  /** Read-merge-write with dedupe on (kind, id, after max-stamp). */
  append(entries: readonly JournalEntry[]): boolean {
    if (entries.length === 0) return true
    const list = this.read()
    const keys = new Set(list.map(dedupeKey))
    for (const e of entries) {
      const k = dedupeKey(e)
      if (e.kind !== 'mass' && keys.has(k)) continue
      keys.add(k)
      list.push(e)
    }
    return this.writeShed(JOURNAL_KEY, JSON.stringify(bound(list))) === 'ok'
  }

  markSeen(id: string): void {
    const list = this.read()
    if (!list.some((e) => e.id === id && !e.seen)) return
    this.writeShed(
      JOURNAL_KEY,
      JSON.stringify(list.map((e) => (e.id === id ? { ...e, seen: true } : e))),
    )
  }

  /** §9.11 shedding step 2: drops every seen or unpinned entry. */
  shedQuiet(): boolean {
    const list = this.read()
    const kept = list.filter((e) => isPinned(e) && !e.seen)
    if (kept.length === list.length) return false
    return this.io.write(JOURNAL_KEY, JSON.stringify(kept)) === 'ok'
  }
}
