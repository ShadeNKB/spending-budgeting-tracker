// The one codec for relay payloads, local envelopes, backup files and the v4 keys (DATA-ENGINE-SPEC
// §8.2, §10; P-3 decodeWire IS sanitizeDoc; P-9, P-11, P-12, P-15, P-16, P-21, P-22).
// decodeWire never throws: every collection is shape-guarded on its own and a bad piece becomes its
// empty default plus a report entry, so one bad key can never block the others (F-005, F-014).
import { displayList, isBudgetShown, resolver } from './categories'
import {
  CURRENCY_KEY,
  EXTRA_KEY_RE,
  LEGACY_EPOCH_ISO,
  LIVE_AND_DELETED,
  MIRROR_ORDER,
  MOVED_MIN,
  OTHER,
  PLAIN_MIN,
  QUARANTINE_RAW_MAX,
  RECORDS_MAX,
  SCHEMA,
  SCHEMA_MINOR,
  WIRE_PUSH_MAX,
  WIRE_WARN,
  isReserved,
  nullRecord,
} from './constants'
import { EMPTY_DOC, digestDoc, joinTomb, maxStampDoc, recordsJsonOf, sortedIdsOf } from './doc'
import { canon, fnv36 } from './hash'
import { contentKey, dedupeId, reviveId } from './ids'
import { decodeRecord, encodeRecord, recordString } from './record'
import {
  cleanAmount,
  cleanWire,
  isJson,
  isPlainObject,
  own,
  ownEntries,
  sanitizeExpense,
  validCurrency,
  validId,
  validMapKey,
  validName,
  type CleanExpense,
} from './sanitize'
import { iso, ps, vs } from './stamp'
import type {
  BackupFileV5,
  BudgetReg,
  DeviceInfo,
  Doc,
  ExpenseRec,
  MapReg,
  MovedMarker,
  Origin,
  PrefReg,
  QEntry,
  RenameReg,
  SanitizeReport,
  SanitizeResult,
  SizeClass,
  Stamp,
  V4Key,
  WireDevice,
  WireDocV5,
  WireRecord,
  WriterClass,
  X5Block,
} from './types'

export interface DecodeOptions {
  /** srcRank of local v4 keys: 1 if spendtrack:app ≥ 0.8.5, else 0 (§5.3). */
  readonly legacyRank?: 0 | 1
  /** A doc whose record objects may be reused when the raw record is its exact wire copy (P-21). */
  readonly reuse?: Doc
  /** Wall time stamped on quarantine entries (core never reads a clock). */
  readonly at?: number
  /**
   * The v4 keys are FOLDED into a live doc (§9.6.1 boot fold, §9.9 legacyFold, §9.6.3 recovery), not
   * migrated (§9.6.2). An id they list both live and deleted is then ambiguous (a mirror torn between
   * `deletedExpenseIds` and `expenses`, or a v0.8.4 undo that re-used the id), so the fold leaves it
   * out entirely, neither row nor tombstone: it can neither resurrect nor delete anything, and a
   * torn mirror folds in as a no-op (§9.10). Its original is kept in the report.
   */
  readonly fold?: boolean
}

export interface EncodeOptions {
  readonly dev?: string
  readonly rev?: string
  /** Lowest client level allowed to push this row (4 during coexistence). */
  readonly min?: number
  /** Ids kept off the wire (demo rows on a demo build, P-9). */
  readonly omitIds?: (id: string) => boolean
}

interface Acc {
  readonly at: number
  readonly origin: Origin
  readonly quarantined: QEntry[]
  repaired: number
  readonly repairs: QEntry[]
  deduped: number
  liveAndDeleted: number
  readonly droppedKeys: string[]
}

const newAcc = (at: number, origin: Origin): Acc => ({
  at,
  origin,
  quarantined: [],
  repaired: 0,
  repairs: [],
  deduped: 0,
  liveAndDeleted: 0,
  droppedKeys: [],
})

function rawText(v: unknown): string {
  try {
    const t: unknown = JSON.stringify(v)
    return typeof t === 'string' ? t.slice(0, QUARANTINE_RAW_MAX) : ''
  } catch {
    return ''
  }
}

const report = (a: Acc): SanitizeReport => ({
  quarantined: a.quarantined,
  repaired: a.repaired,
  repairs: a.repairs,
  deduped: a.deduped,
  liveAndDeleted: a.liveAndDeleted,
  droppedKeys: a.droppedKeys,
})

/** The original of something the sanitiser changed, for the quarantine log (§8.1, R1). */
function keepOriginal(acc: Acc, reason: string, value: unknown): void {
  acc.repairs.push({ at: acc.at, origin: acc.origin, reason, raw: rawText(value) })
}

/** A record with no free derived id (§4.3): kept whole in the quarantine, never under a taken id. */
function noFreeId(acc: Acc, rec: WireRecord): void {
  acc.quarantined.push({ at: acc.at, origin: acc.origin, reason: 'no-free-id', raw: rawText(rec) })
}

/** A dropped collection piece: its label for the report, its original (with its key) for the log. */
function drop(acc: Acc, label: string, value: unknown): void {
  acc.droppedKeys.push(label)
  keepOriginal(acc, `dropped:${label}`, value)
}

const emptyResult = (writer: WriterClass, acc: Acc): SanitizeResult => ({
  doc: EMPTY_DOC,
  writer,
  report: report(acc),
  legacyTs: new Map(),
  rev: null,
})

