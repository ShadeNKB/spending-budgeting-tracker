// The document join (DATA-ENGINE-SPEC §6.1–§6.9, P-13). Pure and total for sanitised docs.
// Absence is never deletion: a record leaves only through a tombstone. Every untouched collection
// and record keeps its identity, and a no-op merge returns the left doc itself (F-002, T-002-2).
import { joinBudget, resolver } from './categories'
import { FNV_A, FNV_B, canon, fnvLane, hex8 } from './hash'
import {
  lostFields,
  materialize,
  maxStampRec,
  mergeRecord,
  recordHashes,
  recordString,
} from './record'
import type {
  BudgetReg,
  DeviceInfo,
  Doc,
  ExpenseRec,
  MapReg,
  MergeReplaced,
  MergeResult,
  PrefReg,
  RenameReg,
  Stamp,
} from './types'

export const EMPTY_DOC: Doc = Object.freeze({
  expenses: new Map<string, ExpenseRec>(),
  tombs: new Map<string, Stamp>(),
  categories: Object.freeze([]),
  renames: new Map<string, RenameReg>(),
  mappings: new Map<string, MapReg>(),
  budgets: new Map(),
  prefs: new Map<string, PrefReg>(),
  devices: new Map<string, DeviceInfo>(),
})

/**
 * Per-key union of two maps; `join` must return one of its inputs when the result equals it.
 * Returns `l` itself when nothing changes, and `r` itself when `l` is empty.
 */
