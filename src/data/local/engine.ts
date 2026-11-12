// The local engine v5 (DATA-ENGINE-SPEC §9, track spec §8, P2-1): the lazy "engine" chunk behind
// useExpenseStore. One atomic, digest-checked envelope written through on a microtask; a lossless
// synchronous v4 migration; a crash-ordered v4 mirror for a rollback to 0.9.2; quarantine and a
// recovery ladder that never delete; snapshots before destructive operations; the journal;
// cross-tab read-merge-write and the old-tab fold. Every user action is a core op on the doc.
import { DEFAULT_CATEGORIES } from '../../constants'
import { importWithReload, reloadPage } from '../../lib/chunkReload'
import { isSupportedCurrency } from '../../lib/format'
import { storage } from '../../services/storage'
import { useSyncStore } from '../../stores/useSyncStore'
import type { ExpenseView } from '../../types'
import {
  DEMO_PREFIX,
  IMPORT_MAX_BYTES,
  LS_BUDGET,
  MAX_AHEAD,
  MIRROR_ORDER,
} from '../core/constants'
import { todayDay } from '../core/dates'
import { EMPTY_DOC, digestDoc, maxStampDoc, mergeDoc } from '../core/doc'
import { newRev } from '../core/ids'
import * as ops from '../core/ops'
import { ackOutbox, guardTrips } from '../core/push'
import { maxStampRec } from '../core/record'
import { observe } from '../core/stamp'
import type {
  BackupFileV5,
  Doc,
  ExpensePatch,
  ExpenseRec,
  Hlc,
  NewExpenseInput,
  OpCtx,
  OpResult,
  OutboxKey,
  QEntry,
  SanitizeReport,
  SanitizeResult,
  Stamp,
  UndoEntry,
  V4Key,
} from '../core/types'
import { encodeBackupFile, mirrorSum, toV4Mirror } from '../core/wire'
import {
  type EnvelopeMeta,
  type ParsedEnvelope,
  buildEnvelope,
  freshMeta,
  joinMeta,
  parseEnvelope,
} from './envelope'
import { Io, openArea, type WriteResult } from './io'
import { Journal, classify, type JournalEntry, type MassNote } from './journal'
import {
  APP_KEY,
  CURRENCY_PREF_KEY,
  DB_KEY,
  DEMO_KEY,
  GEN_KEY,
  V4_DATA_KEYS,
  WRITER_MARK,
  isSpendTrackKey,
  isV4DataKey,
} from './keys'
import { installLifecycle } from './lifecycle'
import { type V4Read, anyV4, decodeV4, hashV4, legacyRankOf, rankOf, readV4 } from './migrate'
import { type Touched, addTouched, diffTouched, everyKey, joinOutbox } from './outbox'
import { queryPersisted, requestPersist } from './persist'
import { Quarantine, RAW_COPIES_PER_KEY } from './quarantine'
import { decodeSeed } from './demo'
import { blobText, decodeFile } from './files'
import { parseJson } from './json'
import { decodeSnapshot, salvageEnvelope } from './recovery'
import type * as RecoveryModule from './recoveryCentre'
import { REMOTE_SAFETY_COPY_ERROR, SafetyCopyError } from './refusal'
import { smartCategory } from './smart'
import { type SnapMeta, type SnapReason, Snapshots } from './snapshots'
import * as spending from './spending'
import type {
  Attention,
  BootReport,
  CommitSource,
  Engine,
  EngineHost,
  ExpenseFields,
  ImportOutcome,
  ImportPreview,
  LocalStatus,
  RecoveryApi,
  RestoreResult,
  RemoteApplied,
  StorageFacts,
  SyncMeta,
  SyncPort,
  UndoOutcome,
  UndoToastEntry,
} from './types'
import { type Views, buildViews } from './views'

const DEMO = import.meta.env.VITE_DEMO_MODE === 'true'
const isDemoId = (id: string): boolean => id.startsWith(DEMO_PREFIX)

// Module-private: the engine chunk's dynamic import reads a namespace object (the Recovery
// centre's chunk imports from this chunk), and every export is a member of it on the boot path.
/** Retry of a failed envelope write while nothing else changes (§9.4). */
const RETRY_MS = 30_000
/** The mirror follows the envelope after this much quiet (§9.10). */
const MIRROR_IDLE = 1000
/** storage-event debounces (§9.9). */
const TAB_DEBOUNCE = 50
const V4_DEBOUNCE = 200
/** Undo lifetimes (P2-12). */
const UNDO_SHORT = 5000
const UNDO_LONG = 30_000
const UNDO_MAX = 5

/** Shedding levels (§9.11): 1 daily snapshots, 2 quiet journal, 3 old snapshots, 4 the mirror. */
const LEVEL_ALL = 4
const LEVEL_DERIVED = 3
/** A rollback copy shed under quota is written again at a boot that finds this much room. */
const MIRROR_RETRY = 0.7

/** The quarantine name of a relay copy kept whole before a repair push over it (P2-8, P2-16). */
const RELAY_COPY_KEY = 'relay'

const SAFETY_COPY_ERROR =
  "Couldn't keep a safety copy on this device. Download a backup first, then try again."

function cryptoRng(): () => number {
  const buf = new Uint32Array(1)
  return () => {
    crypto.getRandomValues(buf)
    return (buf[0] ?? 0) / 4_294_967_296
  }
}

const pristineDoc = (): Doc => ({ ...EMPTY_DOC, categories: DEFAULT_CATEGORIES })

const withDefaultCategories = (doc: Doc): Doc =>
  doc.categories.length > 0 ? doc : { ...doc, categories: DEFAULT_CATEGORIES }