/** v0.8's `ts(e.updatedAt ?? e.createdAt)` on a raw record: `value ? new Date(value).getTime() : 0`. */
export function v08ts(raw: unknown): number {
  if (!isPlainObject(raw)) return NaN
  const value = own(raw, 'updatedAt') ?? own(raw, 'createdAt')
  if (typeof value === 'string') return value === '' ? 0 : new Date(value).getTime()
  if (typeof value === 'number')
    return value === 0 || Number.isNaN(value) ? 0 : new Date(value).getTime()
  return value === undefined || value === null || value === false ? 0 : NaN
}

function classify(raw: Readonly<Record<string, unknown>>, origin: Origin): WriterClass {
  if (own(raw, 'st') !== undefined) return 'e2e'
  const x5 = own(raw, 'x5')
  const x5o = isPlainObject(x5) ? x5 : null
  if (own(raw, 'expenses') === 'moved' || (x5o !== null && own(x5o, 'moved') !== undefined)) {
    return 'moved'
  }
  if (x5 !== undefined) {
    const schema = x5o === null ? undefined : own(x5o, 'schema')
    const min = x5o === null ? undefined : own(x5o, 'min')
    if (
      (typeof schema === 'number' && schema > SCHEMA) ||
      (typeof min === 'number' && min > SCHEMA)
    ) {
      return 'newer'
    }
    return 'v5'
  }
  const version = own(raw, 'version')
  if (origin === 'file' && typeof version === 'string' && Number.parseInt(version, 10) > SCHEMA) {
    return 'newer'
  }
  if (own(raw, 'wr') !== undefined) return 'v085'
  return Array.isArray(own(raw, 'expenses')) ? 'v084' : 'invalid'
}

function srcRankOf(origin: Origin, writer: WriterClass, legacyRank: 0 | 1): 0 | 1 {
  if (origin === 'file') return 0
  if (origin === 'local-v4') return legacyRank
  if (origin === 'remote') return writer === 'v084' ? 0 : 1
  return 1
}

/**
 * Is a pulled value exactly our own wire value (same keys in the same order, same JSON values)? The
 * reuse check of P-21. `ours` is built by this module (plain frozen data), so it is read directly;
 * the pulled side is read through own data properties only.
 */
function sameAsOurs(raw: unknown, ours: unknown): boolean {
  if (raw === ours) return true
  if (typeof raw !== 'object' || typeof ours !== 'object' || raw === null || ours === null) {
    return false
  }
  if (Array.isArray(ours)) {
    if (!Array.isArray(raw) || raw.length !== ours.length) return false
    for (let i = 0; i < ours.length; i++) {
      const x: unknown = raw[i]
      const y: unknown = ours[i]
      if (!sameAsOurs(x, y)) return false
    }
    return true
  }
  if (Array.isArray(raw)) return false
  const ka = Object.keys(raw)
  const kb = Object.keys(ours)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < kb.length; i++) {
    const k = kb[i]
    if (k === undefined || ka[i] !== k) return false
    const mine: unknown = Reflect.get(ours, k)
    if (!sameAsOurs(own(raw, k), mine)) return false
  }
  return true
}

interface Item {
  readonly rec: ExpenseRec
  /** The sanitised raw record; null when a reused record's own wire copy came in. */
  readonly clean: CleanExpense | null
}

/** The canonical wire object of an item: built only when a duplicate id needs it (§7.9). */
const wireOf = (it: Item): WireRecord =>
  it.clean === null ? encodeRecord(it.rec) : cleanWire(it.clean)

function decodeExpenses(
  list: readonly unknown[],
  origin: Origin,
  srcRank: 0 | 1,
  reuse: Doc | undefined,
  acc: Acc,
): Item[] {
  const items: Item[] = []
  const n = Math.min(list.length, RECORDS_MAX)
  for (let i = 0; i < n; i++) {
    const raw: unknown = list[i]
    if (reuse !== undefined && isPlainObject(raw)) {
      const id = own(raw, 'id')
      const prev = typeof id === 'string' ? reuse.expenses.get(id) : undefined
      if (prev !== undefined) {
        const enc = encodeRecord(prev)
        if ((Object.hasOwn(enc, 'h') || srcRank === 1) && sameAsOurs(raw, enc)) {
          items.push({ rec: prev, clean: null })
          continue
        }
      }
    }
    const r = sanitizeExpense(raw)
    if (r.kind === 'quarantine') {
      acc.quarantined.push({ at: acc.at, origin, reason: r.reason, raw: rawText(raw) })
      continue
    }
    if (r.kind === 'repaired') {
      acc.repaired++
      keepOriginal(acc, `repaired:${r.notes.join(',')}`, raw)
    }
    items.push({ rec: decodeRecord(r.rec, srcRank), clean: r.rec })
  }
  for (let i = n; i < list.length; i++) {
    acc.quarantined.push({ at: acc.at, origin, reason: 'cap', raw: rawText(list[i]) })
  }
  return items
}

function decodeTombs(
  raw: Readonly<Record<string, unknown>>,
  x5: Readonly<Record<string, unknown>> | null,
  acc: Acc,
): Map<string, Stamp> {
  const tombs = new Map<string, Stamp>()
  const ids = own(raw, 'deletedIds')
  if (ids === undefined) return tombs
  if (!Array.isArray(ids)) {
    drop(acc, 'deletedIds', ids)
    return tombs
  }
  const dts = x5 === null ? undefined : own(x5, 'dts')
  let stamps: readonly unknown[] | null = null
  if (dts !== undefined) {
    if (Array.isArray(dts) && dts.length === ids.length) stamps = dts
    else drop(acc, 'x5.dts', dts)
  }
  for (let i = 0; i < ids.length; i++) {
    const id: unknown = ids[i]
    if (!validId(id)) {
      drop(acc, `deletedIds[${i}]`, id)
      continue
    }
    const s: unknown = stamps?.[i]
    const t = typeof s === 'number' ? vs(s) : 0
    const prev = tombs.get(id)
    tombs.set(id, prev === undefined ? t : joinTomb(prev, t))
  }
  return tombs
}