export function keyUnion<V>(
  l: ReadonlyMap<string, V>,
  r: ReadonlyMap<string, V>,
  join: (a: V, b: V) => V,
): ReadonlyMap<string, V> {
  if (l === r || r.size === 0) return l
  if (l.size === 0) return r
  let out: Map<string, V> | null = null
  for (const [k, rv] of r) {
    const lv = l.get(k)
    const j = lv === undefined ? rv : join(lv, rv)
    if (j === lv) continue
    out ??= new Map(l)
    out.set(k, j)
  }
  return out ?? l
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** LWW by (s, live first, larger target): a join (§6.5.2). */
export const joinRename = (a: RenameReg, b: RenameReg): RenameReg => {
  if (a.s !== b.s) return a.s > b.s ? a : b
  const al = a.to === null ? 1 : 0
  const bl = b.to === null ? 1 : 0
  if (al !== bl) return al > bl ? a : b
  return cmpText(a.to ?? '', b.to ?? '') >= 0 ? a : b
}

/** The minimum non-zero stamp: a join that also yields the first deletion time (§6.3). */
export const joinTomb = (a: Stamp, b: Stamp): Stamp => (a === 0 ? b : b === 0 ? a : Math.min(a, b))

export const joinMap = (a: MapReg, b: MapReg): MapReg =>
  a.s !== b.s ? (a.s > b.s ? a : b) : cmpText(a.v, b.v) >= 0 ? a : b

export const joinPref = (a: PrefReg, b: PrefReg): PrefReg =>
  a.s !== b.s ? (a.s > b.s ? a : b) : cmpText(canon(a.v), canon(b.v)) >= 0 ? a : b

const deviceRest = (d: DeviceInfo): string =>
  canon({ name: d.name, app: d.app, mode: d.mode, rpcSince: d.rpcSince, e2e: d.e2e })

export const joinDevice = (a: DeviceInfo, b: DeviceInfo): DeviceInfo =>
  a.seen !== b.seen ? (a.seen > b.seen ? a : b) : cmpText(deviceRest(a), deviceRest(b)) >= 0 ? a : b

function unionList(l: readonly string[], r: readonly string[]): readonly string[] {
  if (l === r || r.length === 0) return l
  const have = new Set(l)
  let out: string[] | null = null
  for (const n of r) {
    if (have.has(n)) continue
    have.add(n)
    out ??= [...l]
    out.push(n)
  }
  return out ?? l
}

/**
 * mergeDoc(L, R): L's live records and R's, per-field joined after materialising both through the
 * merged rename table. `removed` = L-live records killed by a tombstone; `replaced` = L records
 * whose value changed; `editAfterDelete` = R copies edited after their (known) deletion.
 */
export function mergeDoc(L: Doc, R: Doc): MergeResult {
  if (L === R) return { doc: L, removed: [], replaced: [], editAfterDelete: [] }
  const renames = keyUnion(L.renames, R.renames, joinRename)
  const tombs = keyUnion(L.tombs, R.tombs, joinTomb)
  const res = resolver(renames)
  const removed: ExpenseRec[] = []
  const replaced: MergeReplaced[] = []
  const editAfterDelete: ExpenseRec[] = []
  const set: ExpenseRec[] = []
  const drop: string[] = []

  for (const [id, a] of L.expenses) {
    if (tombs.has(id)) {
      removed.push(a)
      drop.push(id)
      continue
    }
    const b = R.expenses.get(id)
    const a2 = materialize(a, res)
    // mergeRecord returns its left side on equality, so an unchanged record keeps its identity
    const m = b === undefined ? a2 : mergeRecord(a2, materialize(b, res))
    if (m === a) continue
    set.push(m)
    const fields = lostFields(a2, m)
    if (fields.length > 0) replaced.push({ before: a2, after: m, fields })
  }
  for (const [id, b] of R.expenses) {
    if (L.expenses.has(id)) continue
    const t = tombs.get(id)
    if (t !== undefined) {
      if (t > 0 && maxStampRec(b) > t) editAfterDelete.push(b)
      continue
    }
    set.push(materialize(b, res))
  }

  const expenses = deriveExpenses(L.expenses, set, drop)
  const categories = unionList(L.categories, R.categories)
  const mappings = keyUnion(L.mappings, R.mappings, joinMap)
  const budgets = keyUnion(L.budgets, R.budgets, joinBudget)
  const prefs = keyUnion(L.prefs, R.prefs, joinPref)
  const devices = keyUnion(L.devices, R.devices, joinDevice)
  const same =
    expenses === L.expenses &&
    tombs === L.tombs &&
    categories === L.categories &&
    renames === L.renames &&
    mappings === L.mappings &&
    budgets === L.budgets &&
    prefs === L.prefs &&
    devices === L.devices
  const doc: Doc = same
    ? L
    : { expenses, tombs, categories, renames, mappings, budgets, prefs, devices }
  return { doc, removed, replaced, editAfterDelete }
}

// ── records-map facts, kept in O(changed) per commit (§9.12) ───────────────────────────────

type Records = ReadonlyMap<string, ExpenseRec>
/** One changed id: the record before and after (undefined = absent on that side). */
type Change = readonly [string, ExpenseRec | undefined, ExpenseRec | undefined]

interface Derivation {
  readonly parent: Records
  readonly delta: readonly Change[]
}

/** What a records map was derived from, until its facts are computed (then the parent is let go). */
const derivations = new WeakMap<Records, Derivation>()

/**
 * `parent` without `drop`, then with `set`: the one way ops and merges build a new records map.
 * It remembers the delta, so the digest sums, the max stamp and the sorted id list of the result
 * cost O(changed) instead of O(n). Returns `parent` itself when nothing changes.
 */
export function deriveExpenses(
  parent: Records,
  set: readonly ExpenseRec[],
  drop: readonly string[] = [],
): Records {
  const ids = new Set<string>(drop)
  for (const rec of set) ids.add(rec.id)
  const out = new Map(parent)
  for (const id of drop) out.delete(id)
  for (const rec of set) out.set(rec.id, rec)
  let changed = false
  for (const id of ids) if (out.get(id) !== parent.get(id)) changed = true
  if (!changed) return parent
  // an unresolved parent is skipped: the delta is taken against the last map with known facts
  const pending = derivations.get(parent)
  const base = pending === undefined ? parent : pending.parent
  if (pending !== undefined) for (const [id] of pending.delta) ids.add(id)
  const delta: Change[] = []
  for (const id of ids) {
    const before = base.get(id)
    const after = out.get(id)
    if (before !== after) delta.push([id, before, after])
  }
  derivations.set(out, { parent: base, delta })
  return out
}

interface Facts {
  /** Per-lane record hash sums mod 2³² (P-13). */
  readonly sums: readonly [number, number]
  /** Max stamp over the records. */
  readonly max: Stamp
  /** Ids in code-unit order: the wire order of `expenses` (P-15). */
  readonly ids: readonly string[]
}

const factsCache = new WeakMap<Records, Facts>()

function fullFacts(m: Records): Facts {
  let a = 0
  let b = 0
  let max = 0
  for (const rec of m.values()) {
    const [ha, hb] = recordHashes(rec)
    a = (a + ha) >>> 0
    b = (b + hb) >>> 0
    max = Math.max(max, maxStampRec(rec))
  }
  return { sums: [a, b], max, ids: [...m.keys()].sort(cmpText) }
}

/** Binary-search position of `id` in a sorted list. */
function slot(ids: readonly string[], id: string): number {
  let lo = 0
  let hi = ids.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((ids[mid] ?? '') < id) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** More insertions than this fall back to one sort. */
const SPLICE_MAX = 64

function derivedFacts(p: Facts, delta: readonly Change[], m: Records): Facts {
  let [a, b] = p.sums
  let max = p.max
  let maxLost = false
  const removed = new Set<string>()
  const added: string[] = []
  for (const [id, before, after] of delta) {
    if (before !== undefined) {
      const [ha, hb] = recordHashes(before)
      a = (a - ha) >>> 0
      b = (b - hb) >>> 0
      const s = maxStampRec(before)
      if (s >= p.max && (after === undefined || maxStampRec(after) < s)) maxLost = true
      if (after === undefined) removed.add(id)
    }
    if (after !== undefined) {
      const [ha, hb] = recordHashes(after)
      a = (a + ha) >>> 0
      b = (b + hb) >>> 0
      max = Math.max(max, maxStampRec(after))
      if (before === undefined) added.push(id)
    }
  }
  if (maxLost) {
    max = 0
    for (const rec of m.values()) max = Math.max(max, maxStampRec(rec))
  }
  if (added.length > SPLICE_MAX) return { sums: [a, b], max, ids: [...m.keys()].sort(cmpText) }
  if (removed.size === 0 && added.length === 0) return { sums: [a, b], max, ids: p.ids }
  const ids = removed.size > 0 ? p.ids.filter((id) => !removed.has(id)) : [...p.ids]
  for (const id of added) ids.splice(slot(ids, id), 0, id)
  return { sums: [a, b], max, ids }
}

function facts(m: Records): Facts {
  const hit = factsCache.get(m)
  if (hit !== undefined) return hit
  const d = derivations.get(m)
  let f: Facts
  if (d === undefined) f = fullFacts(m)
  else {
    const p = facts(d.parent)
    f = derivedFacts(p, d.delta, m)
    const pt = textCache.get(d.parent)
    if (pt !== undefined && d.delta.length <= SPLICE_MAX) {
      textCache.set(m, spliceText(pt, p.ids, d.delta))
    }
  }
  factsCache.set(m, f)
  derivations.delete(m)
  return f
}

/** The ids of a records map in wire order (sorted by code unit), cached per map. */
export const sortedIdsOf = (m: Records): readonly string[] => facts(m).ids

// ── the records' JSON text, also O(changed) (the envelope and the wire both embed it) ───────

interface RecordsText {
  /** `[` + every record string in id order, comma-separated + `]`. */
  readonly json: string
  /** Where each record string starts in `json`, aligned with the sorted ids. */
  readonly starts: readonly number[]
}

const textCache = new WeakMap<Records, RecordsText>()

function fullText(m: Records): RecordsText {
  const starts: number[] = []
  const parts: string[] = []
  let at = 1
  for (const id of facts(m).ids) {
    const rec = m.get(id)
    if (rec === undefined) continue
    const s = recordString(rec)
    starts.push(at)
    parts.push(s)
    at += s.length + 1
  }
  return { json: `[${parts.join(',')}]`, starts }
}

/** Applies a delta to the parent's text by slicing: a few string slices instead of a 5,000-way join. */
function spliceText(
  pt: RecordsText,
  parentIds: readonly string[],
  delta: readonly Change[],
): RecordsText {
  const ids = [...parentIds]
  const starts = [...pt.starts]
  let json = pt.json
  const remove = (at: number): void => {
    const s0 = starts[at] ?? 0
    const next = starts[at + 1]
    if (next !== undefined) {
      // the record and its trailing comma
      const cut = next - s0
      json = json.slice(0, s0) + json.slice(next)
      for (let i = at + 1; i < starts.length; i++) starts[i] = (starts[i] ?? 0) - cut
    } else if (at > 0) {
      // the last record and the comma before it
      json = json.slice(0, s0 - 1) + json.slice(json.length - 1)
    } else json = '[]'
    starts.splice(at, 1)
    ids.splice(at, 1)
  }
  const insert = (at: number, id: string, str: string): void => {
    const c = starts[at]
    if (c !== undefined) {
      json = json.slice(0, c) + str + ',' + json.slice(c)
      for (let i = at; i < starts.length; i++) starts[i] = (starts[i] ?? 0) + str.length + 1
      starts.splice(at, 0, c)
    } else if (starts.length > 0) {
      const end = json.length - 1
      json = `${json.slice(0, end)},${str}]`
      starts.push(end + 1)
    } else {
      json = `[${str}]`
      starts.push(1)
    }
    ids.splice(at, 0, id)
  }
  for (const [id, before, after] of delta) {
    if (before !== undefined) remove(slot(ids, id))
    if (after !== undefined) insert(slot(ids, id), id, recordString(after))
  }
  return { json, starts }
}

/** The JSON array of every record in wire order (sorted by id), cached per records map. */
export function recordsJsonOf(m: Records): string {
  facts(m)
  let t = textCache.get(m)
  if (t === undefined) {
    t = fullText(m)
    textCache.set(m, t)
  }
  return t.json
}

// ── digest (P-13: persisted in the envelope, so frozen) ─────────────────────────────────────

const sortedPairs = <V, W>(m: ReadonlyMap<string, V>, f: (v: V) => W): (readonly [string, W])[] =>
  [...m].sort(([a], [b]) => cmpText(a, b)).map(([k, v]) => [k, f(v)] as const)

const str = (v: string | number): string => JSON.stringify(v)

/** canon() of a list whose items are rendered by `item` (the large collections, hand-unrolled). */
const listText = <T>(items: readonly T[], item: (x: T) => string): string =>
  `[${items.map(item).join(',')}]`

/** canon() of one collection's digest form, cached per collection identity. */
function pieceOf<C extends object>(
  cache: WeakMap<C, string>,
  c: C,
  text: (c: C) => string,
): string {
  let t = cache.get(c)
  if (t === undefined) {
    t = text(c)
    cache.set(c, t)
  }
  return t
}

const tombText = new WeakMap<ReadonlyMap<string, Stamp>, string>()
const catText = new WeakMap<readonly string[], string>()
const renText = new WeakMap<ReadonlyMap<string, RenameReg>, string>()
const mapText = new WeakMap<ReadonlyMap<string, MapReg>, string>()
const budText = new WeakMap<ReadonlyMap<string, BudgetReg>, string>()
const prefText = new WeakMap<ReadonlyMap<string, PrefReg>, string>()
const devText = new WeakMap<ReadonlyMap<string, DeviceInfo>, string>()

/**
 * Canonical text of everything but the records (devices without `seen`): exactly
 * canon([tombs, categories, renames, mappings, budgets, prefs, devices]), assembled from pieces.
 */
function restText(doc: Doc): string {
  const pieces = [
    pieceOf(tombText, doc.tombs, (t) =>
      listText(
        [...t].sort(([a], [b]) => cmpText(a, b)),
        ([id, s]) => `[${str(id)},${str(s)}]`,
      ),
    ),
    pieceOf(catText, doc.categories, (c) => canon([...new Set(c)].sort(cmpText))),
    pieceOf(renText, doc.renames, (m) => canon(sortedPairs(m, (g) => g))),
    pieceOf(mapText, doc.mappings, (m) =>
      listText(
        sortedPairs(m, (g) => g),
        ([k, g]) => `[${str(k)},{"s":${str(g.s)},"v":${str(g.v)}}]`,
      ),
    ),
    pieceOf(budText, doc.budgets, (m) => canon(sortedPairs(m, (g) => g))),
    pieceOf(prefText, doc.prefs, (m) => canon(sortedPairs(m, (g) => g))),
    pieceOf(devText, doc.devices, (m) =>
      canon(
        sortedPairs(m, (d) => ({
          name: d.name,
          app: d.app,
          mode: d.mode,
          rpcSince: d.rpcSince,
          e2e: d.e2e,
        })),
      ),
    ),
  ]
  return `[${pieces.join(',')}]`
}

const digestCache = new WeakMap<Doc, string>()

/**
 * Two FNV-1a lanes: per lane the record hashes summed mod 2³² (order-independent, incremental),
 * combined with the lane hash of the canonical rest. 16 hex chars.
 */
export function digestDoc(doc: Doc): string {
  const hit = digestCache.get(doc)
  if (hit !== undefined) return hit
  const [ra, rb] = facts(doc.expenses).sums
  const rest = restText(doc)
  const ca = fnvLane(rest, FNV_A)
  const cb = fnvLane(rest, FNV_B)
  const digest = hex8(fnvLane(`${ra}|${ca}`, FNV_A)) + hex8(fnvLane(`${rb}|${cb}`, FNV_B))
  digestCache.set(doc, digest)
  return digest
}

export const docsEqual = (a: Doc, b: Doc): boolean => a === b || digestDoc(a) === digestDoc(b)

const maxCache = new WeakMap<Doc, Stamp>()

/** The largest stamp in the doc (devices' `seen` excluded): the wire exportDate (P-15). */
export function maxStampDoc(doc: Doc): Stamp {
  const hit = maxCache.get(doc)
  if (hit !== undefined) return hit
  let m = facts(doc.expenses).max
  for (const s of doc.tombs.values()) m = Math.max(m, s)
  for (const g of doc.renames.values()) m = Math.max(m, g.s)
  for (const g of doc.mappings.values()) m = Math.max(m, g.s)
  for (const g of doc.budgets.values()) m = Math.max(m, g.set, g.del)
  for (const g of doc.prefs.values()) m = Math.max(m, g.s)
  maxCache.set(doc, m)
  return m
}
