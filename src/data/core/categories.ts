// Categories, the rename table, and the views resolved through it (DATA-ENGINE-SPEC §6.5–§6.7,
// F-012, P-8). Rows are never re-stamped by a rename; budgets and mappings resolve when read.
import { OTHER, nullRecord } from './constants'
import { validMapKey } from './sanitize'
import type { BudgetReg, Doc, RenameReg } from './types'

/** A longer chain only exists in hostile data; resolution stops there (still deterministic). */
const HOP_MAX = 32

const IDENTITY = (name: string): string => name
const resolvers = new WeakMap<ReadonlyMap<string, RenameReg>, (name: string) => string>()

function resolveUncached(renames: ReadonlyMap<string, RenameReg>, name: string): string {
  const path: string[] = []
  let cur = name
  for (let hop = 0; hop < HOP_MAX; hop++) {
    const e = renames.get(cur)
    if (e === undefined || e.to === null) return cur
    const at = path.indexOf(cur)
    if (at >= 0) return path.slice(at).reduce((a, b) => (b < a ? b : a))
    path.push(cur)
    cur = e.to
  }
  return cur
}

/** Follows name → to → … (a cycle resolves to its smallest name). Memoised per table object. */
export function resolver(renames: ReadonlyMap<string, RenameReg>): (name: string) => string {
  if (renames.size === 0) return IDENTITY
  let fn = resolvers.get(renames)
  if (fn === undefined) {
    const memo = new Map<string, string>()
    fn = (name: string): string => {
      let to = memo.get(name)
      if (to === undefined) {
        to = resolveUncached(renames, name)
        memo.set(name, to)
      }
      return to
    }
    resolvers.set(renames, fn)
  }
  return fn
}

export const resolve = (doc: Doc, name: string): string => resolver(doc.renames)(name)
export const isLive = (doc: Doc, name: string): boolean => resolve(doc, name) === name

const displayCache = new WeakMap<Doc, readonly string[]>()

/**
 * Listed live names (doc order), then names of live records not yet listed (newest record first,
 * then id), then 'Other'. An entry is never hidden: its category always shows (§6.5.4).
 */
export function displayList(doc: Doc): readonly string[] {
  const hit = displayCache.get(doc)
  if (hit !== undefined) return hit
  const res = resolver(doc.renames)
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of doc.categories) {
    if (res(n) === n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  const newest = new Map<string, { readonly C: number; readonly id: string }>()
  for (const rec of doc.expenses.values()) {
    const n = res(rec.c.v)
    if (seen.has(n)) continue
    const best = newest.get(n)
    if (best === undefined || rec.C > best.C || (rec.C === best.C && rec.id < best.id)) {
      newest.set(n, { C: rec.C, id: rec.id })
    }
  }
  const extra = [...newest].sort(([, p], [, q]) => q.C - p.C || (p.id < q.id ? -1 : 1))
  for (const [n] of extra) {
    seen.add(n)
    out.push(n)
  }
  if (!seen.has(OTHER)) out.push(OTHER)
  const frozen = Object.freeze(out)
  displayCache.set(doc, frozen)
  return frozen
}

// ── budgets (§6.7) ──────────────────────────────────────────────────────────────────────────

/**
 * value/set by maxBy(set, value ?? −1); del by max. A hidden register keeps no value: a hidden value
 * can never show again (only a larger `set` can, and it brings its own value), and the v4 wire
 * cannot carry it, so the canonical form is `value: null` (keeps replicas byte-equal).
 * Returns an input when the result equals it.
 */
export function joinBudget(p: BudgetReg, q: BudgetReg): BudgetReg {
  const pv = p.value ?? -1
  const qv = q.value ?? -1
  const top = p.set > q.set || (p.set === q.set && pv >= qv) ? p : q
  const del = Math.max(p.del, q.del)
  const value = top.value !== null && !(del > 0 && del >= top.set) ? top.value : null
  if (value === p.value && top.set === p.set && del === p.del) return p
  if (value === q.value && top.set === q.set && del === q.del) return q
  return { value, set: top.set, del }
}

/** Exactly the v4 rule (a tie goes to the deletion). Named so Tailwind's scanner sees no utility. */
export const isBudgetShown = (g: BudgetReg): boolean =>
  g.value !== null && !(g.del > 0 && g.del >= g.set)

interface Source {
  readonly key: string
  readonly reg: BudgetReg
}

const sourceCache = new WeakMap<Doc, ReadonlyMap<string, Source>>()

/** For each live name: the budget key it shows (its own key first, else the max inherited one). */
function sources(doc: Doc): ReadonlyMap<string, Source> {
  const hit = sourceCache.get(doc)
  if (hit !== undefined) return hit
  const res = resolver(doc.renames)
  const byName = new Map<string, Source>()
  for (const [key, reg] of doc.budgets) {
    if (!isBudgetShown(reg)) continue
    const live = res(key)
    const cur = byName.get(live)
    if (cur === undefined || key === live) {
      byName.set(live, { key, reg })
      continue
    }
    if (cur.key === live) continue
    const a = cur.reg
    const better =
      reg.set > a.set ||
      (reg.set === a.set &&
        ((reg.value ?? 0) > (a.value ?? 0) || (reg.value === a.value && key > cur.key)))
    if (better) byName.set(live, { key, reg })
  }
  sourceCache.set(doc, byName)
  return byName
}

/** The budget key behind a live category's budget, or null. */
export const budgetSource = (doc: Doc, live: string): string | null =>
  sources(doc).get(live)?.key ?? null

const viewCache = new WeakMap<Doc, Readonly<Record<string, number>>>()

/** One budget per displayed category, null-prototype; a rename never doubles a budget (F-012). */
export function budgetView(doc: Doc): Readonly<Record<string, number>> {
  const hit = viewCache.get(doc)
  if (hit !== undefined) return hit
  const src = sources(doc)
  const out = nullRecord<number>()
  for (const name of displayList(doc)) {
    const s = src.get(name)
    if (s !== undefined && s.reg.value !== null) {
      Object.defineProperty(out, name, { value: s.reg.value, enumerable: true })
    }
  }
  const frozen = Object.freeze(out)
  viewCache.set(doc, frozen)
  return frozen
}

export function totalBudget(doc: Doc): number {
  const view = budgetView(doc)
  let total = 0
  for (const k of Object.keys(view)) total += view[k] ?? 0
  return total
}

// ── mappings (§6.6, P-8) ────────────────────────────────────────────────────────────────────

export const mappingKey = (itemName: string): string => itemName.trim().toLowerCase()

/** Exact lookup only (fuzzy stays in the adapter). A stale mapping never files into a dead name. */
export function mappingLookup(doc: Doc, itemName: string): string | null {
  const key = mappingKey(itemName)
  if (!validMapKey(key)) return null
  const reg = doc.mappings.get(key)
  if (reg === undefined) return null
  const res = resolver(doc.renames)
  const target = res(reg.v)
  return res(target) === target ? target : null
}

/** [key, live target] pairs sorted by key: the corpus for the adapter's fuzzy matcher. */
export function liveMappingEntries(doc: Doc): readonly (readonly [string, string])[] {
  const res = resolver(doc.renames)
  const out: (readonly [string, string])[] = []
  for (const [k, reg] of doc.mappings) {
    const target = res(reg.v)
    if (res(target) === target) out.push([k, target])
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
