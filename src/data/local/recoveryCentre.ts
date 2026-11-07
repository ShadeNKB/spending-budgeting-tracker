// The Recovery centre's data side (DATA-ENGINE-SPEC §15.5, §9.7, §9.8, §8.3; PR-4 track spec §3.1):
// the snapshots, the journal and the needs-attention list, and what each can bring back. Its own
// lazy chunk, loaded by engine.recovery() when Settings › Backup opens: nothing here is on the
// boot path. Every restore is a core op committed through the engine, a dated forward write that
// syncs and never deletes; the lists' own bookkeeping (seen marks, Fix, Discard) goes through the
// engine's shedding writer. Memory-only, or once this device was wiped, nothing is written.
import { displayList, resolver } from '../core/categories'
import { NOTES_INPUT_MAX, nullRecord } from '../core/constants'
import { dayOf, isDateText, localDay, validDay } from '../core/dates'
import { EMPTY_DOC } from '../core/doc'
import { canon, fnv36 } from '../core/hash'
import { newRev, reviveId } from '../core/ids'
// Named, not `* as ops`: across chunks a namespace import costs the engine chunk its whole object.
import { applyImport, planImport, updateExpense } from '../core/ops'
import { cleanAmount, isPlainObject, own, validItemName } from '../core/sanitize'
import type {
  Doc,
  ExpensePatch,
  ExpenseRec,
  OpCtx,
  OpResult,
  Origin,
  QEntry,
  SanitizeResult,
  WireRecord,
} from '../core/types'
import { decodeWire, encodeBackupFile, wireString } from '../core/wire'
import type { Runtime } from './engine'
import { recordsFile } from './files'
import type { WriteResult } from './io'
import { isPinned, type JournalEntry } from './journal'
import { parseJson, storedList } from './json'
import { DB_KEY, JOURNAL_KEY, QUARANTINE_KEY, QUARANTINE_RAW_PREFIX, SNAPS_KEY } from './keys'
import { isSecretCopy, needsAttention } from './quarantine'
import { decodeSnapshot } from './recovery'
import type { SnapMeta } from './snapshots'
import type {
  AttentionItem,
  ChangeItem,
  ImportPreview,
  RecordSummary,
  RecoveryApi,
  RestoreResult,
  SnapshotSkips,
} from './types'

/**
 * What the engine lends the Recovery centre: its own functions, each given the runtime of the
 * call (`rt()`, read on every call and never kept across a re-boot). Plain references, so the
 * boot chunk carries no wrappers for them.
 */
export interface RecoveryHost {
  /** The current runtime (throws while loading). */
  readonly rt: () => Runtime
  /** Commits a core op; its undo entry goes on the stack under `undoId` for `ttl` ms. */
  readonly run: (
    r: Runtime,
    op: (doc: Doc, ctx: OpCtx) => OpResult,
    undoId: (res: OpResult) => string,
    ttl: number,
  ) => OpResult
  /** The Undo lifetime of a bulk change (30 s, P2-12). */
  readonly undoTtl: number
  /** An import preview of `dec`, applied later by applyImport (the path previewImport takes). */
  readonly preview: (r: Runtime, dec: SanitizeResult, fileName: string) => ImportPreview
  /**
   * The engine's shedding writer, at `level`. It does not refuse by itself: every write here
   * goes through `write` below, which refuses in memory only and once this device was wiped.
   */
  readonly writeShed: (r: Runtime, key: string, value: string, maxLevel: number) => WriteResult
  /** The shedding level of derived copies (st5:q, st5:journal, st5:snaps). */
  readonly level: number
  readonly publish: (r: Runtime) => void
  /** Sets how many needs-attention items the owner has seen (persisted, published). */
  readonly seen: (r: Runtime, n: number) => void
  readonly omit: () => ((id: string) => boolean) | undefined
  readonly rng: () => number
}

const UNREADABLE = "This copy can't be read any more."
const DOWNLOAD_ONLY =
  'This copy can only be downloaded: it no longer says which entries that removal took.'
const NOT_SAVING =
  "This device isn't saving, so nothing can be restored here. Download your data first."

/** A Fix's mark on a needs-attention row: the existing rule then lists it no more. */
const FIXED = 'repaired:fixed:'

/** The quarantine name of a relay copy kept whole (engine.ts RELAY_COPY_KEY). */
const RELAY_COPY = 'relay'