function decodeCategories(raw: Readonly<Record<string, unknown>>, acc: Acc): string[] {
  const list = own(raw, 'categories')
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    drop(acc, 'categories', list)
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < list.length; i++) {
    const n: unknown = list[i]
    if (!validName(n)) {
      drop(acc, `categories[${i}]`, n)
      continue
    }
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/** Own entries of an optional object field; a wrong shape is reported and treated as empty. */
function entriesOf(
  o: Readonly<Record<string, unknown>> | null,
  key: string,
  label: string,
  acc: Acc,
): readonly (readonly [string, unknown])[] {
  if (o === null) return []
  const v = own(o, key)
  if (v === undefined || v === null) return []
  const entries = ownEntries(v)
  if (entries === null) {
    drop(acc, label, v)
    return []
  }
  return entries
}

function decodeRenames(
  x5: Readonly<Record<string, unknown>> | null,
  acc: Acc,
): Map<string, RenameReg> {
  const out = new Map<string, RenameReg>()
  for (const [k, v] of entriesOf(x5, 'ren', 'x5.ren', acc)) {
    const s: unknown = Array.isArray(v) && v.length === 2 ? v[0] : undefined
    const to: unknown = Array.isArray(v) && v.length === 2 ? v[1] : undefined
    // 'Other' can never be renamed away; its live marker (written by remove) is valid
    if (
      !validName(k) ||
      (k === OTHER && to !== null) ||
      typeof s !== 'number' ||
      (to !== null && !validName(to))
    ) {
      drop(acc, `x5.ren.${k}`, [k, v])
      continue
    }
    out.set(k, { to, s: vs(s) })
  }
  return out
}

function decodeMappings(
  raw: Readonly<Record<string, unknown>>,
  x5: Readonly<Record<string, unknown>> | null,
  acc: Acc,
): Map<string, MapReg> {
  const stamps = new Map<string, Stamp>()
  for (const [k, v] of entriesOf(x5, 'mts', 'x5.mts', acc)) {
    if (typeof v === 'number') stamps.set(k, vs(v))
    else drop(acc, `x5.mts.${k}`, [k, v])
  }
  const out = new Map<string, MapReg>()
  for (const [k, v] of entriesOf(raw, 'categoryMappings', 'categoryMappings', acc)) {
    if (!validMapKey(k) || !validName(v)) {
      drop(acc, `categoryMappings.${k}`, [k, v])
      continue
    }
    out.set(k, { v, s: stamps.get(k) ?? 0 })
  }
  return out
}

function decodeBudgets(
  raw: Readonly<Record<string, unknown>>,
  origin: Origin,
  acc: Acc,
): Map<string, BudgetReg> {
  const values = new Map(entriesOf(raw, 'budgets', 'budgets', acc))
  const sets = new Map(entriesOf(raw, 'budgetUpdatedAt', 'budgetUpdatedAt', acc))
  const dels = new Map(entriesOf(raw, 'budgetDeletedAt', 'budgetDeletedAt', acc))
  const fallback = origin === 'local-v4' ? 0 : ps(own(raw, 'exportDate'))
  const out = new Map<string, BudgetReg>()
  for (const k of new Set([...values.keys(), ...sets.keys(), ...dels.keys()])) {
    const label = `budgets.${k}`
    const rawValue = values.get(k)
    if (!validName(k)) {
      drop(acc, label, [k, rawValue, sets.get(k), dels.get(k)])
      continue
    }
    const amount = rawValue === undefined ? null : cleanAmount(rawValue)
    if (rawValue !== undefined && amount === null) drop(acc, label, [k, rawValue])
    if (amount?.repaired === true) {
      acc.repaired++
      keepOriginal(acc, `repaired:${label}`, [k, rawValue])
    }
    const setRaw = sets.get(k)
    const set = setRaw !== undefined ? ps(setRaw) : amount !== null ? fallback : 0
    const del = ps(dels.get(k))
    const value = amount === null || (del > 0 && del >= set) ? null : amount.value
    if (value === null && set === 0 && del === 0) continue
    out.set(k, { value, set, del })
  }
  return out
}

function decodePrefs(x5: Readonly<Record<string, unknown>> | null, acc: Acc): Map<string, PrefReg> {
  const out = new Map<string, PrefReg>()
  for (const [k, v] of entriesOf(x5, 'pref', 'x5.pref', acc)) {
    const s: unknown = Array.isArray(v) && v.length === 2 ? v[0] : undefined
    const value: unknown = Array.isArray(v) && v.length === 2 ? v[1] : undefined
    if (
      !isJson(value) ||
      typeof s !== 'number' ||
      !EXTRA_KEY_RE.test(k) ||
      isReserved(k) ||
      rawText(value).length > 2048 ||
      (k === CURRENCY_KEY && value !== null && !validCurrency(value))
    ) {
      drop(acc, `x5.pref.${k}`, [k, v])
      continue
    }
    out.set(k, { v: value, s: vs(s) })
  }
  return out
}

function decodeDevices(
  raw: Readonly<Record<string, unknown>>,
  x5: Readonly<Record<string, unknown>> | null,
  acc: Acc,
): Map<string, DeviceInfo> {
  const out = new Map<string, DeviceInfo>()
  for (const [id, v] of entriesOf(x5, 'devs', 'x5.devs', acc)) {
    const d = isPlainObject(v) ? v : null
    const name = d === null ? undefined : own(d, 'n')
    const app = d === null ? undefined : own(d, 'app')
    const mode = d === null ? undefined : own(d, 'm')
    const e = d === null ? undefined : own(d, 'e')
    const rs = d === null ? undefined : own(d, 'rs')
    const at = d === null ? undefined : own(d, 'at')
    if (
      !validId(id) ||
      typeof name !== 'string' ||
      name.length > 60 ||
      typeof app !== 'string' ||
      app.length > 20 ||
      (mode !== 'table' && mode !== 'rpc') ||
      (e !== 0 && e !== 1)
    ) {
      drop(acc, `x5.devs.${id}`, [id, v])
      continue
    }
    const since = typeof rs === 'number' ? vs(rs) : 0
    out.set(id, {
      name,
      app,
      mode,
      ...(since > 0 ? { rpcSince: since } : {}),
      e2e: e === 1,
      seen: typeof at === 'number' ? vs(at) : 0,
    })
  }
  const wr = own(raw, 'wr')
  if (isPlainObject(wr)) {
    const dev = own(wr, 'dev')
    const app = own(wr, 'app')
    if (validId(dev) && typeof app === 'string' && app.length <= 20) {
      out.set(dev, { name: 'Older app', app, mode: 'table', e2e: false, seen: ps(own(wr, 'at')) })
    }
  }
  return out
}

/**
 * Within one source: identical copies merge into one; differing copies each get a deterministic
 * dedupeId and the shared id is tombstoned with stamp 0 (§7.9, F-047).
 */
function dedupe(
  items: readonly Item[],
  tombs: Map<string, Stamp>,
  acc: Acc,
): Map<string, ExpenseRec> {
  const unique = new Map<string, ExpenseRec>()
  for (const it of items) {
    if (unique.has(it.rec.id)) return dedupeSlow(items, tombs, acc)
    unique.set(it.rec.id, it.rec)
  }
  return unique
}

function dedupeSlow(
  items: readonly Item[],
  tombs: Map<string, Stamp>,
  acc: Acc,
): Map<string, ExpenseRec> {
  const byId = new Map<string, [Item, ...Item[]]>()
  for (const it of items) {
    const list = byId.get(it.rec.id)
    if (list === undefined) byId.set(it.rec.id, [it])
    else list.push(it)
  }
  const out = new Map<string, ExpenseRec>()
  const assigned = new Set<string>()
  const taken = (id: string): boolean => byId.has(id) || tombs.has(id) || assigned.has(id)
  for (const [id, list] of byId) {
    const first = list[0]
    if (list.length === 1) {
      out.set(id, first.rec)
      continue
    }
    const distinct = new Map<string, Item>()
    for (const it of list) {
      const key = canon(wireOf(it))
      if (!distinct.has(key)) distinct.set(key, it)
    }
    acc.deduped += list.length - distinct.size
    if (distinct.size === 1) {
      out.set(id, first.rec)
      continue
    }
    for (const [, it] of [...distinct].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const derived = dedupeId({ ...wireOf(it), id }, taken)
      if (derived === null) {
        noFreeId(acc, wireOf(it))
        continue
      }
      assigned.add(derived)
      out.set(derived, { ...it.rec, id: derived })
      acc.deduped++
    }
    tombs.set(id, joinTomb(tombs.get(id) ?? 0, 0))
  }
  return out
}

/** The first raw element of each id (one pass; only built when a row needs its original). */
function firstById(list: unknown): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>()
  if (!Array.isArray(list)) return out
  for (const el of list) {
    const id = isPlainObject(el) ? own(el, 'id') : undefined
    if (typeof id === 'string' && !out.has(id)) out.set(id, el)
  }
  return out
}

