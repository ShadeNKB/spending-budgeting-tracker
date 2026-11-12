// What the screens read (track spec §6.1, §8.10; F-010): views over the doc, memoised per record
// and per collection identity. An unchanged record keeps its ExpenseView object and an unchanged
// collection keeps its array or record, so selectors and memos keyed on identity never fire for a
// change elsewhere. Every record view is null-prototype keyed by user text.
import { budgetView, displayList, liveMappingEntries, resolver } from '../core/categories'
import { CURRENCY_KEY, DEMO_PREFIX, nullRecord } from '../core/constants'
import { dayOf } from '../core/dates'
import { maxStampRec } from '../core/record'
import { iso } from '../core/stamp'
import type { Doc, ExpenseRec } from '../core/types'
import type { ExpenseView } from '../../types'
import { asideView, monthCapView } from './spending'

export interface Views {
  readonly expenses: readonly ExpenseView[]
  readonly categories: readonly string[]
  readonly categoryMappings: Readonly<Record<string, string>>
  readonly budgets: Readonly<Record<string, number>>
  /** The categories that are not spending, in display order. */
  readonly asideCategories: readonly string[]
  /** The budget for the whole month's spending, when one is set. */
  readonly monthBudget: number | null
  /** The synced currency register, when it holds a code. */
  readonly syncedCurrency: string | null
  readonly hasDemoRows: boolean
}

const viewCache = new WeakMap<ExpenseRec, ExpenseView>()

function viewOf(rec: ExpenseRec, category: string): ExpenseView {
  const hit = viewCache.get(rec)
  if (hit?.category === category) return hit
  const U = maxStampRec(rec)
  const view: ExpenseView = {
    id: rec.id,
    itemName: rec.n.v,
    amount: rec.a.v,
    category,
    date: rec.d.v.date,
    day: dayOf(rec),
    ...(rec.o.v === null ? {} : { notes: rec.o.v }),
    createdAt: rec.createdAt,
    ...(U > rec.C ? { updatedAt: iso(U) } : {}),
    ext: rec.x.v,
  }
  viewCache.set(rec, view)
  return view
}