/** One boot's state. Exported as a type for the Recovery centre's host (recoveryCentre.ts). */
export interface Runtime {
  readonly io: Io | null
  readonly q: Quarantine | null
  readonly snaps: Snapshots | null
  readonly journal: Journal | null
  readonly tabId: string
  readonly dev: string
  readonly clock: Hlc
  doc: Doc
  meta: EnvelopeMeta
  outbox: ReadonlyMap<OutboxKey, Stamp>
  /** Storage refused or unreadable without a safety copy: nothing is ever written (§9.6.3). */
  memoryOnly: boolean
  /** Remove-from-this-device ran: nothing may be written again before the reload. */
  wiped: boolean
  dirty: boolean
  queued: boolean
  mirrorDirty: boolean
  /** The mirror strings this runtime last wrote: storage still equal to them is not foreign. */
  mirrorWritten: Readonly<Record<V4Key, string>> | null
  lastGen: string | null
  genN: number
  localRev: number
  local: LocalStatus
  views: Views | null
  viewsDoc: Doc | null
  currency: string | null
  facts: StorageFacts | null
  attention: Attention | null
  mirrorTimer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setInterval> | null
  tabTimer: ReturnType<typeof setTimeout> | null
  v4Timer: ReturnType<typeof setTimeout> | null
  readonly undo: Map<string, UndoEntry>
  undoToasts: readonly UndoToastEntry[]
  /** Records a remote mass removal took, for its Undo this session (P2-20). */
  readonly massCache: Map<string, readonly ExpenseRec[]>
  readonly previews: WeakMap<ImportPreview, { readonly dec: SanitizeResult; used: boolean }>
  /** The envelope as booted, until its digest has been checked (after the first render). */
  bootCheck: { readonly doc: Doc; readonly digest: string; readonly raw: string } | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

/**
 * maxStampDoc without the record hashes it computes alongside (they cost most of a cold boot, and
 * the digest check after the first render computes them anyway).
 */
function maxStampOf(doc: Doc): Stamp {
  let m = 0
  for (const rec of doc.expenses.values()) m = Math.max(m, maxStampRec(rec))
  for (const s of doc.tombs.values()) m = Math.max(m, s)
  for (const g of doc.renames.values()) m = Math.max(m, g.s)
  for (const g of doc.mappings.values()) m = Math.max(m, g.s)
  for (const g of doc.budgets.values()) m = Math.max(m, g.set, g.del)
  for (const g of doc.prefs.values()) m = Math.max(m, g.s)
  return m
}

export function createEngine(host: EngineHost): Engine {
  const rng = cryptoRng()
  const listeners = new Set<(source: CommitSource) => void>()
  let rt: Runtime | null = null
  let installRequested = false
  let uninstall: (() => void) | null = null
  let removing = false

  const need = (): Runtime => {
    if (rt === null) throw new Error('SpendTrack is still loading your data.')
    return rt
  }

  const emit = (source: CommitSource): void => {
    for (const l of [...listeners]) l(source)
  }

  // ── status published to the store ─────────────────────────────────────────────────────────

  const factsOf = (r: Runtime): StorageFacts => ({
    persisted: r.meta.persisted,
    lastBackupAt: r.meta.lastBackupAt,
    mirror: r.meta.mirrorOff === null && !r.memoryOnly ? 'on' : 'off',
    nearlyFull: r.io !== null && r.io.used() >= 0.8 * LS_BUDGET,
  })

  const attentionOf = (r: Runtime): Attention => {
    const n = r.q?.count() ?? 0
    return {
      quarantined: n,
      copies: r.q?.copies() ?? 0,
      unseen: Math.max(0, n - r.meta.attentionSeen),
      full: r.q?.full() ?? false,
    }
  }

  const sameFacts = (a: StorageFacts | null, b: StorageFacts): boolean =>
    a !== null &&
    a.persisted === b.persisted &&
    a.lastBackupAt === b.lastBackupAt &&
    a.mirror === b.mirror &&
    a.nearlyFull === b.nearlyFull

  const sameAttention = (a: Attention | null, b: Attention): boolean =>
    a !== null &&
    a.quarantined === b.quarantined &&
    a.copies === b.copies &&
    a.unseen === b.unseen &&
    a.full === b.full

  /** Publishes what changed, and nothing when nothing did (no-op merges notify no one). */
  function publish(r: Runtime, extra: Partial<ExpenseFields> = {}): void {
    if (r !== rt) return
    const patch: Partial<ExpenseFields> = { ...extra }
    if (r.viewsDoc !== r.doc) {
      const v = buildViews(r.doc, r.viewsDoc, r.views, DEMO)
      const p = r.views
      if (p?.expenses !== v.expenses) patch.expenses = v.expenses
      if (p?.categories !== v.categories) patch.categories = v.categories
      if (p?.categoryMappings !== v.categoryMappings) patch.categoryMappings = v.categoryMappings
      if (p?.budgets !== v.budgets) patch.budgets = v.budgets
      if (p?.asideCategories !== v.asideCategories) patch.asideCategories = v.asideCategories
      if (p?.monthBudget !== v.monthBudget) patch.monthBudget = v.monthBudget
      if (p?.hasDemoRows !== v.hasDemoRows) patch.demo = v.hasDemoRows ? 'sample' : 'none'
      r.views = v
      r.viewsDoc = r.doc
      const synced = v.syncedCurrency
      const currency =
        synced !== null && isSupportedCurrency(synced) ? synced : host.deviceCurrency()
      if (currency !== r.currency) {
        r.currency = currency
        host.showCurrency(currency)
      }
    }
    const facts = factsOf(r)
    if (!sameFacts(r.facts, facts)) {
      r.facts = facts
      patch.facts = facts
    }
    const attention = attentionOf(r)
    if (!sameAttention(r.attention, attention)) {
      r.attention = attention
      patch.attention = attention
    }
    if (Object.keys(patch).length > 0) host.set(patch)
  }

  function setLocal(r: Runtime, local: LocalStatus): void {
    if (r.local === local && local !== 'saved') return
    r.local = local
    publish(
      r,
      local === 'saved'
        ? { local, syncStatus: 'saved', lastSavedAt: Date.now() }
        : { local, syncStatus: 'error' },
    )
  }

  // ── writing ───────────────────────────────────────────────────────────────────────────────

  function shedAt(r: Runtime, level: number): boolean {
    const now = Date.now()
    switch (level) {
      case 1:
        return r.snaps?.shedDaily(now) ?? false
      case 2:
        return r.journal?.shedQuiet() ?? false
      case 3:
        return r.snaps?.shedOldPre(now) ?? false
      default:
        return shedMirror(r)
    }
  }

  /** A write that sheds derived copies (§9.11 order) and retries while storage is full. */
  function writeShed(r: Runtime, key: string, value: string, maxLevel: number): WriteResult {
    if (r.io === null) return 'error'
    let w = r.io.write(key, value)
    let level = 1
    while (w === 'quota' && level <= maxLevel) {
      if (shedAt(r, level)) w = r.io.write(key, value)
      else level++
    }
    return w
  }

  /**
   * §9.10: the mirror is shed visibly; its stale keys would mislead a rolled-back build. Only a
   * mirror the stored envelope already holds is ever shed: never v4 keys no envelope has been
   * written over yet (a migration, a recovery) nor an old build's write not folded in yet, where
   * they are the only durable copy (§13 "storage full at migration", P2-16). `held`: the caller
   * knows the stored envelope holds the keys (a mirror write it just made, torn by quota).
   */
  function shedMirror(r: Runtime, held = false): boolean {
    if (r.meta.mirrorOff !== null || r.io === null) return false
    if (r.io.get(DB_KEY) === null || (!held && foreignV4(r))) return false
    r.meta = { ...r.meta, mirrorOff: 'quota', mirrorSum: null }
    r.mirrorWritten = null
    for (const k of V4_DATA_KEYS) r.io.removeKey(k)
    r.dirty = true
    scheduleFlush(r)
    return true
  }

  function startRetry(r: Runtime): void {
    if (r.retryTimer !== null) return
    r.retryTimer = setInterval(() => {
      if (r !== rt) {
        stopTimers(r)
        return
      }
      if (r.dirty) flush(r)
    }, RETRY_MS)
  }

  /** One setItem('st5:db') (+ st5:gen). Reads another tab's envelope first (§9.9). */
  function flush(r: Runtime, maxLevel: number = LEVEL_ALL): boolean {
    if (r.memoryOnly || r.wiped || r.io === null) return false
    if (!r.dirty) return true
    if (!absorbIfForeign(r)) return false
    const gen = `${r.tabId}:${String(r.genN + 1)}`
    r.meta = { ...r.meta, gen, hlc: r.clock.last, outbox: [...r.outbox] }
    const w = writeShed(r, DB_KEY, buildEnvelope(r.doc, r.meta), maxLevel)
    if (w !== 'ok') {
      setLocal(r, w === 'quota' ? 'error-quota' : 'error-storage')
      startRetry(r)
      return false
    }
    r.genN++
    r.io.write(GEN_KEY, gen)
    r.lastGen = gen
    r.dirty = false
    if (r.retryTimer !== null) {
      clearInterval(r.retryTimer)
      r.retryTimer = null
    }
    setLocal(r, 'saved')
    maybeDaily(r)
    return true
  }

  function scheduleFlush(r: Runtime): void {
    if (r.queued) return
    r.queued = true
    queueMicrotask(() => {
      r.queued = false
      if (r === rt) flush(r)
    })
  }

  function scheduleMirror(r: Runtime): void {
    r.mirrorDirty = true
    if (r.mirrorTimer !== null) clearTimeout(r.mirrorTimer)
    r.mirrorTimer = setTimeout(() => {
      r.mirrorTimer = null
      if (r === rt) flushMirror(r)
    }, MIRROR_IDLE)
  }

  const omit = (): ((id: string) => boolean) | undefined => (DEMO ? isDemoId : undefined)

  /** The v4 keys hold something other than the mirror the stored envelope records: an old build wrote them. */
  function foreignV4(r: Runtime): boolean {
    const io = r.io
    if (io === null) return false
    const last = r.mirrorWritten
    // the common case: storage holds what this runtime wrote, compared without hashing it
    if (last !== null && MIRROR_ORDER.every((k) => io.get(k) === last[k])) return false
    const get = (k: string): string | null => io.get(k)
    return anyV4(get) && hashV4(get) !== r.meta.mirrorSum
  }

  /**
   * The mirror write, on the idle debounce and on hide. Another v5 tab's envelope is absorbed first
   * (its mirror sum with it), and an old build's whole-array write since the last mirror is folded
   * in before it is overwritten: absence is never deletion, and nothing an old tab saved is lost.
   */
  function flushMirror(r: Runtime): void {
    if (r.mirrorTimer !== null) {
      clearTimeout(r.mirrorTimer)
      r.mirrorTimer = null
    }
    if (!r.mirrorDirty || r.memoryOnly || r.wiped || r.io === null || r.meta.mirrorOff !== null) {
      return
    }
    if (!absorbIfForeign(r)) return
    if (foreignV4(r)) fold(r, Date.now(), 'tab')
    else writeMirror(r)
  }

  /**
   * §9.10: the sum is saved in the envelope BEFORE the keys, which are written in MIRROR_ORDER
   * (tombstones before expenses), so a torn mirror is a stale subset that folds in as a no-op.
   */
  function writeMirror(r: Runtime): void {
    if (r.memoryOnly || r.wiped || r.io === null || r.meta.mirrorOff !== null) return
    const strings = toV4Mirror(r.doc, { omitIds: omit() })
    const sum = mirrorSum(strings)
    if (sum !== r.meta.mirrorSum) {
      r.meta = { ...r.meta, mirrorSum: sum }
      r.dirty = true
      if (!flush(r)) return
    }
    for (const k of MIRROR_ORDER) {
      const v = strings[k]
      if (r.io.get(k) === v) continue
      if (writeShed(r, k, v, LEVEL_DERIVED) !== 'ok') {
        // the envelope with this sum is stored: what the keys hold now is a stale subset of it
        shedMirror(r, true)
        flush(r)
        publish(r)
        return
      }
    }
    if (r.io.get(APP_KEY) !== WRITER_MARK) r.io.write(APP_KEY, WRITER_MARK)
    r.mirrorDirty = false
    r.mirrorWritten = strings
    publish(r)
  }

  function maybeDaily(r: Runtime): void {
    const day = todayDay(Date.now())
    if (r.meta.dailySnapDay === day || r.doc.expenses.size === 0 || r.snaps === null) return
    r.snaps.takeDoc(r.doc, 'daily', Date.now())
    r.meta = { ...r.meta, dailySnapDay: day }
    r.dirty = true
    scheduleFlush(r)
  }

  function takeSnapshot(r: Runtime, reason: SnapReason, doc: Doc = r.doc): SnapMeta | null {
    if (r.memoryOnly || r.wiped || r.snaps === null) return null
    return r.snaps.takeDoc(doc, reason, Date.now())
  }

  function stopTimers(r: Runtime): void {
    for (const t of [r.mirrorTimer, r.tabTimer, r.v4Timer, r.idleTimer])
      if (t !== null) clearTimeout(t)
    if (r.retryTimer !== null) clearInterval(r.retryTimer)
    r.mirrorTimer = null
    r.tabTimer = null
    r.v4Timer = null
    r.idleTimer = null
    r.retryTimer = null
    r.snaps?.stop()
  }

  // ── commits ───────────────────────────────────────────────────────────────────────────────

  const syncOn = (): boolean => storage.getSyncId() !== null

  /** Synchronous: doc, outbox, localRev, views, one queued flush, the mirror debounce. */
  function commit(r: Runtime, next: Doc, touched: Touched, source: CommitSource): void {
    const changed = next !== r.doc
    if (!changed && touched.length === 0) return
    r.doc = next
    if (touched.length > 0 && syncOn()) r.outbox = addTouched(r.outbox, touched)
    if (source !== 'remote') r.localRev++
    r.dirty = true
    if (changed) {
      publish(r)
      scheduleMirror(r)
    }
    scheduleFlush(r)
    emit(source)
  }

  const ctxOf = (r: Runtime): OpCtx => ({
    wall: Date.now(),
    clock: r.clock,
    dev: r.dev,
    rng,
    demoBuild: DEMO,
  })

  function pushUndo(r: Runtime, id: string, entry: UndoEntry, ttl: number): void {
    const now = Date.now()
    const live = r.undoToasts.filter((u) => u.expiresAt >= now && u.id !== id)
    const next = [...live, { id, label: entry.label, expiresAt: now + ttl }].slice(-UNDO_MAX)
    for (const u of r.undoToasts) if (!next.some((n) => n.id === u.id)) r.undo.delete(u.id)
    r.undo.set(id, entry)
    r.undoToasts = next
    publish(r, { undoStack: next })
  }

  function dropUndo(r: Runtime, id: string): void {
    const now = Date.now()
    const next = r.undoToasts.filter((u) => u.id !== id && u.expiresAt >= now)
    for (const u of r.undoToasts) if (!next.includes(u)) r.undo.delete(u.id)
    if (next.length !== r.undoToasts.length) {
      r.undoToasts = next
      publish(r, { undoStack: next })
    }
  }

  /** `<prefix>-<n>`, unique in the stack (today's scheme, P2-12). */
  function stampedId(r: Runtime, prefix: string): string {
    let n = Date.now()
    while (r.undo.has(`${prefix}-${String(n)}`)) n++
    return `${prefix}-${String(n)}`
  }

  /** Runs a core op and commits it; its undo entry goes on the stack under `undoId`. */
  function run(
    r: Runtime,
    op: (doc: Doc, ctx: OpCtx) => OpResult,
    undoId?: (res: OpResult) => string,
    ttl: number = UNDO_SHORT,
  ): OpResult {
    const res = op(r.doc, ctxOf(r))
    commit(r, res.doc, res.touched, 'local')
    if (res.undo !== undefined && undoId !== undefined) pushUndo(r, undoId(res), res.undo, ttl)
    return res
  }

  const revId = (prefix: string) => (): string => `${prefix}-${newRev(rng)}`

  /** An import preview the engine holds the decoded source of, until applyImport uses it. */
  function previewOf(r: Runtime, dec: SanitizeResult, fileName: string): ImportPreview {
    const plan = ops.planImport(r.doc, dec)
    const preview: ImportPreview = {
      fileName,
      counts: plan.counts,
      replaceDeletes: plan.replaceDeletes,
    }
    r.previews.set(preview, { dec, used: false })
    return preview
  }

  function setSeen(r: Runtime, n: number): void {
    if (r.meta.attentionSeen === n) return
    r.meta = { ...r.meta, attentionSeen: n }
    r.dirty = true
    flush(r)
    publish(r)
  }

  function addQuarantine(r: Runtime, entries: readonly QEntry[]): number {
    if (r.q === null || entries.length === 0 || r.memoryOnly) return 0
    const res = r.q.add(entries)
    publish(r)
    return res.attention
  }

  function requestPersistIfDue(r: Runtime): void {
    if (r.memoryOnly || r.meta.persistAskedAt !== null || r.doc.expenses.size === 0) return
    r.meta = { ...r.meta, persistAskedAt: Date.now() }
    r.dirty = true
    scheduleFlush(r)
    void requestPersist().then((persisted) => {
      if (r !== rt || persisted === null) return
      r.meta = { ...r.meta, persisted }
      r.dirty = true
      scheduleFlush(r)
      publish(r)
    })
  }

  // ── cross-tab (§9.9, P2-17) ───────────────────────────────────────────────────────────────

  /**
   * Another tab wrote since our last write. False when this tab may not write now: it must write
   * nothing again (removed elsewhere), or another tab's envelope it cannot read has no copy kept.
   */
  function absorbIfForeign(r: Runtime): boolean {
    if (r.io === null) return false
    const gen = r.io.read(GEN_KEY)
    if (!gen.ok) return true
    if (gen.value !== null && gen.value !== r.lastGen) {
      if (absorb(r) === 'blocked') return false
    }
    // the envelope and its generation vanished: another tab removed SpendTrack from this device
    else if (gen.value === null && r.lastGen !== null && r.io.get(DB_KEY) === null) {
      wipedElsewhere(r)
      return false
    }
    return !r.wiped
  }

  /**
   * Read-merge-write: the stored envelope joins memory (the same join as sync), outbox by max
   * stamp, hlc by max. 'more' when memory now holds more than storage; 'blocked' when the stored
   * envelope does not read and no copy of it could be kept, so it must not be written over yet
   * (P2-16: never overwrite the only copy of something): the write is retried.
   */
  function absorb(r: Runtime): 'more' | 'same' | 'blocked' {
    if (r.io === null || r.memoryOnly || r.wiped) return 'same'
    const raw = r.io.read(DB_KEY)
    if (!raw.ok) return 'same'
    if (raw.value === null) {
      // only Remove-from-this-device deletes the envelope: another tab just did that
      if (r.lastGen !== null) wipedElsewhere(r)
      return 'same'
    }
    const wall = Date.now()
    const p: ParsedEnvelope = parseEnvelope(raw.value, wall, r.doc)
    if (!p.ok) {
      if (r.q?.addRaw(DB_KEY, raw.value, wall, RAW_COPIES_PER_KEY) !== true) {
        // lastGen stays: the next write reads it again, and copies it once there is room
        r.dirty = true
        setLocal(r, 'error-storage')
        startRetry(r)
        publish(r)
        return 'blocked'
      }
      r.lastGen = r.io.get(GEN_KEY)
      // whatever of it still reads joins memory, as at a boot that finds it (§9.6.3)
      const salvage = p.dec?.doc ?? salvageEnvelope(raw.value, wall, 1)
      const m = mergeDoc(r.doc, salvage)
      if (m.doc !== r.doc) commit(r, m.doc, diffTouched(r.doc, m.doc), 'tab')
      r.dirty = true
      publish(r)
      return 'more'
    }
    r.lastGen = r.io.get(GEN_KEY)
    const wasDirty = r.dirty
    const m = mergeDoc(r.doc, p.doc)
    r.outbox = joinOutbox(r.outbox, p.meta.outbox)
    r.clock.last = Math.max(r.clock.last, p.meta.hlc)
    r.meta = joinMeta(r.meta, p.meta)
    if (m.doc !== r.doc) commit(r, m.doc, [], 'tab')
    const more = wasDirty || digestDoc(r.doc) !== p.digest || r.outbox.size > p.meta.outbox.length
    r.dirty = more
    r.q?.load()
    publish(r)
    return more ? 'more' : 'same'
  }

  function wipedElsewhere(r: Runtime): void {
    r.wiped = true
    stopTimers(r)
    reloadPage()
  }

  /** P2-17 / §9.9: an old build's whole-array write folds in; absence is never deletion. */
  function fold(r: Runtime, at: number, source: CommitSource): void {
    if (r.io === null) return
    const io = r.io
    const v4 = readV4((k) => io.get(k))
    for (const key of v4.broken) {
      const raw = v4.raws[key]
      if (raw !== undefined) r.q?.addRaw(key, raw, at)
    }
    const dec = decodeV4(v4, { legacyRank: rankOf(io), at, fold: true, reuse: r.doc })
    addQuarantine(r, [...dec.report.quarantined, ...dec.report.repairs])
    const m = mergeDoc(r.doc, dec.doc)
    if (m.doc !== r.doc) commit(r, m.doc, diffTouched(r.doc, m.doc), source)
    // rewrite the mirror (and its sum) so the same keys never fold again
    r.mirrorDirty = true
    r.dirty = true
    flush(r)
    writeMirror(r)
  }

  function onStorage(key: string | null): void {
    const r = rt
    if (r === null || r.memoryOnly || r.wiped || r.io === null) return
    if (key === DB_KEY || key === GEN_KEY) {
      if (r.tabTimer !== null) clearTimeout(r.tabTimer)
      r.tabTimer = setTimeout(() => {
        r.tabTimer = null
        if (r === rt && absorb(r) === 'more') flush(r)
      }, TAB_DEBOUNCE)
      return
    }
    if (key !== null && !isV4DataKey(key)) return
    if (r.v4Timer !== null) clearTimeout(r.v4Timer)
    r.v4Timer = setTimeout(() => {
      r.v4Timer = null
      if (r !== rt || r.io === null) return
      absorbIfForeign(r)
      if (foreignV4(r)) fold(r, Date.now(), 'tab')
    }, V4_DEBOUNCE)
  }

  // ── boot (§9.6) ───────────────────────────────────────────────────────────────────────────

  function newRuntime(io: Io | null): Runtime {
    const writer =
      (r: () => Runtime) =>
      (key: string, value: string, maxLevel: number = LEVEL_DERIVED): WriteResult => {
        const at = r()
        // Memory only, or removed from this device: nothing is written again (§9.6.3), not even
        // by background work such as compressing a snapshot an earlier session left.
        if (at.memoryOnly || at.wiped) return 'error'
        return writeShed(at, key, value, Math.min(maxLevel, LEVEL_DERIVED))
      }
    let self: Runtime | null = null
    const me = (): Runtime => {
      if (self === null) throw new Error('engine runtime missing')
      return self
    }
    const runtime: Runtime = {
      io,
      q: io === null ? null : new Quarantine(io, writer(me)),
      snaps: io === null ? null : new Snapshots(io, writer(me)),
      journal: io === null ? null : new Journal(io, writer(me)),
      tabId: newRev(rng).slice(0, 8),
      dev: storage.getDeviceId(),
      clock: { last: 0 },
      doc: pristineDoc(),
      meta: freshMeta(),
      outbox: new Map(),
      memoryOnly: io === null,
      wiped: false,
      dirty: false,
      queued: false,
      mirrorDirty: false,
      mirrorWritten: null,
      lastGen: null,
      genN: 0,
      localRev: 0,
      local: io === null ? 'memory-only' : 'saved',
      views: null,
      viewsDoc: null,
      currency: null,
      facts: null,
      attention: null,
      mirrorTimer: null,
      retryTimer: null,
      tabTimer: null,
      v4Timer: null,
      undo: new Map(),
      undoToasts: [],
      massCache: new Map(),
      previews: new WeakMap(),
      bootCheck: null,
      idleTimer: null,
    }
    self = runtime
    return runtime
  }

  interface Booted {
    readonly report: BootReport | null
    /** Something was decided at boot that storage does not hold yet. */
    readonly changed: boolean
  }

  function reportOf(
    kind: BootReport['kind'],
    doc: Doc,
    report: SanitizeReport,
    attention: number,
  ): BootReport | null {
    const r: BootReport = {
      kind,
      entries: doc.expenses.size,
      needsAttention: attention,
      repaired: report.repaired,
      deduped: report.deduped,
      revived: report.liveAndDeleted,
    }
    const quiet = r.needsAttention + r.repaired + r.deduped + r.revived === 0
    return kind === 'upgraded' && quiet ? null : r
  }

  function goMemoryOnly(r: Runtime, doc: Doc): Booted {
    r.memoryOnly = true
    r.local = 'memory-only'
    r.doc = doc
    return { report: null, changed: false }
  }

  /** §9.6.2 + P2-16: quarantine copies → pre-v5 snapshot → envelope → mirror. */
  function migrate(r: Runtime, io: Io, wall: number): Booted {
    const v4 = readV4((k) => io.get(k))
    const rank = rankOf(io)
    const dec = decodeV4(v4, { legacyRank: rank, at: wall })
    const doc = withDefaultCategories(dec.doc)
    for (const key of v4.broken) {
      const raw = v4.raws[key]
      if (raw !== undefined && r.q?.addRaw(key, raw, wall) !== true) return goMemoryOnly(r, doc)
    }
    const kept = r.q?.add([...dec.report.quarantined, ...dec.report.repairs])
    if (kept?.stored !== true) return goMemoryOnly(r, doc)
    const snap = r.snaps?.takeV4(snapshotRaws(v4, rank), v4.rows, wall) ?? null
    r.doc = doc
    r.meta = { ...freshMeta(), migratedAt: wall }
    if (syncOn()) r.outbox = addTouched(new Map(), everyKey(doc))
    // never overwrite the only byte-original copy without a backup of it (P2-16)
    const keepV4 = (): void => {
      r.meta = { ...r.meta, mirrorOff: 'quota', mirrorSum: hashV4((k) => io.get(k)) }
    }
    if (snap === null) keepV4()
    r.dirty = true
    // The v4 keys are never shed here: until an envelope is stored they are the data (§13).
    let written = flush(r, LEVEL_DERIVED)
    const v4Kept = (): boolean => MIRROR_ORDER.every((k) => io.get(k) === (v4.raws[k] ?? null))
    if (!written && snap !== null && r.local === 'error-quota' && v4Kept()) {
      // No room for the envelope beside two copies of the v4 keys: keep the keys themselves,
      // byte for byte (the P2-16 case), so their copy can make room.
      r.snaps?.drop(snap.id)
      keepV4()
      written = flush(r, LEVEL_DERIVED)
    }
    // the keys were read just now, in this task: nothing can have written them since
    if (written && r.meta.mirrorOff === null) writeMirror(r)
    const attention = dec.report.quarantined.length + v4.broken.length
    return { report: reportOf('upgraded', doc, dec.report, attention), changed: !written }
  }

  const snapshotRaws = (v4: V4Read, rank: 0 | 1): Readonly<Record<string, string>> => ({
    ...v4.raws,
    rank: String(rank),
  })

  /**
   * §9.6.3: never deletes; joins every copy that still reads. `env` is the damaged envelope, or
   * null when it is missing while snapshots remain (storage lost the envelope and the v4 keys:
   * the snapshots are then the data, never a pristine start).
   */
  async function recover(
    r: Runtime,
    io: Io,
    env: { readonly raw: string; readonly parsed: ParsedEnvelope } | null,
    wall: number,
  ): Promise<Booted> {
    if (env !== null && r.q?.addRaw(DB_KEY, env.raw, wall) !== true) r.memoryOnly = true
    const rank = legacyRankOf(io.get(APP_KEY))
    const docs: Doc[] = []
    if (env !== null) {
      if (!env.parsed.ok && env.parsed.dec !== undefined) docs.push(env.parsed.dec.doc)
      else docs.push(salvageEnvelope(env.raw, wall, 1))
    }
    const v4 = readV4((k) => io.get(k))
    const mirror = decodeV4(v4, { legacyRank: rank, at: wall, fold: true })
    docs.push(mirror.doc)
    for (const body of (await r.snaps?.bodies()) ?? []) docs.push(decodeSnapshot(body, wall))
    const doc = withDefaultCategories(docs.reduce((a, b) => mergeDoc(a, b).doc, EMPTY_DOC))
    r.doc = doc
    r.meta = freshMeta()
    r.outbox = addTouched(new Map(), everyKey(doc))
    if (r.memoryOnly) {
      r.local = 'memory-only'
      return { report: null, changed: false }
    }
    addQuarantine(r, mirror.report.quarantined)
    r.mirrorDirty = true
    return {
      report: {
        kind: 'recovered',
        entries: doc.expenses.size,
        needsAttention: r.q?.count() ?? 0,
        repaired: mirror.report.repaired,
        deduped: mirror.report.deduped,
        revived: 0,
      },
      changed: true,
    }
  }

  function pristine(r: Runtime, io: Io, wall: number): Booted {
    if (!DEMO || io.get(DEMO_KEY) !== null || storage.getSyncId() !== null) {
      return { report: null, changed: false }
    }
    r.doc = withDefaultCategories(decodeSeed(wall))
    io.write(DEMO_KEY, 'seeded')
    return { report: null, changed: true }
  }

  async function bootFrom(r: Runtime, wall: number): Promise<Booted> {
    const io = r.io
    if (io === null) return goMemoryOnly(r, pristineDoc())
    r.q?.load()
    r.snaps?.resume(wall)
    const raw = io.read(DB_KEY)
    if (!raw.ok) return goMemoryOnly(r, pristineDoc())
    if (raw.value === null) {
      if (anyV4((k) => io.get(k))) return migrate(r, io, wall)
      if ((r.snaps?.index().length ?? 0) > 0) return recover(r, io, null, wall)
      return pristine(r, io, wall)
    }
    const parsed = parseEnvelope(raw.value, wall, undefined, false)
    if (parsed.ok) {
      r.doc = parsed.doc
      r.meta = parsed.meta
      r.outbox = new Map(parsed.meta.outbox)
      r.lastGen = io.get(GEN_KEY)
      r.bootCheck = { doc: parsed.doc, digest: parsed.digest, raw: raw.value }
    } else {
      // the ladder already joined the mirror
      return recover(r, io, { raw: raw.value, parsed }, wall)
    }
    if (foreignV4(r)) {
      fold(r, wall, 'boot')
      return { report: null, changed: true }
    }
    return { report: null, changed: false }
  }

  async function boot(): Promise<void> {
    const prev = rt
    // What the previous boot holds that storage does not (its write failed, or it ran in memory
    // only) joins the new boot, so a re-boot never drops an unsaved change (P2-14).
    let carry: Pick<Runtime, 'doc' | 'outbox'> | null = null
    if (prev !== null) {
      // the envelope write absorbs what changed in storage first; the mirror is left to the new
      // boot's check, which folds in whatever storage holds before it writes
      flush(prev)
      stopTimers(prev)
      if (prev.dirty && !prev.wiped) carry = { doc: prev.doc, outbox: prev.outbox }
    }
    const wall = Date.now()
    const area = openArea()
    const r = newRuntime(area === null ? null : new Io(area))
    rt = r
    let booted: Booted = { report: null, changed: false }
    try {
      booted = await bootFrom(r, wall)
    } catch {
      // a bug must never write over what is stored: run in memory with what was read
      r.memoryOnly = true
      r.local = 'memory-only'
    }
    if (rt !== r) return
    if (carry !== null) {
      const joined = mergeDoc(r.doc, carry.doc).doc
      const outbox = joinOutbox(r.outbox, [...carry.outbox])
      if (joined !== r.doc || outbox !== r.outbox) booted = { ...booted, changed: true }
      r.doc = joined
      r.outbox = outbox
    }
    r.clock.last = Math.max(r.meta.hlc, Math.min(maxStampOf(r.doc), wall + MAX_AHEAD))
    r.views = null
    r.viewsDoc = null
    publish(r, {
      hydrated: true,
      local: r.local,
      syncStatus: r.local === 'saved' ? 'saved' : 'error',
      undoStack: [],
      report: booted.report,
    })
    if (booted.changed) {
      r.dirty = true
      flush(r)
      flushMirror(r)
    }
    requestPersistIfDue(r)
    emit('boot')
    if (installRequested) install()
    r.idleTimer = setTimeout(() => {
      r.idleTimer = null
      void afterBoot(r)
    }, 0)
  }

  /**
   * After the first render: the storage tally, and the envelope's digest (§9.3). A body that parsed
   * and sanitised but does not match its digest takes the recovery ladder late: the doc in use is
   * joined with the mirror and every snapshot, so nothing anyone saw or typed since is lost. Then
   * the mirror is checked once on the idle debounce: a crash inside its last debounce leaves it
   * behind the envelope, and a rollback must not depend on the next commit to catch it up. Only a
   * boot that read an envelope can have a lagging mirror: a pristine origin writes nothing until
   * its first commit.
   */
  async function afterBoot(r: Runtime): Promise<void> {
    if (r !== rt || r.io === null) return
    r.io.measure()
    const check = r.bootCheck
    r.bootCheck = null
    if (check !== null && digestDoc(check.doc) !== check.digest && !r.memoryOnly && !r.wiped) {
      await recoverLate(r, r.io, check.raw)
    }
    if (r === rt) retryMirror(r)
    publish(r)
    if (r === rt && check !== null && !r.mirrorDirty) scheduleMirror(r)
  }

  /**
   * A rollback copy turned off under quota comes back at the first boot with room for it, so one
   * full moment does not leave a rollback unsafe for good (§9.10). v4 keys still held byte for
   * byte from before the upgrade (P2-16) get their pre-v5 copy first; without room for that copy
   * the mirror stays off.
   */
  function retryMirror(r: Runtime): void {
    const io = r.io
    if (io === null || r.meta.mirrorOff === null || r.memoryOnly || r.wiped) return
    if (io.used() >= MIRROR_RETRY * LS_BUDGET) return
    const get = (k: string): string | null => io.get(k)
    if (anyV4(get) && hashV4(get) === r.meta.mirrorSum) {
      const v4 = readV4(get)
      const copy = r.snaps?.takeV4(snapshotRaws(v4, rankOf(io)), v4.rows, Date.now()) ?? null
      if (copy === null) return
    }
    r.meta = { ...r.meta, mirrorOff: null }
    r.dirty = true
    r.mirrorDirty = true
    flushMirror(r)
  }

  async function recoverLate(r: Runtime, io: Io, raw: string): Promise<void> {
    const wall = Date.now()
    r.q?.addRaw(DB_KEY, raw, wall)
    const v4 = readV4((k) => io.get(k))
    const mirror = decodeV4(v4, { legacyRank: rankOf(io), at: wall, fold: true })
    const docs = [mirror.doc]
    for (const body of (await r.snaps?.bodies()) ?? []) docs.push(decodeSnapshot(body, wall))
    if (r !== rt) return
    const doc = docs.reduce((a, b) => mergeDoc(a, b).doc, r.doc)
    if (doc !== r.doc) commit(r, doc, diffTouched(r.doc, doc), 'tab')
    r.outbox = addTouched(r.outbox, everyKey(r.doc))
    r.dirty = true
    r.mirrorDirty = true
    flush(r)
    flushMirror(r)
    publish(r, {
      report: {
        kind: 'recovered',
        entries: r.doc.expenses.size,
        needsAttention: r.q?.count() ?? 0,
        repaired: mirror.report.repaired,
        deduped: mirror.report.deduped,
        revived: 0,
      },
    })
  }

  function install(): void {
    installRequested = true
    if (uninstall !== null) return
    uninstall = installLifecycle({
      flushAll,
      onStorage,
      area: () => rt?.io?.area ?? null,
    })
  }

  function flushAll(): void {
    const r = rt
    if (r === null) return
    flush(r)
    flushMirror(r)
  }

  // ── the sync port (§6.2) ──────────────────────────────────────────────────────────────────

  /**
   * Appends a remote merge's journal entries. A mass removal with no guard snapshot depends on
   * its entry (the removed records ride in it): without room, the rollback copy is shed to make
   * some (the envelope still holds every record, so that copy is not the only one), and when even
   * that leaves none the merge is refused before anything is removed. Running in memory only, or
   * removed from this device, nothing is written either way: storage keeps what it had.
   */
  /** True once `entries` are journaled (Recovery lists them then). */
  function keepJournal(r: Runtime, entries: JournalEntry[], mass: MassNote | null): boolean {
    const journal = r.journal
    if (journal === null) return false
    if (journal.append(entries)) return true
    if (mass === null || mass.snapshotId !== null || r.memoryOnly || r.wiped) return false
    if (shedMirror(r) && journal.append(entries)) {
      publish(r)
      return true
    }
    throw new SafetyCopyError(REMOTE_SAFETY_COPY_ERROR)
  }

  const port: SyncPort = {
    doc: () => need().doc,
    localRev: () => need().localRev,
    outbox: () => need().outbox,
    applyRemote(dec: SanitizeResult): RemoteApplied {
      const r = need()
      const wall = Date.now()
      const quarantined = addQuarantine(r, [...dec.report.quarantined, ...dec.report.repairs])
      const current = r.doc
      const m = mergeDoc(current, dec.doc)
      observe(r.clock, wall, maxStampDoc(dec.doc))
      if (m.doc === current) {
        return { changedLocal: false, removed: 0, mass: null, quarantined, conflicts: 0 }
      }
      let massNote: MassNote | null = null
      if (guardTrips(m.removed, current)) {
        const snap = takeSnapshot(r, 'mass', current)
        // without room for the snapshot, the journal entry keeps the removed records (P2-20)
        massNote = {
          ids: m.removed.map((x) => x.id),
          snapshotId: snap?.id ?? null,
          records: snap === null ? m.removed : [],
        }
      }
      // §11.9 order: the snapshot, then the journal, then the merge. What a mass removal takes
      // is restorable after a reload before the envelope can drop it.
      const entries = classify(m, r.outbox, wall, rng, massNote)
      const kept = keepJournal(r, entries, massNote)
      commit(r, m.doc, [], 'remote')
      flush(r)
      let mass: RemoteApplied['mass'] = null
      if (massNote !== null) {
        const e = entries.find((x) => x.kind === 'mass')
        if (e !== undefined) {
          r.massCache.set(e.id, m.removed)
          mass = { entryId: e.id, count: m.removed.length }
        }
      }
      // the conflict toast's Review lists them: none when they could not be journaled
      const conflicts =
        mass === null && kept ? entries.filter((x) => x.kind === 'conflict').length : 0
      return { changedLocal: true, removed: m.removed.length, mass, quarantined, conflicts }
    },
    ack(sent, dec, outcome): number {
      const r = need()
      const res = ackOutbox(r.outbox, sent, dec, outcome)
      if (res.outbox !== r.outbox) {
        r.outbox = res.outbox
        r.dirty = true
        flush(r)
      }
      return res.waitingForOld
    },
    meta: () => need().meta.sync,
    setMeta(patch: Partial<SyncMeta>): void {
      const r = need()
      r.meta = { ...r.meta, sync: { ...r.meta.sync, ...patch } }
      r.dirty = true
      flush(r)
    },
    deviceId: () => need().dev,
    register(id, info): void {
      const r = need()
      const devices = new Map(r.doc.devices)
      devices.set(id, info)
      r.doc = { ...r.doc, devices }
      r.dirty = true
      scheduleFlush(r)
    },
    omitIds: omit,
    quarantine: (entries) => addQuarantine(need(), entries),
    keepRelayCopy(raw: unknown): boolean {
      const r = need()
      if (r.q === null || r.memoryOnly || r.wiped) return false
      let text: unknown
      try {
        text = JSON.stringify(raw)
      } catch {
        return false
      }
      if (typeof text !== 'string') return false
      const kept = r.q.addRaw(RELAY_COPY_KEY, text, Date.now())
      publish(r)
      return kept
    },
    onCommit(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    rng,
  }

  // ── actions (§6.1) ────────────────────────────────────────────────────────────────────────

  function viewFor(r: Runtime, id: string): ExpenseView {
    const v = r.views?.expenses.find((e) => e.id === id)
    if (v === undefined) throw new Error('The new entry could not be shown.')
    return v
  }

  const ZERO_IMPORT: ImportOutcome = {
    applied: 0,
    skipped: 0,
    added: 0,
    restored: 0,
    updated: 0,
    removed: 0,
  }

  /**
   * The backup file. It records nothing: "Last backup" (F-050) is stamped by markBackedUp once the
   * download has been handed to the browser, so a download that fails never reads as a backup.
   */
  function exportBackup(): BackupFileV5 {
    return encodeBackupFile(need().doc, { omitIds: omit() })
  }

  // ── the Recovery centre (PR-4): its own lazy chunk; the host reads the runtime on every call ──

  let recoveryLoad: Promise<typeof RecoveryModule> | null = null

  const recoveryHost: RecoveryModule.RecoveryHost = {
    rt: need,
    run,
    undoTtl: UNDO_LONG,
    preview: previewOf,
    writeShed,
    level: LEVEL_DERIVED,
    publish,
    seen: setSeen,
    omit,
    rng,
  }

  async function recovery(): Promise<RecoveryApi> {
    need()
    recoveryLoad ??= importWithReload(() => import('./recoveryCentre')).catch((err: unknown) => {
      recoveryLoad = null
      throw err
    })
    return (await recoveryLoad).createRecovery(recoveryHost)
  }

  function markBackedUp(): void {
    const r = need()
    r.meta = { ...r.meta, lastBackupAt: Date.now() }
    r.dirty = true
    flush(r)
    publish(r)
  }

  return {
    boot,
    port,
    flushAll,
    install,

    addExpense(input: NewExpenseInput): ExpenseView {
      const r = need()
      const pick = input.category === undefined ? smartCategory(r.doc, input.itemName) : null
      const res = run(
        r,
        (doc, ctx) =>
          ops.addExpense(doc, ctx, pick === null ? input : { ...input, category: pick }),
        (x) => `add-${x.created?.id ?? newRev(rng)}`,
      )
      requestPersistIfDue(r)
      return viewFor(r, res.created?.id ?? '')
    },

    /**
     * Writes what is waiting for this task's flush now, and says how the save went: an add's
     * confirmation is chosen from it, so the first entry storage refuses is never a tick (§6.5).
     */
    saveNow(): LocalStatus {
      const r = need()
      if (r.dirty) flush(r)
      return r.local
    },

    updateExpense(id: string, patch: ExpensePatch): void {
      const r = need()
      run(
        r,
        (doc, ctx) => ops.updateExpense(doc, ctx, id, patch),
        () => stampedId(r, `update-${id}`),
      )
    },

    deleteExpense(id: string): void {
      const r = need()
      run(
        r,
        (doc, ctx) => ops.deleteExpenses(doc, ctx, [id]),
        () => stampedId(r, `del-${id}`),
      )
    },

    deleteAllEverywhere(): void {
      const r = need()
      if (r.doc.expenses.size === 0) return
      const snap = takeSnapshot(r, 'delete-all')
      if (snap === null) throw new Error(SAFETY_COPY_ERROR)
      const ids = [...r.doc.expenses.keys()]
      run(r, (doc, ctx) => ops.deleteAllEverywhere(doc, ctx), revId('all'), UNDO_LONG)
      r.journal?.append([
        {
          id: newRev(rng),
          at: Date.now(),
          seen: true,
          kind: 'mass',
          count: ids.length,
          ids,
          snapshotId: snap.id,
        },
      ])
    },

    /**
     * Wipes this device and reloads. The backup the owner may want first is its own step
     * (exportBackup, then a separate confirm): WebKit drops a download the same task reloads over.
     */
    async removeDataFromThisDevice(): Promise<void> {
      const r = need()
      if (removing) return
      removing = true
      useSyncStore.getState().disconnectSync()
      r.wiped = true
      stopTimers(r)
      for (const k of r.io?.keys() ?? []) if (isSpendTrackKey(k)) r.io?.removeKey(k)
      await Promise.resolve()
      reloadPage()
    },

    unsyncedChanges(): number {
      const r = need()
      return syncOn() ? r.outbox.size : 0
    },

    clearSampleData(): void {
      const r = need()
      if (!DEMO) return
      const ids = [...r.doc.expenses.keys()].filter(isDemoId)
      if (ids.length > 0) run(r, (doc, ctx) => ops.deleteExpenses(doc, ctx, ids))
      if (!r.memoryOnly) r.io?.write(DEMO_KEY, 'dismissed')
    },

    addCategory(name: string): void {
      const r = need()
      run(r, (doc, ctx) => ops.addCategory(doc, ctx, name))
    },

    renameCategory(from: string, to: string): void {
      const r = need()
      run(r, (doc, ctx) => spending.renameCategory(doc, ctx, from, to), revId('cat'))
    },

    removeCategory(name: string): void {
      const r = need()
      run(r, (doc, ctx) => spending.removeCategory(doc, ctx, name), revId('cat'))
    },

    setBudget(category: string, amount: number): void {
      const r = need()
      run(r, (doc, ctx) => ops.setBudget(doc, ctx, category, amount), revId('bud'))
    },

    removeBudget(category: string): void {
      const r = need()
      run(r, (doc, ctx) => ops.removeBudget(doc, ctx, category), revId('bud'))
    },

    setCategoryAside(category: string, aside: boolean): void {
      const r = need()
      run(r, (doc, ctx) => spending.setAside(doc, ctx, category, aside), revId('set'))
    },

    setMonthBudget(amount: number | null): void {
      const r = need()
      run(r, (doc, ctx) => spending.setMonthCap(doc, ctx, amount), revId('set'))
    },

    setCurrency(code: string): void {
      const r = need()
      run(r, (doc, ctx) => ops.setCurrency(doc, ctx, code), revId('cur'))
      // Never after "Remove from this device", here or in another tab that has not flushed
      // since: the check flush() makes before it writes (§9.9).
      if (!r.memoryOnly && !r.wiped && absorbIfForeign(r)) r.io?.write(CURRENCY_PREF_KEY, code)
      if (r.currency !== code && isSupportedCurrency(code)) {
        r.currency = code
        host.showCurrency(code)
      }
    },

    getSmartCategory(itemName: string): string | null {
      return rt === null ? null : smartCategory(rt.doc, itemName)
    },

    async previewImport(file: Blob): Promise<ImportPreview> {
      need()
      if (file.size > IMPORT_MAX_BYTES) throw new Error('This file is larger than 8 MB.')
      const text = await blobText(file)
      const r = need()
      const parsed = parseJson(text)
      if (parsed === null) throw new Error("This file isn't a SpendTrack backup (it isn't JSON).")
      const dec = decodeFile(parsed.value, Date.now())
      if (dec.writer === 'invalid' || dec.writer === 'e2e' || dec.writer === 'moved') {
        throw new Error("This file isn't a SpendTrack backup.")
      }
      return previewOf(r, dec, file instanceof File ? file.name : 'backup.json')
    },

    applyImport(preview: ImportPreview, mode: 'restore' | 'replace'): ImportOutcome {
      const r = need()
      const held = r.previews.get(preview)
      if (held === undefined || held.used) return ZERO_IMPORT
      // a stale preview still applies correctly: the plan is recomputed against the doc now
      const plan = ops.planImport(r.doc, held.dec)
      const res = ops.applyImport(r.doc, ctxOf(r), plan, mode)
      if (res.doc === r.doc) {
        held.used = true
        return ZERO_IMPORT
      }
      if (takeSnapshot(r, mode === 'replace' ? 'replace' : 'import') === null) {
        throw new Error(SAFETY_COPY_ERROR)
      }
      commit(r, res.doc, res.touched, 'local')
      held.used = true
      if (res.undo !== undefined) pushUndo(r, `imp-${newRev(rng)}`, res.undo, UNDO_LONG)
      return {
        applied: res.undo?.items.length ?? 0,
        skipped: 0,
        added: plan.counts.added,
        restored: plan.counts.restored,
        updated: plan.counts.updated,
        removed: mode === 'replace' ? plan.replaceDeletes : 0,
      }
    },

    exportBackup,
    markBackedUp,

    quarantineFile(): unknown {
      return need().q?.file(new Date().toISOString()) ?? null
    },

    markAttentionSeen(): void {
      const r = need()
      setSeen(r, r.q?.count() ?? 0)
    },

    /** A remote mass removal's Undo (P2-20): the Recovery centre restores it. */
    restoreJournal: async (entryId: string): Promise<RestoreResult> =>
      (await recovery()).restoreChange(entryId),

    recovery,

    refreshStorageFacts(): void {
      const r = need()
      publish(r)
      void queryPersisted().then((persisted) => {
        if (r !== rt || persisted === null || persisted === r.meta.persisted) return
        r.meta = { ...r.meta, persisted }
        r.dirty = true
        scheduleFlush(r)
        publish(r)
      })
    },

    dismissReport(): void {
      host.set({ report: null })
    },

    consumeUndo(id: string): UndoOutcome | null {
      const r = rt
      if (r === null) return null
      const now = Date.now()
      const entry = r.undo.get(id)
      const toast = r.undoToasts.find((u) => u.id === id)
      dropUndo(r, id)
      if (entry === undefined || toast === undefined || toast.expiresAt < now) return null
      const res = ops.undo(r.doc, ctxOf(r), entry)
      commit(r, res.doc, res.touched, 'local')
      return res.report ?? { applied: 0, skipped: 0 }
    },

    clearUndo(id: string): void {
      if (rt !== null) dropUndo(rt, id)
    },
  }
}
