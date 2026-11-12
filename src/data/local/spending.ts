// What counts as spending, and the month's budget for all of it (T8a, F-057): synced preferences
// on the doc's generic register, so the wire, the merge and the backup file carry them unchanged,
// and a device on an older version keeps them without reading them.
//
//   aside_<hash>  one register per category that is not spending: money moved, not spent
//                 (investments, savings, transfers). It holds the category's name, or null once the
//                 category counts again. Its entries stay in the Ledger and leave every total, pace
//                 and budget. The app's word for it is "not spending"; "set aside" is taken
//                 (unreadable entries kept under Needs attention), and `aside` is only the key.
//   monthCap      one budget for the whole month's spending.
//
// One register per category, not one list: two devices that each change a different category
// while apart keep both changes, and a rename's Undo takes back its own two registers only.
import { displayList } from '../core/categories'
import { AMOUNT_MAX, OTHER } from '../core/constants'
import { FNV_A, FNV_B, fnvLane } from '../core/hash'
import * as ops from '../core/ops'
import type { Doc, OpCtx, OpResult } from '../core/types'

export const ASIDE_PREFIX = 'aside_'
export const MONTH_CAP_KEY = 'monthCap'

/** The register of a category: two 32-bit lanes of its name, so the key fits a preference's. */
export const asideKey = (category: string): string =>
  `${ASIDE_PREFIX}${fnvLane(category, FNV_A).toString(36)}_${fnvLane(category, FNV_B).toString(36)}`

const NONE: readonly string[] = Object.freeze([])

/**
 * The names as stored: every register that holds the very name its key is made of. Anything else
 * under the prefix (a newer or a damaged value) is not a name.
 */
function storedAside(doc: Doc): ReadonlySet<string> {
  const names = new Set<string>()
  for (const [key, reg] of doc.prefs) {
    if (key.startsWith(ASIDE_PREFIX) && typeof reg.v === 'string' && asideKey(reg.v) === key) {
      names.add(reg.v)
    }
  }
  return names
}

/**
 * The not-spending categories that show, in display order. A stored name counts only while it is a
 * category on screen under that very name: one that was renamed, merged or deleted elsewhere (an
 * older version, a restored file) is counted as spending again rather than passed on to whatever
 * took its entries. "Other" always counts: deleted categories' entries land there.
 */
export function asideView(doc: Doc): readonly string[] {
  const stored = storedAside(doc)
  if (stored.size === 0) return NONE
  const shown = displayList(doc).filter((n) => n !== OTHER && stored.has(n))
  return shown.length === 0 ? NONE : shown
}

/** The whole-month budget: an amount a budget may hold, else none. */
export function monthCapView(doc: Doc): number | null {
  const v = doc.prefs.get(MONTH_CAP_KEY)?.v
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= AMOUNT_MAX ? v : null
}

const write = (doc: Doc, ctx: OpCtx, category: string, on: boolean, label = ''): OpResult =>
  ops.setPref(doc, ctx, asideKey(category), on ? category : null, label)

/** Marks a category not spending, or counts it again. */
export function setAside(doc: Doc, ctx: OpCtx, category: string, on: boolean): OpResult {
  if (category === OTHER) {
    throw new ops.OpError('other-locked', '"Other" always counts as spending.')
  }
  if (!displayList(doc).includes(category)) {
    throw new ops.OpError('not-found', 'That category no longer exists.')
  }
  if (storedAside(doc).has(category) === on) return { doc, touched: [] }
  return write(
    doc,
    ctx,
    category,
    on,
    on ? `"${category}" no longer counts as spending` : `"${category}" counts as spending again`,
  )
}

/** Sets the whole-month budget, or removes it (`null`). */
export function setMonthCap(doc: Doc, ctx: OpCtx, amount: number | null): OpResult {
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > AMOUNT_MAX)) {
    throw new ops.OpError('budget', 'Amount must be greater than 0 and at most 10,000,000.')
  }
  return ops.setPref(
    doc,
    ctx,
    MONTH_CAP_KEY,
    amount,
    amount === null ? 'Whole month budget removed' : 'Whole month budget set',
  )
}

/** `b` in the same commit as `a`, under `a`'s undo entry: its Undo takes both back. */
function also(a: OpResult, b: OpResult): OpResult {
  const touched = [...a.touched, ...b.touched]
  if (a.undo === undefined || b.undo === undefined) return { ...a, doc: b.doc, touched }
  return {
    ...a,
    doc: b.doc,
    touched,
    undo: { ...a.undo, items: [...a.undo.items, ...b.undo.items] },
  }
}

/** A name that is not on screen and still holds an answer from an earlier category of that name. */
const staleAnswer = (doc: Doc, name: string): boolean =>
  storedAside(doc).has(name) && !displayList(doc).includes(name)

/**
 * The core's add. A name that comes back starts counted, whatever an earlier category of that
 * name was (one deleted by a version that does not know these registers leaves its answer behind).
 */
export function addCategory(doc: Doc, ctx: OpCtx, raw: string): OpResult {
  const name = raw.trim()
  const stale = staleAnswer(doc, name)
  const res = ops.addCategory(doc, ctx, raw)
  return stale ? also(res, write(res.doc, ctx, name, false)) : res
}

/**
 * The core's rename, and a not-spending category stays one under its new name. A merge into a
 * category already on screen does not pass it on: that one keeps its own answer. A counted
 * category keeps counting under a name that held an old answer.
 */
export function renameCategory(doc: Doc, ctx: OpCtx, from: string, to: string): OpResult {
  const wasAside = asideView(doc).includes(from)
  const name = to.trim()
  const merging = displayList(doc).includes(name)
  const stale = staleAnswer(doc, name)
  let res = ops.renameCategory(doc, ctx, from, to)
  if (!wasAside) return stale ? also(res, write(res.doc, ctx, name, false)) : res
  res = also(res, write(res.doc, ctx, from, false))
  return !merging && name !== OTHER ? also(res, write(res.doc, ctx, name, true)) : res
}

/** The core's delete; the category's answer goes with it, so a later one of that name starts counted. */
export function removeCategory(doc: Doc, ctx: OpCtx, name: string): OpResult {
  const wasAside = asideView(doc).includes(name)
  const res = ops.removeCategory(doc, ctx, name)
  return wasAside ? also(res, write(res.doc, ctx, name, false)) : res
}