/** The fields a change can put back; extras ride along and are never restored on their own. */
const RESTORABLE = ['n', 'a', 'c', 'd', 'o'] as const

const ORIGINS: ReadonlySet<string> = new Set([
  'local-envelope',
  'local-v4',
  'remote',
  'file',
  'snapshot',
])
const isOrigin = (v: unknown): v is Origin => typeof v === 'string' && ORIGINS.has(v)

const canWrite = (r: Runtime): boolean => !r.memoryOnly && !r.wiped && r.io !== null

/** A stored quarantine element as a QEntry, or null for anything else (kept as it is). */
function qEntryOf(e: unknown): QEntry | null {
  if (!isPlainObject(e)) return null
  const at = own(e, 'at')
  const origin = own(e, 'origin')
  const reason = own(e, 'reason')
  const raw = own(e, 'raw')
  return typeof at === 'number' &&
    isOrigin(origin) &&
    typeof reason === 'string' &&
    typeof raw === 'string'
    ? { at, origin, reason, raw }
    : null
}

const entryId = (q: QEntry): string => `${q.origin}|${fnv36(q.raw)}`

/**
 * One journaled wire record back into a record: the codec snapshots use, on a v5 wire doc of just
 * it. (Its header comes from wireString, which the engine chunk holds already: encodeWire would
 * add its own code to the boot path.)
 */
function decodeOne(w: WireRecord | undefined): ExpenseRec | null {
  const header = parseJson(wireString(EMPTY_DOC))?.value
  if (w === undefined || !isPlainObject(header)) return null
  const dec = decodeWire({ ...header, expenses: [w] }, 'snapshot', { at: Date.now() })
  return dec.doc.expenses.values().next().value ?? null
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** The calendar day of a stored record: its own day, else the local day of its date. */
function dayText(day: unknown, date: unknown): string | null {
  if (validDay(day)) return day
  return typeof date === 'string' && isDateText(date) ? localDay(date) : null
}

function summaryOf(w: WireRecord | undefined, res: (n: string) => string): RecordSummary | null {
  if (w === undefined) return null
  const amount = own(w, 'amount')
  const category = text(own(w, 'category'))
  const notes = text(own(w, 'notes'))
  return {
    itemName: text(own(w, 'itemName')) ?? '',
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    day: dayText(own(w, 'day'), own(w, 'date')),
    category: category === null ? null : res(category),
    notes: notes === null || notes.trim() === '' ? null : notes,
  }
}

/** What a Fix can prefill from an unreadable row's raw JSON (every field checked on its own). */
function salvageOf(raw: string, doc: Doc): AttentionItem['salvage'] {
  const o = parseJson(raw)?.value
  if (!isPlainObject(o)) return null
  const name = own(o, 'itemName')
  const amount = cleanAmount(own(o, 'amount'))
  if (!validItemName(name) && amount === null) return null
  const day = dayText(own(o, 'day'), own(o, 'date'))
  const category = text(own(o, 'category'))
  const listed = category === null ? null : resolver(doc.renames)(category)
  const notes = text(own(o, 'notes'))?.trim().slice(0, NOTES_INPUT_MAX) ?? ''
  return {
    ...(validItemName(name) ? { itemName: name.trim() } : {}),
    ...(amount === null ? {} : { amount: amount.value }),
    ...(day === null ? {} : { day }),
    ...(listed !== null && displayList(doc).includes(listed) ? { category: listed } : {}),
    ...(notes === '' ? {} : { notes }),
  }
}

/** A whole stored copy kept as found: `st5:q:<key>:<ts>`. */
function copyItem(key: string): AttentionItem {
  const rest = key.slice(QUARANTINE_RAW_PREFIX.length)
  const colon = rest.lastIndexOf(':')
  const of = rest.slice(0, colon)
  const at = Number(rest.slice(colon + 1))
  return {
    id: key,
    at: Number.isFinite(at) ? at : 0,
    origin: of === DB_KEY ? 'local-envelope' : of === RELAY_COPY ? 'remote' : 'local-v4',
    reason: 'copy',
    kind: 'copy',
    salvage: null,
  }
}

const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b)

/** The mark of a revive id (`<root>~r<hash>`, core/ids.ts reviveId). */
const REVIVED = '~r'

/** The records a restore may bring back, and what it leaves alone (counted). */
interface Sorted extends SnapshotSkips {
  readonly keep: readonly ExpenseRec[]
}