function decodeUnsafe(raw: unknown, origin: Origin, opts: DecodeOptions): SanitizeResult {
  const at = opts.at ?? 0
  const acc = newAcc(at, origin)
  const local = origin === 'local-envelope' || origin === 'local-v4' || origin === 'snapshot'
  if (!isPlainObject(raw)) {
    acc.quarantined.push({ at, origin, reason: 'invalid-payload', raw: rawText(raw) })
    return emptyResult('invalid', acc)
  }
  const legacyRank = opts.legacyRank ?? 0
  const shape = classify(raw, origin)
  const writer: WriterClass =
    origin === 'local-v4'
      ? legacyRank === 1
        ? 'v085'
        : 'v084'
      : local && shape === 'invalid'
        ? 'v5'
        : shape
  if (!local) {
    if (writer === 'moved' || writer === 'e2e') return emptyResult(writer, acc)
    if (writer === 'invalid') {
      acc.quarantined.push({ at, origin, reason: 'invalid-payload', raw: rawText(raw) })
      return emptyResult('invalid', acc)
    }
  }
  const srcRank = srcRankOf(origin, writer, legacyRank)
  const x5raw = own(raw, 'x5')
  const x5 = isPlainObject(x5raw) ? x5raw : null
  if (x5raw !== undefined && x5 === null) drop(acc, 'x5', x5raw)

  const list = own(raw, 'expenses')
  if (list !== undefined && !Array.isArray(list)) drop(acc, 'expenses', list)
  const items = decodeExpenses(Array.isArray(list) ? list : [], origin, srcRank, opts.reuse, acc)
  const tombs = decodeTombs(raw, x5, acc)
  const renames = decodeRenames(x5, acc)
  const expenses = dedupe(items, tombs, acc)

  // Live and tombstoned (§8.2): migrated local data shows such a record, so it stays visible under a
  // revived id; a fold leaves the id out (see DecodeOptions.fold); anywhere else the tombstone wins,
  // as in v4. Whatever does not stay live keeps its original in the report.
  const revive = local && opts.fold !== true
  const res = resolver(renames)
  const both: string[] = []
  for (const id of expenses.keys()) if (tombs.has(id)) both.push(id)
  const original = both.length > 0 && !revive ? firstById(list) : null
  for (const id of both) {
    const rec = expenses.get(id)
    if (rec === undefined) continue
    expenses.delete(id)
    if (!revive) {
      if (opts.fold === true) tombs.delete(id)
      acc.liveAndDeleted++
      const copy = original?.get(id) ?? encodeRecord(rec)
      acc.repairs.push({ at, origin, reason: LIVE_AND_DELETED, raw: rawText(copy) })
      continue
    }
    const content = contentKey(rec, res(rec.c.v))
    const derived = reviveId(rec, res(rec.c.v), (x) => {
      if (tombs.has(x)) return true
      const other = expenses.get(x)
      return other !== undefined && contentKey(other, res(other.c.v)) !== content
    })
    if (derived === null) {
      noFreeId(acc, encodeRecord(rec))
      continue
    }
    expenses.set(derived, { ...rec, id: derived })
    acc.liveAndDeleted++
  }

  const legacyTs = new Map<string, number>()
  if (!local && (writer === 'v084' || writer === 'v085') && Array.isArray(list)) {
    for (const el of list) {
      const id = isPlainObject(el) ? own(el, 'id') : undefined
      if (typeof id === 'string' && !legacyTs.has(id)) legacyTs.set(id, v08ts(el))
    }
  }
  const rev = x5 === null ? null : own(x5, 'rev')
  const doc: Doc = {
    expenses,
    tombs,
    categories: decodeCategories(raw, acc),
    renames,
    mappings: decodeMappings(raw, x5, acc),
    budgets: decodeBudgets(raw, origin, acc),
    prefs: decodePrefs(x5, acc),
    devices: decodeDevices(raw, x5, acc),
  }
  return {
    doc: share(doc, opts.reuse),
    writer,
    report: report(acc),
    legacyTs,
    rev: typeof rev === 'string' ? rev : null,
  }
}

