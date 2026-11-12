// What counts as spending, and the month's budget for all of it (T8a, F-057): two synced
// preferences on the doc's generic register, so the wire, the merge and the backup file carry them
// unchanged, and a device on an older version keeps them without reading them.
//
//   aside     the categories set aside: money moved, not spent (investments, savings, transfers).
//             Their entries stay in the Ledger and leave every total, pace and budget.
//   monthCap  one budget for the whole month's spending.
//
// A preference is last-writer-wins as a whole: two devices changing the set-aside list inside one
// sync round keep the later change only. It is a list set once and seldom touched.
import { displayList } from '../core/categories'
import { AMOUNT_MAX, OTHER } from '../core/constants'
import * as ops from '../core/ops'
import type { Doc, OpCtx, OpResult } from '../core/types'

export const ASIDE_KEY = 'aside'
export const MONTH_CAP_KEY = 'monthCap'

const NONE: readonly string[] = Object.freeze([])

/** The names as stored. Anything but a list of names (a newer or a damaged value) reads as none. */
function storedAside(doc: Doc): readonly string[] {
  const v = doc.prefs.get(ASIDE_KEY)?.v
  if (!Array.isArray(v)) return NONE
  const names: string[] = []
  for (const n of v) {
    if (typeof n !== 'string') return NONE
    names.push(n)
  }
  return names
}

/**
 * The set-aside categories that show, in display order. A stored name counts only while it is a
 * category on screen under that very name: one that was renamed, merged or deleted elsewhere (an
 * older version, a restored file) is counted as spending again rather than passed on to whatever
 * took its entries. "Other" always counts: deleted categories' entries land there.
 */
export function asideView(doc: Doc): readonly string[] {
  const stored = storedAside(doc)
  if (stored.length === 0) return NONE
  const names = new Set(stored)
  const shown = displayList(doc).filter((n) => n !== OTHER && names.has(n))
  return shown.length === 0 ? NONE : shown
}

/** The whole-month budget: an amount a budget may hold, else none. */
export function monthCapView(doc: Doc): number | null {
  const v = doc.prefs.get(MONTH_CAP_KEY)?.v
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= AMOUNT_MAX ? v : null
}

const asideValue = (names: readonly string[]): readonly string[] | null =>
  names.length === 0 ? null : [...names].sort()

/** Sets a category aside, or counts it as spending again. Names no longer on screen leave the list. */
export function setAside(doc: Doc, ctx: OpCtx, category: string, on: boolean): OpResult {
  if (category === OTHER) {
    throw new ops.OpError('other-locked', '"Other" always counts as spending.')
  }
  if (!displayList(doc).includes(category)) {
    throw new ops.OpError('not-found', 'That category no longer exists.')
  }
  const now = asideView(doc)
  if (now.includes(category) === on) return { doc, touched: [] }
  const next = on ? [...now, category] : now.filter((n) => n !== category)
  return ops.setPref(
    doc,
    ctx,
    ASIDE_KEY,
    asideValue(next),
    on ? `"${category}" set aside` : `"${category}" counted as spending`,
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
    amount === null ? 'Monthly budget removed' : 'Monthly budget set',
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

/**
 * The core's rename, and a set-aside category stays set aside under its new name. A merge into a
 * category already on screen does not pass it on: that one keeps its own answer.
 */
export function renameCategory(doc: Doc, ctx: OpCtx, from: string, to: string): OpResult {
  const before = asideView(doc)
  const name = to.trim()
  const merging = displayList(doc).includes(name)
  const res = ops.renameCategory(doc, ctx, from, to)
  if (!before.includes(from)) return res
  const next = before.filter((n) => n !== from)
  if (!merging && name !== OTHER) next.push(name)
  return also(res, ops.setPref(res.doc, ctx, ASIDE_KEY, asideValue(next), ''))
}

/** The core's delete; the name leaves the set-aside list with it, so a later one starts counted. */
export function removeCategory(doc: Doc, ctx: OpCtx, name: string): OpResult {
  const before = asideView(doc)
  const res = ops.removeCategory(doc, ctx, name)
  if (!before.includes(name)) return res
  return also(
    res,
    ops.setPref(res.doc, ctx, ASIDE_KEY, asideValue(before.filter((n) => n !== name)), ''),
  )
}