/**
 * Sorts out what a restore of `recs` must leave alone, against `doc` as it is now. §4.3 revive ids
 * are deterministic, so a deleted record restored before (here, or on the other device) sits
 * under its first revive id: live there, it is back already, maybe edited since (the import plan
 * would revive it again under `.2`, a second copy); deleted there, it was deleted again since and
 * stays deleted (the plan would bring it back under `.2`). Everything else is planned as usual
 * (a record live under its own id counts as already here).
 */
function sortOut(doc: Doc, recs: Iterable<ExpenseRec>): Sorted {
  // nothing was ever revived here (no `~r` id, live or deleted): nothing to sort out
  const revived = (ids: Iterable<string>): boolean => {
    for (const id of ids) if (id.includes(REVIVED)) return true
    return false
  }
  if (!revived(doc.expenses.keys()) && !revived(doc.tombs.keys()))
    return { keep: [...recs], back: 0, deletedSince: 0 }
  const res = resolver(doc.renames)
  const keep: ExpenseRec[] = []
  let back = 0
  let deletedSince = 0
  for (const rec of recs) {
    // a revived record's own id is its first candidate (the root drops the suffix): skip it
    const first = doc.tombs.has(rec.id) ? reviveId(rec, res(rec.c.v), (id) => id === rec.id) : null
    if (first !== null && doc.expenses.has(first)) back++
    else if (first !== null && doc.tombs.has(first)) deletedSince++
    else keep.push(rec)
  }
  return { keep, back, deletedSince }
}

/** The ids a removal's snapshot holds back to (index first, else its journal entry), or null. */
function idsOf(meta: SnapMeta, journal: readonly JournalEntry[]): ReadonlySet<string> | null {
  const stored = meta.ids?.filter((x): x is string => typeof x === 'string')
  const ids =
    stored ?? journal.find((x) => x.kind === 'mass' && x.snapshotId === meta.id)?.ids ?? null
  return ids === null ? null : new Set(ids)
}