function sameMap<V>(
  a: ReadonlyMap<string, V>,
  b: ReadonlyMap<string, V>,
  eq: (x: V, y: V) => boolean,
): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (w === undefined || !eq(v, w)) return false
  }
  return true
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((n, i) => n === b[i]))

/**
 * P-21 decode reuse, per collection: a decoded collection equal to the reuse doc's is replaced by
 * that very object (and the whole doc by `reuse` when all are), so a pull of our own last push is
 * a no-op merge with every cache warm.
 */
function share(doc: Doc, reuse: Doc | undefined): Doc {
  if (reuse === undefined) return doc
  const out: Doc = {
    expenses: sameMap(doc.expenses, reuse.expenses, (x, y) => x === y)
      ? reuse.expenses
      : doc.expenses,
    tombs: sameMap(doc.tombs, reuse.tombs, (x, y) => x === y) ? reuse.tombs : doc.tombs,
    categories: sameList(doc.categories, reuse.categories) ? reuse.categories : doc.categories,
    renames: sameMap(doc.renames, reuse.renames, (x, y) => x.to === y.to && x.s === y.s)
      ? reuse.renames
      : doc.renames,
    mappings: sameMap(doc.mappings, reuse.mappings, (x, y) => x.v === y.v && x.s === y.s)
      ? reuse.mappings
      : doc.mappings,
    budgets: sameMap(
      doc.budgets,
      reuse.budgets,
      (x, y) => x.value === y.value && x.set === y.set && x.del === y.del,
    )
      ? reuse.budgets
      : doc.budgets,
    prefs: sameMap(doc.prefs, reuse.prefs, (x, y) => x.s === y.s && canon(x.v) === canon(y.v))
      ? reuse.prefs
      : doc.prefs,
    devices: sameMap(
      doc.devices,
      reuse.devices,
      (x, y) =>
        x.name === y.name &&
        x.app === y.app &&
        x.mode === y.mode &&
        x.rpcSince === y.rpcSince &&
        x.e2e === y.e2e &&
        x.seen === y.seen,
    )
      ? reuse.devices
      : doc.devices,
  }
  const all =
    out.expenses === reuse.expenses &&
    out.tombs === reuse.tombs &&
    out.categories === reuse.categories &&
    out.renames === reuse.renames &&
    out.mappings === reuse.mappings &&
    out.budgets === reuse.budgets &&
    out.prefs === reuse.prefs &&
    out.devices === reuse.devices
  return all ? reuse : out
}

/** §8.2 sanitizeDoc. Total: an internal error yields an empty doc plus a report entry. */
export function decodeWire(raw: unknown, origin: Origin, opts: DecodeOptions = {}): SanitizeResult {
  try {
    return decodeUnsafe(raw, origin, opts)
  } catch {
    const acc = newAcc(opts.at ?? 0, origin)
    acc.quarantined.push({ at: acc.at, origin, reason: 'internal', raw: rawText(raw) })
    return emptyResult('invalid', acc)
  }
}