/** Live entries, newest day first, then newest created, then id. */
function cmpView(a: ExpenseView, b: ExpenseView, ca: number, cb: number): number {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1
  if (ca !== cb) return cb - ca
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

/** Stamps of the views in the current list (the sort key), kept beside it. */
const createdOf = new WeakMap<ExpenseView, number>()

function sortedViews(doc: Doc): ExpenseView[] {
  const res = resolver(doc.renames)
  const pairs: (readonly [ExpenseView, number])[] = []
  for (const rec of doc.expenses.values()) {
    const v = viewOf(rec, res(rec.c.v))
    createdOf.set(v, rec.C)
    pairs.push([v, rec.C])
  }
  pairs.sort((a, b) => cmpView(a[0], b[0], a[1], b[1]))
  return pairs.map((p) => p[0])
}

/** Changed records below this count are spliced in; above it the list is sorted again. */
const SPLICE_MAX = 48

interface Delta {
  /** Records that are new or replaced in the next map. */
  readonly changed: readonly ExpenseRec[]
  /** Ids of the previous map that are gone or replaced. */
  readonly gone: readonly ExpenseRec[]
}

/**
 * The delta between two record maps, walking both in insertion order: core's deriveExpenses keeps
 * the parent's order, drops removed ids and appends new ones, so an op or a merge costs one pass
 * without hashing. Null when the orders diverge (a freshly decoded map) or the delta is too big.
 */
function walkDelta(prev: Doc['expenses'], next: Doc['expenses']): Delta | null {
  const changed: ExpenseRec[] = []
  const gone: ExpenseRec[] = []
  const it = next.values()
  let cur = it.next()
  for (const p of prev.values()) {
    if (cur.done === true || cur.value.id !== p.id) {
      if (next.has(p.id)) return null
      gone.push(p)
    } else {
      if (cur.value !== p) {
        changed.push(cur.value)
        gone.push(p)
      }
      cur = it.next()
    }
    if (gone.length > SPLICE_MAX) return null
  }
  for (; cur.done !== true; cur = it.next()) {
    changed.push(cur.value)
    if (changed.length > SPLICE_MAX) return null
  }
  return { changed, gone }
}

/** The same delta by lookups, for maps in any order. Null when it is too big. */
function lookupDelta(prev: Doc['expenses'], next: Doc['expenses']): Delta | null {
  const changed: ExpenseRec[] = []
  const gone: ExpenseRec[] = []
  for (const rec of next.values()) {
    const before = prev.get(rec.id)
    if (before === rec) continue
    changed.push(rec)
    if (before !== undefined) gone.push(before)
    if (changed.length > SPLICE_MAX) return null
  }
  for (const rec of prev.values()) {
    if (!next.has(rec.id)) gone.push(rec)
    if (gone.length > SPLICE_MAX) return null
  }
  return { changed, gone }
}

/** Where `v` sits (or would sit) in a list sorted by cmpView. */
function slotOf(list: readonly ExpenseView[], v: ExpenseView, created: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const m = list[mid]
    if (m !== undefined && cmpView(m, v, createdOf.get(m) ?? 0, created) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The list after a commit: a few changed records are spliced in and out by binary search (an add
 * on 5,000 rows must stay inside the 8 ms commit budget, §8.12); anything larger is rebuilt and
 * sorted. Unchanged records keep their view objects either way.
 */
function nextExpenses(
  doc: Doc,
  prevDoc: Doc | null,
  prev: readonly ExpenseView[],
): readonly ExpenseView[] {
  if (prevDoc === null) return sortedViews(doc)
  if (prevDoc.expenses === doc.expenses && prevDoc.renames === doc.renames) return prev
  if (prevDoc.renames !== doc.renames) {
    const all = sortedViews(doc)
    return sameList(all, prev) ? prev : all
  }
  const delta =
    walkDelta(prevDoc.expenses, doc.expenses) ?? lookupDelta(prevDoc.expenses, doc.expenses)
  if (delta === null) return sortedViews(doc)
  if (delta.changed.length === 0 && delta.gone.length === 0) return prev
  const res = resolver(doc.renames)
  const out = prev.slice()
  for (const rec of delta.gone) {
    // the rename table is unchanged here, so this is the view object the list holds
    const old = viewOf(rec, res(rec.c.v))
    const at = slotOf(out, old, rec.C)
    if (out[at] !== old) return sortedViews(doc)
    out.splice(at, 1)
  }
  for (const rec of delta.changed) {
    const v = viewOf(rec, res(rec.c.v))
    createdOf.set(v, rec.C)
    out.splice(slotOf(out, v, rec.C), 0, v)
  }
  return out
}

function mappingsView(doc: Doc): Readonly<Record<string, string>> {
  const out = nullRecord<string>()
  for (const [k, v] of liveMappingEntries(doc)) out[k] = v
  return out
}

function budgetsView(doc: Doc): Readonly<Record<string, number>> {
  const out = nullRecord<number>()
  for (const [k, v] of Object.entries(budgetView(doc))) out[k] = v
  return out
}

function currencyOf(doc: Doc): string | null {
  const v = doc.prefs.get(CURRENCY_KEY)?.v
  return typeof v === 'string' ? v : null
}

function hasDemo(doc: Doc): boolean {
  for (const id of doc.expenses.keys()) if (id.startsWith(DEMO_PREFIX)) return true
  return false
}

/**
 * The views of `doc`, reusing every piece of `prev` whose inputs are unchanged. With `prev` from
 * the same doc it returns `prev` itself.
 */
export function buildViews(
  doc: Doc,
  prevDoc: Doc | null,
  prev: Views | null,
  demoBuild: boolean,
): Views {
  if (prev !== null && prevDoc === doc) return prev
  const expenses = nextExpenses(doc, prevDoc, prev?.expenses ?? [])
  const cats = displayList(doc)
  const sameCats = prev !== null && sameList(cats, prev.categories)
  const categories = prev !== null && sameCats ? prev.categories : cats
  const sameRenames = prevDoc !== null && prevDoc.renames === doc.renames
  // a mapping's view depends on the mappings and the rename table only (liveMappingEntries)
  const maps =
    prev !== null && sameRenames && prevDoc.mappings === doc.mappings
      ? prev.categoryMappings
      : mappingsView(doc)
  const categoryMappings =
    prev !== null && sameRecord(maps, prev.categoryMappings) ? prev.categoryMappings : maps
  // a budget's view depends on the display list, the budgets and the rename table (budgetView)
  const buds =
    prev !== null && sameCats && sameRenames && prevDoc.budgets === doc.budgets
      ? prev.budgets
      : budgetsView(doc)
  const budgets = prev !== null && sameRecord(buds, prev.budgets) ? prev.budgets : buds
  // the not-spending names depend on their preference and on the display list
  const aside =
    prev !== null && sameCats && prevDoc?.prefs === doc.prefs
      ? prev.asideCategories
      : asideView(doc)
  const asideCategories =
    prev !== null && sameList(aside, prev.asideCategories) ? prev.asideCategories : aside
  return {
    expenses,
    categories,
    categoryMappings,
    budgets,
    asideCategories,
    monthBudget: monthCapView(doc),
    syncedCurrency: currencyOf(doc),
    hasDemoRows: demoBuild && hasDemo(doc),
  }
}