export function createRecovery(host: RecoveryHost): RecoveryApi {
  const rt = host.rt

  const writable = (): Runtime => {
    const r = rt()
    if (!canWrite(r)) throw new Error(NOT_SAVING)
    return r
  }

  /** A derived copy through the shedding writer; refused in memory only or once wiped. */
  const write = (r: Runtime, key: string, value: string): WriteResult =>
    canWrite(r) ? host.writeShed(r, key, value, host.level) : 'error'

  /** Snapshot previews and the decoded copy each plans from, for snapshotSkips. */
  const held = new WeakMap<ImportPreview, Doc>()

  const none = (why: NonNullable<RestoreResult['why']>, skipped = 1): RestoreResult => ({
    applied: 0,
    skipped,
    undoId: null,
    why,
  })

  /** Commits `op` with a 30 s Undo; the result says what happened. */
  function apply(op: (doc: Doc, ctx: OpCtx) => OpResult, applied: number): RestoreResult {
    const undoId = `rec-${newRev(host.rng)}`
    const res = host.run(rt(), op, () => undoId, host.undoTtl)
    if (res.undo === undefined) return none('already', applied)
    return { applied, skipped: 0, undoId, why: null }
  }

  /**
   * An import restore of `recs`: revived under their revive ids where deleted, never a delete.
   * What was restored before is left alone: back already (maybe edited since), or deleted again
   * since, which stays deleted (sortOut).
   */
  function revive(recs: readonly ExpenseRec[]): RestoreResult {
    const r = rt()
    const { keep, deletedSince } = sortOut(r.doc, recs)
    const plan = planImport(r.doc, recordsFile(keep))
    const n = plan.counts.restored + plan.counts.added
    if (n === 0) {
      const why =
        keep.length > 0 && plan.counts.unreadable === keep.length
          ? 'gone'
          : deletedSince > 0
            ? 'deleted-since'
            : 'already'
      return none(why, recs.length)
    }
    const res = apply((doc, ctx) => applyImport(doc, ctx, plan, 'restore'), n)
    return res.why === null ? { ...res, skipped: recs.length - n } : res
  }

  /** The record a removal took, or an edit made after the delete here: back under its revive id. */
  function reviveOne(w: WireRecord | undefined): RestoreResult {
    const rec = decodeOne(w)
    return rec === null ? none('gone') : revive([rec])
  }

  /**
   * A remote edit over this device's values: each field it changed goes back, but only while the
   * entry still holds what that edit wrote. A later edit or delete anywhere wins.
   */
  function putBack(e: JournalEntry): RestoreResult {
    const before = decodeOne(e.before)
    const after = decodeOne(e.after)
    if (before === null || after === null) return none('gone')
    const r = rt()
    const cur = r.doc.expenses.get(after.id)
    if (cur === undefined) return none('deleted-since')
    const res = resolver(r.doc.renames)
    const patch: { -readonly [K in keyof ExpensePatch]: ExpensePatch[K] } = {}
    let moved = false
    for (const f of RESTORABLE) {
      if (same(before[f].v, after[f].v)) continue
      if (cur[f].s !== after[f].s || !same(cur[f].v, after[f].v)) {
        if (!same(cur[f].v, before[f].v)) moved = true
        continue
      }
      if (f === 'n') patch.itemName = before.n.v
      else if (f === 'a') patch.amount = before.a.v
      else if (f === 'c') patch.category = res(before.c.v)
      else if (f === 'd') patch.day = dayOf(before)
      else patch.notes = before.o.v ?? ''
    }
    if (Object.keys(patch).length === 0) return none(moved ? 'changed-since' : 'already')
    return apply((doc, ctx) => updateExpense(doc, ctx, cur.id, patch), 1)
  }

  /**
   * A remote mass removal (P2-20): what it took, from this session's cache (its Undo toast, which
   * works in memory only too), else its snapshot, else the records its entry kept.
   */
  async function restoreMass(id: string, e: JournalEntry | undefined): Promise<RestoreResult> {
    let recs = rt().massCache.get(id) ?? null
    if (recs === null && e?.ids !== undefined) {
      writable()
      const snapId = e.snapshotId
      const body = e.body ?? (snapId === undefined ? null : await rt().snaps?.body(snapId))
      if (body !== null && body !== undefined) {
        const snapDoc = decodeSnapshot(body, Date.now())
        recs = e.ids.flatMap((x) => {
          const rec = snapDoc.expenses.get(x)
          return rec === undefined ? [] : [rec]
        })
      }
    }
    if (recs === null || recs.length === 0) return none('gone', e?.count ?? 0)
    const res = revive(recs)
    rt().massCache.delete(id)
    return res
  }

  /**
   * The snapshot's doc, kept to exactly what the removal it was taken for took (precision rule):
   * from the ids in the snapshot index, else in its journal entry. A Delete all took every live
   * entry its copy holds. A removal's copy that says neither is null: Download only.
   */
  function precise(r: Runtime, meta: SnapMeta, doc: Doc): Doc | null {
    if (meta.reason !== 'delete-all' && meta.reason !== 'mass') return doc
    const keep = idsOf(meta, r.journal?.read() ?? [])
    if (keep === null) return meta.reason === 'mass' ? null : doc
    return { ...doc, expenses: new Map([...doc.expenses].filter(([id]) => keep.has(id))) }
  }

  /**
   * Before a removal's journal entry is marked seen (and so may be evicted), the ids it took go
   * into its snapshot's index entry, which the precision rule then reads. False when they could
   * not be kept: the entry then stays unseen, so it stays.
   */
  function keepIds(r: Runtime, e: JournalEntry): boolean {
    if (e.kind !== 'mass' || e.snapshotId === undefined || e.ids === undefined) return true
    const list = storedList(r.io?.get(SNAPS_KEY) ?? null)
    const at = list.findIndex((x) => isPlainObject(x) && own(x, 'id') === e.snapshotId)
    const meta = list[at]
    // no such snapshot any more (nothing to keep), or its ids are kept already
    if (!isPlainObject(meta) || Array.isArray(own(meta, 'ids'))) return true
    const next = list.map((x, i) => (i === at ? { ...meta, ids: e.ids } : x))
    return write(r, SNAPS_KEY, JSON.stringify(next)) === 'ok'
  }

  /** A preview of the snapshot's records that plans against the doc as it is whenever it is read. */
  function snapshotPreview(meta: SnapMeta, doc: Doc): ImportPreview {
    const r = rt()
    // renames as this device has them: the revive ids sortOut checks are the ones applied.
    // Docs are replaced, never changed: one sort per doc (the plan reads `doc` many times).
    let memo: { readonly cur: Doc; readonly out: Doc } | null = null
    const now = (): Doc => {
      const cur = rt().doc
      if (memo?.cur !== cur) {
        const kept = sortOut(cur, doc.expenses.values()).keep
        memo = {
          cur,
          out: { ...doc, renames: cur.renames, expenses: new Map(kept.map((x) => [x.id, x])) },
        }
      }
      return memo.out
    }
    // engine.applyImport plans again at Restore from this same object: its `doc` is read then,
    // so a restore or a delete made since the preview is sorted out too
    const dec: SanitizeResult = {
      ...recordsFile([]),
      get doc() {
        return now()
      },
    }
    const preview = host.preview(r, dec, `snapshot-${meta.id}`)
    held.set(preview, doc)
    return preview
  }

  /** The snapshot's decoded doc, or null when it is gone or no longer reads. */
  async function snapshotDoc(id: string): Promise<{ meta: SnapMeta; doc: Doc } | null> {
    const meta = rt()
      .snaps?.index()
      .find((s) => s.id === id)
    if (meta === undefined) return null
    const body = await rt().snaps?.body(id)
    if (body === null || body === undefined) return null
    const doc = decodeSnapshot(body, Date.now())
    // decodeSnapshot answers EMPTY_DOC for a body that is not JSON; a copy of rows that yields
    // none no longer reads either
    return doc === EMPTY_DOC || (doc.expenses.size === 0 && meta.rows > 0) ? null : { meta, doc }
  }

  function qList(r: Runtime): readonly unknown[] {
    return storedList(r.io?.get(QUARANTINE_KEY) ?? null)
  }

  /** After a Fix or a Discard: the count drops, and so does what was seen, so a new row still toasts. */
  function quarantineChanged(r: Runtime): void {
    r.q?.load()
    host.seen(r, Math.min(r.meta.attentionSeen, r.q?.count() ?? 0))
    host.publish(r)
  }

  /**
   * Rewrites st5:q with the first element whose id is `id` and that `pick` takes mapped (or
   * dropped, for null). Only that one: an identical row kept twice stays once.
   */
  function rewriteQ(
    id: string,
    map: (e: QEntry) => QEntry | null,
    pick: (e: QEntry) => boolean = needsAttention,
  ): void {
    const r = writable()
    let hit = false
    const next: unknown[] = []
    for (const x of qList(r)) {
      const q = hit ? null : qEntryOf(x)
      if (q === null || !pick(q) || entryId(q) !== id) {
        next.push(x)
        continue
      }
      hit = true
      const m = map(q)
      if (m !== null) next.push(m)
    }
    if (!hit) return
    if (write(r, QUARANTINE_KEY, JSON.stringify(next)) !== 'ok') {
      throw new Error("Couldn't change this on the device. Nothing was changed.")
    }
    quarantineChanged(r)
  }

  const api: RecoveryApi = {
    summary() {
      return {
        snapshots: rt().snaps?.index().length ?? 0,
        newChanges: api.changes().filter((c) => c.pinned && !c.seen).length,
        canWrite: canWrite(rt()),
      }
    },

    snapshots() {
      const r = rt()
      const journal = r.journal?.read() ?? []
      // the same millisecond (a migration, then a Delete all at once): the later one has the
      // larger id (snapshots.ts takes the next free one)
      return [...(r.snaps?.index() ?? [])]
        .sort((a, b) => b.at - a.at || Number(b.id) - Number(a.id))
        .map((m) => ({
          id: m.id,
          at: m.at,
          reason: m.reason,
          rows: m.rows,
          restorable: m.reason !== 'mass' || idsOf(m, journal) !== null,
        }))
    },

    async previewSnapshot(id) {
      const got = await snapshotDoc(id)
      if (got === null) throw new Error(UNREADABLE)
      const doc = precise(rt(), got.meta, got.doc)
      if (doc === null) throw new Error(DOWNLOAD_ONLY)
      return snapshotPreview(got.meta, doc)
    },

    snapshotSkips(preview) {
      const doc = held.get(preview)
      if (doc === undefined) return { back: 0, deletedSince: 0 }
      const { back, deletedSince } = sortOut(rt().doc, doc.expenses.values())
      return { back, deletedSince }
    },

    async snapshotFile(id) {
      const got = await snapshotDoc(id)
      return got === null ? null : encodeBackupFile(got.doc, { omitIds: host.omit() })
    },

    changes() {
      const r = rt()
      const reasons = new Map((r.snaps?.index() ?? []).map((s) => [s.id, s.reason]))
      const res = resolver(r.doc.renames)
      const shown = (e: JournalEntry): boolean => {
        if (e.kind !== 'mass') return true
        const reason = e.snapshotId === undefined ? undefined : reasons.get(e.snapshotId)
        // this device's own Delete all is listed under Snapshots; a removal with nothing left to
        // restore from is not offered
        if (reason === 'delete-all') return false
        return reason !== undefined || e.body !== undefined || r.massCache.has(e.id)
      }
      const rank = (c: ChangeItem): number => (c.pinned && !c.seen ? 1 : 0)
      return (r.journal?.read() ?? [])
        .filter(shown)
        .map(
          (e): ChangeItem => ({
            id: e.id,
            at: e.at,
            seen: e.seen,
            pinned: isPinned(e),
            kind: e.kind,
            before: summaryOf(e.before, res),
            after: summaryOf(e.after, res),
            count: e.kind === 'mass' ? (e.count ?? e.ids?.length ?? 0) : 1,
          }),
        )
        .sort((a, b) => rank(b) - rank(a) || b.at - a.at)
    },

    async restoreChange(id) {
      const e = rt().journal?.find(id)
      let res: RestoreResult
      if (e === undefined || e.kind === 'mass') res = await restoreMass(id, e)
      else {
        writable()
        if (e.kind === 'edit-after-delete') res = reviveOne(e.after)
        else if (e.kind === 'removed' || e.after === undefined) res = reviveOne(e.before)
        else res = putBack(e)
      }
      // the journal's own writer writes nothing in memory only or once this device was wiped;
      // a removal's ids go to its snapshot first, or the entry stays unseen (and kept)
      const r = rt()
      if (e === undefined || keepIds(r, e)) r.journal?.markSeen(id)
      host.publish(r)
      return res
    },

    markAllSeen() {
      const r = rt()
      const list = r.journal?.read() ?? []
      if (!canWrite(r) || list.every((e) => e.seen)) return
      const next = list.map((e) => (e.seen || !keepIds(r, e) ? e : { ...e, seen: true }))
      write(r, JOURNAL_KEY, JSON.stringify(next))
      host.publish(r)
    },

    attention() {
      const r = rt()
      const out: AttentionItem[] = []
      for (const x of qList(r)) {
        const q = qEntryOf(x)
        if (q === null || !needsAttention(q)) continue
        out.push({
          id: entryId(q),
          at: q.at,
          origin: q.origin,
          reason: q.reason,
          kind: 'entry',
          salvage: salvageOf(q.raw, r.doc),
        })
      }
      for (const key of r.io?.keysWithPrefix(QUARANTINE_RAW_PREFIX) ?? []) {
        if (!isSecretCopy(key)) out.push(copyItem(key))
      }
      return out.sort((a, b) => b.at - a.at)
    },

    attentionFile(id) {
      const r = rt()
      const rawKeys = nullRecord<string>()
      const entries: QEntry[] = []
      if (id.startsWith(QUARANTINE_RAW_PREFIX)) {
        const value = isSecretCopy(id) ? null : (r.io?.get(id) ?? null)
        if (value === null) return null
        rawKeys[id] = value
      } else {
        const q = qList(r)
          .map(qEntryOf)
          .find((x) => x !== null && needsAttention(x) && entryId(x) === id)
        if (q === undefined || q === null) return null
        entries.push(q)
      }
      return {
        app: 'SpendTrack',
        kind: 'needs-attention',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: "Entries SpendTrack couldn't read, kept exactly as they were found.",
        entries,
        rawKeys,
      }
    },

    markFixed(id) {
      // the raw stays in st5:q (and in the raw download); a repaired: reason is never listed again
      rewriteQ(id, (q) => ({ ...q, reason: `${FIXED}${q.reason}` }))
    },

    unmarkFixed(id) {
      rewriteQ(
        id,
        (q) => ({ ...q, reason: q.reason.slice(FIXED.length) }),
        (q) => q.reason.startsWith(FIXED),
      )
    },

    discard(id) {
      if (!id.startsWith(QUARANTINE_RAW_PREFIX)) {
        rewriteQ(id, () => null)
        return
      }
      const r = writable()
      if (isSecretCopy(id) || r.io?.get(id) === null) return
      r.io?.removeKey(id)
      quarantineChanged(r)
    },
  }
  return api
}