// ── encode ──────────────────────────────────────────────────────────────────────────────────
// Collections are immutable, so every wire piece is memoised per collection identity: a commit
// re-encodes only what it touched (§9.12), and the JSON text is assembled from cached strings.

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function memo<K extends object, V>(cache: WeakMap<K, V>, key: K, build: (k: K) => V): V {
  let v = cache.get(key)
  if (v === undefined) {
    v = build(key)
    cache.set(key, v)
  }
  return v
}

/** A null-prototype object built in sorted key order (never `obj[k] = v` on user keys). */
function objectOf<V>(pairs: Iterable<readonly [string, V]>): Readonly<Record<string, V>> {
  const out = nullRecord<V>()
  for (const [k, v] of [...pairs].sort(([a], [b]) => cmpText(a, b))) {
    Object.defineProperty(out, k, { value: v, enumerable: true })
  }
  return Object.freeze(out)
}

/** A wire object and its JSON text. */
interface Piece<T> {
  readonly obj: T
  readonly json: string
}
const piece = <T>(obj: T): Piece<T> => ({ obj, json: JSON.stringify(obj) })

interface TombPieces {
  /** Oldest first by (stamp, id): a capped v0.8 client keeps the newest deletions (§6.3). */
  readonly order: readonly (readonly [string, Stamp])[]
  readonly ids: Piece<readonly string[]>
  readonly dts: Piece<readonly Stamp[]>
}
const tombCache = new WeakMap<ReadonlyMap<string, Stamp>, TombPieces>()
const tombPieces = (t: ReadonlyMap<string, Stamp>): TombPieces =>
  memo(tombCache, t, () => {
    const order = [...t].sort(([a, s], [b, u]) => s - u || cmpText(a, b))
    return {
      order,
      ids: piece(Object.freeze(order.map(([id]) => id))),
      dts: piece(Object.freeze(order.map(([, s]) => s))),
    }
  })

interface MappingPieces {
  readonly values: Piece<Readonly<Record<string, string>>>
  readonly stamps: Piece<Readonly<Record<string, Stamp>>>
}
const mapCache = new WeakMap<ReadonlyMap<string, MapReg>, MappingPieces>()
const mappingPieces = (m: ReadonlyMap<string, MapReg>): MappingPieces =>
  memo(mapCache, m, () => {
    const stamps: [string, Stamp][] = []
    for (const [k, g] of m) if (g.s > 0) stamps.push([k, g.s])
    return {
      values: piece(objectOf([...m].map(([k, g]) => [k, g.v] as const))),
      stamps: piece(objectOf(stamps)),
    }
  })

interface BudgetPieces {
  readonly budgets: Piece<Readonly<Record<string, number>>>
  readonly budgetUpdatedAt: Piece<Readonly<Record<string, string>>>
  readonly budgetDeletedAt: Piece<Readonly<Record<string, string>>>
}
const budgetCache = new WeakMap<ReadonlyMap<string, BudgetReg>, BudgetPieces>()
/**
 * §6.7 on the wire: a value only when shown; its stamp whenever a value exists (1970 for stamp 0, so
 * v0.8 never reads an unstamped legacy value as new via its exportDate fallback); deletions > 0.
 * A value-less register with a set stamp also emits its stamp (v0.8 reads it as "set, no value"),
 * so every canonical register round-trips.
 */
const budgetPieces = (b: ReadonlyMap<string, BudgetReg>): BudgetPieces =>
  memo(budgetCache, b, () => {
    const values: [string, number][] = []
    const sets: [string, string][] = []
    const dels: [string, string][] = []
    for (const [k, g] of b) {
      if (g.value !== null && isBudgetShown(g)) values.push([k, g.value])
      if (g.value !== null || g.set > 0) sets.push([k, g.set > 0 ? iso(g.set) : LEGACY_EPOCH_ISO])
      if (g.del > 0) dels.push([k, iso(g.del)])
    }
    return {
      budgets: piece(objectOf(values)),
      budgetUpdatedAt: piece(objectOf(sets)),
      budgetDeletedAt: piece(objectOf(dels)),
    }
  })

const renCache = new WeakMap<
  ReadonlyMap<string, RenameReg>,
  Piece<Readonly<Record<string, readonly [Stamp, string | null]>>>
>()
const renPiece = (r: ReadonlyMap<string, RenameReg>): Piece<X5Block['ren']> =>
  memo(renCache, r, () =>
    piece(objectOf([...r].map(([k, g]) => [k, Object.freeze([g.s, g.to] as const)] as const))),
  )

const prefCache = new WeakMap<ReadonlyMap<string, PrefReg>, Piece<X5Block['pref']>>()
const prefPiece = (p: ReadonlyMap<string, PrefReg>): Piece<X5Block['pref']> =>
  memo(prefCache, p, () =>
    piece(objectOf([...p].map(([k, g]) => [k, Object.freeze([g.s, g.v] as const)] as const))),
  )

const devCache = new WeakMap<
  ReadonlyMap<string, DeviceInfo>,
  Piece<Readonly<Record<string, WireDevice>>>
>()
const devPiece = (
  d: ReadonlyMap<string, DeviceInfo>,
): Piece<Readonly<Record<string, WireDevice>>> =>
  memo(devCache, d, () => {
    const pairs: [string, WireDevice][] = []
    for (const [id, x] of d) {
      pairs.push([
        id,
        Object.freeze({
          n: x.name,
          app: x.app,
          m: x.mode,
          e: x.e2e ? 1 : 0,
          rs: x.rpcSince ?? 0,
          at: x.seen,
        } as const),
      ])
    }
    return piece(objectOf(pairs))
  })

const catCache = new WeakMap<readonly string[], string>()
const categoriesJson = (c: readonly string[]): string => memo(catCache, c, (x) => JSON.stringify(x))

const recordsCache = new WeakMap<ReadonlyMap<string, ExpenseRec>, readonly ExpenseRec[]>()

/** Live records in wire order (sorted by id), demo rows omitted on a demo build (P-9). */
function liveRecords(doc: Doc, omit: ((id: string) => boolean) | undefined): readonly ExpenseRec[] {
  const build = (): readonly ExpenseRec[] => {
    const recs: ExpenseRec[] = []
    for (const id of sortedIdsOf(doc.expenses)) {
      const rec = doc.expenses.get(id)
      if (rec !== undefined && (omit === undefined || !omit(id))) recs.push(rec)
    }
    return recs
  }
  return omit === undefined ? memo(recordsCache, doc.expenses, build) : build()
}

/** The `expenses` JSON array; without an omit filter it is the cached O(changed) text. */
const recordsJson = (doc: Doc, omit: ((id: string) => boolean) | undefined): string =>
  omit === undefined
    ? recordsJsonOf(doc.expenses)
    : `[${liveRecords(doc, omit).map(recordString).join(',')}]`

interface Parts {
  readonly exportDate: string
  readonly tombs: TombPieces
  readonly mappings: MappingPieces
  readonly budgets: BudgetPieces
  readonly x5: X5Block
  readonly x5Json: () => string
}

function parts(doc: Doc, opts: EncodeOptions, file: boolean): Parts {
  const tombs = tombPieces(doc.tombs)
  const mappings = mappingPieces(doc.mappings)
  const ren = renPiece(doc.renames)
  const pref = prefPiece(doc.prefs)
  const devs = file ? null : devPiece(doc.devices)
  const dev = file ? undefined : opts.dev
  const rev = file ? undefined : opts.rev
  const min = opts.min ?? PLAIN_MIN
  const dig = digestDoc(doc)
  const x5: X5Block = {
    schema: SCHEMA,
    minor: SCHEMA_MINOR,
    min,
    ...(dev === undefined ? {} : { dev }),
    ...(rev === undefined ? {} : { rev }),
    dig,
    dts: tombs.dts.obj,
    ren: ren.obj,
    mts: mappings.stamps.obj,
    pref: pref.obj,
    ...(devs === null ? {} : { devs: devs.obj }),
  }
  // exactly JSON.stringify(x5): the same keys in the same order, from cached member texts
  const x5Json = (): string =>
    `{"schema":${JSON.stringify(SCHEMA)},"minor":${JSON.stringify(SCHEMA_MINOR)}` +
    `,"min":${JSON.stringify(min)}` +
    (dev === undefined ? '' : `,"dev":${JSON.stringify(dev)}`) +
    (rev === undefined ? '' : `,"rev":${JSON.stringify(rev)}`) +
    `,"dig":${JSON.stringify(dig)},"dts":${tombs.dts.json},"ren":${ren.json}` +
    `,"mts":${mappings.stamps.json},"pref":${pref.json}` +
    (devs === null ? '' : `,"devs":${devs.json}`) +
    '}'
  return {
    exportDate: iso(maxStampDoc(doc)),
    tombs,
    mappings,
    budgets: budgetPieces(doc.budgets),
    x5,
    x5Json,
  }
}

/** The relay payload (§10.1, P-15): v4-valid, records sorted by id, tombstones oldest first. */
export function encodeWire(doc: Doc, opts: EncodeOptions = {}): WireDocV5 {
  const p = parts(doc, opts, false)
  return {
    version: '4.0',
    exportDate: p.exportDate,
    expenses: liveRecords(doc, opts.omitIds).map(encodeRecord),
    categories: doc.categories,
    categoryMappings: p.mappings.values.obj,
    budgets: p.budgets.budgets.obj,
    budgetUpdatedAt: p.budgets.budgetUpdatedAt.obj,
    budgetDeletedAt: p.budgets.budgetDeletedAt.obj,
    deletedIds: p.tombs.ids.obj,
    x5: p.x5,
  }
}

/** JSON.stringify(encodeWire(doc, opts)), assembled from cached record and collection strings. */
export function wireString(doc: Doc, opts: EncodeOptions = {}): string {
  const p = parts(doc, opts, false)
  return (
    `{"version":"4.0","exportDate":${JSON.stringify(p.exportDate)}` +
    `,"expenses":${recordsJson(doc, opts.omitIds)}` +
    `,"categories":${categoriesJson(doc.categories)}` +
    `,"categoryMappings":${p.mappings.values.json}` +
    `,"budgets":${p.budgets.budgets.json}` +
    `,"budgetUpdatedAt":${p.budgets.budgetUpdatedAt.json}` +
    `,"budgetDeletedAt":${p.budgets.budgetDeletedAt.json}` +
    `,"deletedIds":${p.tombs.ids.json}` +
    `,"x5":${p.x5Json()}}`
  )
}

/** The v5 backup file (§10.6): v0.8.4 parseBackup accepts it; x5 omits dev, rev and devs. */
export function encodeBackupFile(
  doc: Doc,
  opts: Pick<EncodeOptions, 'omitIds'> = {},
): BackupFileV5 {
  const p = parts(doc, opts, true)
  return {
    spendtrack: 'backup',
    version: '5.0',
    exportDate: p.exportDate,
    expenses: liveRecords(doc, opts.omitIds).map(encodeRecord),
    categories: doc.categories,
    categoryMappings: p.mappings.values.obj,
    budgets: p.budgets.budgets.obj,
    budgetUpdatedAt: p.budgets.budgetUpdatedAt.obj,
    budgetDeletedAt: p.budgets.budgetDeletedAt.obj,
    deletedIds: p.tombs.ids.obj,
    x5: p.x5,
  }
}

export const wireChars = (doc: Doc, opts: EncodeOptions = {}): number =>
  wireString(doc, opts).length

/** The relay size meter (F-016): warn from 70 %, refuse to push above WIRE_PUSH_MAX. */
export const sizeClass = (chars: number): SizeClass =>
  chars > WIRE_PUSH_MAX ? 'too-large' : chars >= WIRE_WARN ? 'warn' : 'ok'

/** §10.5: the retired-row marker. v0.8.4- throws on it before any push; v0.8.5 and v5 pause. */
export function movedMarker(why: 'private' | 'rotated' | 'stopped', atIso: string): MovedMarker {
  return {
    version: '4.0',
    expenses: 'moved',
    categories: [],
    categoryMappings: {},
    x5: { schema: SCHEMA, minor: SCHEMA_MINOR, min: MOVED_MIN, moved: { at: atIso, why } },
  }
}

// ── v4 keys: the mirror (§9.10) and the way back in (P-22) ──────────────────────────────────

/** The v4 projection of the doc, as the seven key strings. Write them in MIRROR_ORDER. */
export function toV4Mirror(
  doc: Doc,
  opts: Pick<EncodeOptions, 'omitIds'> = {},
): Readonly<Record<V4Key, string>> {
  const res = resolver(doc.renames)
  const mappings: [string, string][] = []
  for (const [k, g] of doc.mappings) {
    const target = res(g.v)
    if (res(target) === target) mappings.push([k, target])
  }
  const b = budgetPieces(doc.budgets)
  return {
    categoryBudgetDeletedAt: b.budgetDeletedAt.json,
    categoryBudgets: b.budgets.json,
    categoryBudgetUpdatedAt: b.budgetUpdatedAt.json,
    categoryMappings: JSON.stringify(objectOf(mappings)),
    categories: JSON.stringify(displayList(doc)),
    deletedExpenseIds: tombPieces(doc.tombs).ids.json,
    expenses: recordsJson(doc, opts.omitIds),
  }
}

/** fnv36 of the seven strings joined in MIRROR_ORDER (a missing key counts as NUL). */
export function mirrorSum(strings: Readonly<Partial<Record<V4Key, string | null>>>): string {
  return fnv36(MIRROR_ORDER.map((k) => strings[k] ?? '\u0000').join('\n'))
}

/** Already-parsed v4 key values → the raw v4-shaped object for decodeWire(…, 'local-v4'). */
export function fromV4Keys(
  parsed: Readonly<Partial<Record<V4Key, unknown>>>,
): Readonly<Record<string, unknown>> {
  return {
    version: '4.0',
    expenses: parsed.expenses ?? [],
    categories: parsed.categories,
    categoryMappings: parsed.categoryMappings,
    budgets: parsed.categoryBudgets,
    budgetUpdatedAt: parsed.categoryBudgetUpdatedAt,
    budgetDeletedAt: parsed.categoryBudgetDeletedAt,
    deletedIds: parsed.deletedExpenseIds,
  }
}

// ── old-writer news (§11.4, P-11) ───────────────────────────────────────────────────────────

type Outcome = number | null

/** v0.8 mergeBackups' budget rule for one key, on the wire projection of two registers. */
function v4BudgetOutcome(local: BudgetReg | undefined, remote: BudgetReg | undefined): Outcome {
  const shown = (g: BudgetReg | undefined): Outcome =>
    g !== undefined && isBudgetShown(g) ? g.value : null
  // budgetUpdatedAt is on the wire whenever a value or a set stamp exists; v0.8 reads 1970 as 0
  const setTs = (g: BudgetReg | undefined): number => g?.set ?? 0
  const delTs = (g: BudgetReg | undefined): number => g?.del ?? 0
  const del = Math.max(delTs(local), delTs(remote))
  const set = Math.max(setTs(local), setTs(remote))
  if (del > 0 && del >= set) return null
  if (set > 0) return setTs(local) >= setTs(remote) ? shown(local) : shown(remote)
  return shown(local) ?? shown(remote)
}

/**
 * Would a v0.8 client holding the relay doc `relay` keep anything from our merged doc `m`?
 * Mimics its mergeBackups exactly (local = the relay copy, remote = our push).
 */
export function adoptableNews(m: Doc, relay: SanitizeResult): boolean {
  const r = relay.doc
  for (const [id, rec] of m.expenses) {
    const theirs = r.expenses.get(id)
    if (theirs === undefined) {
      if (!r.tombs.has(id)) return true
      continue
    }
    const ours = v08ts(encodeRecord(rec))
    const tsRelay = relay.legacyTs.get(id) ?? v08ts(encodeRecord(theirs))
    if (!(tsRelay >= ours)) return true
  }
  for (const id of m.tombs.keys()) if (r.expenses.has(id)) return true
  for (const k of new Set([...m.budgets.keys(), ...r.budgets.keys()])) {
    const theirs = r.budgets.get(k)
    const before = theirs !== undefined && isBudgetShown(theirs) ? theirs.value : null
    if (v4BudgetOutcome(theirs, m.budgets.get(k)) !== before) return true
  }
  const listed = new Set(r.categories)
  for (const n of m.categories) if (!listed.has(n)) return true
  for (const k of m.mappings.keys()) if (!r.mappings.has(k)) return true
  return false
}
