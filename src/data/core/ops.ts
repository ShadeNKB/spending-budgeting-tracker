// Every user mutation as (doc, ctx, input) → OpResult (DATA-ENGINE-SPEC §7; P-8, P-9, P-18, P-19).
// Inputs are validated with the sanitiser's predicates and bad input throws OpError; an op that
// changes nothing returns the same doc and writes no stamp. Undo is a guarded forward write.
import {
  budgetSource,
  budgetView,
  displayList,
  isBudgetShown,
  mappingKey,
  mappingLookup,
  resolver,
} from './categories'
import {
  AMOUNT_MAX,
  CATEGORY_MAX,
  CURRENCY_KEY,
  DEMO_PREFIX,
  FIELD_KEYS,
  LIVE_AND_DELETED,
  NAME_MAX,
  NOTES_INPUT_MAX,
  OTHER,
  UNDO_MS,
  isReserved,
} from './constants'
import { dayOf, isDateText, localNoonIso, todayDay, validDay } from './dates'
import { EMPTY_DOC, deriveExpenses, joinRename, keyUnion, mergeDoc } from './doc'
import { canon } from './hash'
import { contentKey, dedupeRoot, newId, newRev, reviveId, rootKey } from './ids'
import {
  addRecord,
  editRecord,
  materialize,
  maxStampRec,
  mergeRecord,
  recEqual,
  reviveRecord,
  type RecordPatch,
} from './record'
import { validCurrency, validMapKey, validName } from './sanitize'
import { tick } from './stamp'
import type {
  BudgetReg,
  Doc,
  ExpensePatch,
  ExpenseRec,
  FieldKey,
  ImportPlan,
  NewExpenseInput,
  OpCtx,
  OpResult,
  OutboxKey,
  PrefReg,
  Reg,
  RegKey,
  RenameReg,
  SanitizeResult,
  Stamp,
  UndoEntry,
  UndoField,
  UndoItem,
} from './types'

export type OpErrorCode =
  | 'name'
  | 'amount'
  | 'category'
  | 'day'
  | 'notes'
  | 'budget'
  | 'currency'
  | 'not-found'
  | 'reserved'
  | 'other-locked'
  | 'same-name'
  | 'newer-file'
  | 'too-many'

/** A user-readable rejection; `code` lets the UI localise later (T7). */
export class OpError extends Error {
  readonly code: OpErrorCode
  constructor(code: OpErrorCode, message: string) {
    super(message)
    this.name = 'OpError'
    this.code = code
  }
}

type Touched = (readonly [OutboxKey, Stamp])[]

// ── validation (P-18) ───────────────────────────────────────────────────────────────────────

function checkName(raw: string): string {
  const name = raw.trim()
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new OpError('name', 'Item name must be 1 to 200 characters.')
  }
  return name
}

function checkAmount(a: number, code: 'amount' | 'budget' = 'amount'): number {
  if (!Number.isFinite(a) || a <= 0 || a > AMOUNT_MAX) {
    throw new OpError(code, 'Amount must be greater than 0 and at most 10,000,000.')
  }
  return a
}

/** A name the doc already holds: listed, in the rename table, or shown for a live record. */
const knownName = (doc: Doc, name: string): boolean =>
  doc.categories.includes(name) || doc.renames.has(name) || displayList(doc).includes(name)

/** A NEW name is capped at CATEGORY_MAX; a longer one the doc already holds (v0.8) stays usable. */
function checkCategory(doc: Doc, raw: string): string {
  const name = raw.trim()
  if (isReserved(name)) throw new OpError('reserved', 'That name is reserved. Choose another.')
  if (!validName(name) || (name.length > CATEGORY_MAX && !knownName(doc, name))) {
    throw new OpError('category', 'Category names are 1 to 60 characters.')
  }
  return name
}

/**
 * A real day whose stored instant (its local noon) the sanitiser accepts too: in the zones farthest
 * from UTC, local noon of 1970-01-01 or 2099-12-31 is an instant outside 1970–2099, and such a record
 * would be quarantined on its next read and push on every cycle.
 */
function checkDay(day: string): string {
  if (!validDay(day) || !isDateText(localNoonIso(day))) {
    throw new OpError('day', 'Choose a real date between 1970 and 2099.')
  }
  return day
}

function checkNotes(notes: string): string | null {
  if (notes.length > NOTES_INPUT_MAX)
    throw new OpError('notes', 'Notes are at most 500 characters.')
  return notes === '' ? null : notes
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const result = (doc: Doc, touched: Touched, undo?: UndoEntry): OpResult =>
  undo === undefined ? { doc, touched } : { doc, touched, undo }

const unchanged = (doc: Doc): OpResult => ({ doc, touched: [] })

const entry = (ctx: OpCtx, label: string, items: readonly UndoItem[]): UndoEntry => ({
  id: newRev(ctx.rng),
  label,
  expiresAt: ctx.wall + UNDO_MS,
  items,
})

const isDemo = (ctx: OpCtx, id: string): boolean =>
  ctx.demoBuild === true && id.startsWith(DEMO_PREFIX)

function listed(doc: Doc, name: string): readonly string[] {
  return doc.categories.includes(name) ? doc.categories : [...doc.categories, name]
}

const withExpenses = (
  doc: Doc,
  set: readonly ExpenseRec[],
  drop: readonly string[] = [],
): ReadonlyMap<string, ExpenseRec> => deriveExpenses(doc.expenses, set, drop)

/** Materialise every live record through a rename table (no stamps change, §6.5.3). */
function materializeAll(
  expenses: ReadonlyMap<string, ExpenseRec>,
  renames: ReadonlyMap<string, RenameReg>,
): ReadonlyMap<string, ExpenseRec> {
  const res = resolver(renames)
  const moved: ExpenseRec[] = []
  for (const rec of expenses.values()) {
    const m = materialize(rec, res)
    if (m !== rec) moved.push(m)
  }
  return deriveExpenses(expenses, moved)
}

/** taken(id) of §4.3 against a doc: tombstoned, or live with different content. */
function takenIn(doc: Doc, content: string): (id: string) => boolean {
  const res = resolver(doc.renames)
  return (id) => {
    if (doc.tombs.has(id)) return true
    const live = doc.expenses.get(id)
    return live !== undefined && contentKey(live, res(live.c.v)) !== content
  }
}

/**
 * Re-creates `rec` under its deterministic revive id; null when an identical copy is already live,
 * or when every revive id is taken (§4.3; the caller skips and counts it).
 */
function revive(doc: Doc, rec: ExpenseRec, ctx: OpCtx): ExpenseRec | null {
  const res = resolver(doc.renames)
  const category = res(rec.c.v)
  const id = reviveId(rec, category, takenIn(doc, contentKey(rec, category)))
  if (id === null || doc.expenses.has(id)) return null
  return materialize(reviveRecord(rec, id, ctx), res)
}

/**
 * Is a file row that dedupe split off a shared id (`<root>~d…`, §7.9) already here as a live row of
 * the same root with identical content? Restoring it would then count that money twice (F-047).
 * The index of live rows by root is built on first use: most files hold no dedupe-derived row.
 */
function dedupedCopyHere(doc: Doc, res: (name: string) => string): (rec: ExpenseRec) => boolean {
  let index: Map<string, Set<string>> | null = null
  return (rec) => {
    const root = dedupeRoot(rec.id)
    if (root === null) return false
    if (index === null) {
      const built = new Map<string, Set<string>>()
      for (const live of doc.expenses.values()) {
        const key = rootKey(live.id)
        const set = built.get(key) ?? new Set<string>()
        set.add(contentKey(live, res(live.c.v)))
        built.set(key, set)
      }
      index = built
    }
    return index.get(root)?.has(contentKey(rec, res(rec.c.v))) === true
  }
}

function undoField(rec: ExpenseRec, f: FieldKey, wrote: Stamp): UndoField {
  switch (f) {
    case 'n':
      return { f, prev: rec.n, wrote }
    case 'a':
      return { f, prev: rec.a, wrote }
    case 'c':
      return { f, prev: rec.c, wrote }
    case 'd':
      return { f, prev: rec.d, wrote }
    case 'o':
      return { f, prev: rec.o, wrote }
    case 'x':
      return { f, prev: rec.x, wrote }
  }
}

/** Fields whose register object differs between two versions of a record. */
const changedFields = (before: ExpenseRec, after: ExpenseRec): FieldKey[] =>
  FIELD_KEYS.filter((f) => before[f] !== after[f])

// ── expenses (§7.1, §7.3, §7.6) ─────────────────────────────────────────────────────────────

export function addExpense(doc: Doc, ctx: OpCtx, input: NewExpenseInput): OpResult {
  const name = checkName(input.itemName)
  const amount = checkAmount(input.amount)
  // today is checked too: a device clock outside 1970–2099 must not write an unreadable record
  const day = checkDay(input.day ?? todayDay(ctx.wall))
  const notes = input.notes === undefined ? null : checkNotes(input.notes)
  const res = resolver(doc.renames)
  const category =
    input.category === undefined
      ? (mappingLookup(doc, name) ?? OTHER)
      : res(checkCategory(doc, input.category))
  let id = newId(ctx.rng)
  while (doc.expenses.has(id) || doc.tombs.has(id)) id = newId(ctx.rng)
  const rec = addRecord(id, { n: name, a: amount, c: category, day, o: notes }, ctx)
  const touched: Touched = [[`ex:${id}`, rec.C]]
  const categories = listed(doc, category)
  if (categories !== doc.categories) touched.push([`cat:${category}`, rec.C])
  let mappings = doc.mappings
  const key = mappingKey(name)
  const old = doc.mappings.get(key)
  if (category !== OTHER && validMapKey(key) && (old === undefined || res(old.v) !== category)) {
    const s = tick(ctx.clock, ctx.wall, old?.s ?? 0)
    mappings = new Map(doc.mappings).set(key, { v: category, s })
    touched.push([`map:${key}`, s])
  }
  const next: Doc = { ...doc, expenses: withExpenses(doc, [rec]), categories, mappings }
  const undo = entry(ctx, `Added "${name}"`, [{ k: 'add', id, C: rec.C }])
  return { doc: next, touched, undo, created: rec }
}

export function updateExpense(doc: Doc, ctx: OpCtx, id: string, patch: ExpensePatch): OpResult {
  const rec = doc.expenses.get(id)
  if (rec === undefined) throw new OpError('not-found', 'That entry no longer exists.')
  const res = resolver(doc.renames)
  // a field sent back unchanged is not new input: a longer name or note kept from v0.8, or a day at
  // the edge of the window, never blocks an edit of another field
  const rp: { n?: string; a?: number; c?: string; day?: string; o?: string | null } = {}
  if (patch.itemName !== undefined && patch.itemName !== rec.n.v) rp.n = checkName(patch.itemName)
  if (patch.amount !== undefined) rp.a = checkAmount(patch.amount)
  if (patch.category !== undefined) rp.c = res(checkCategory(doc, patch.category))
  if (patch.day !== undefined && patch.day !== dayOf(rec)) rp.day = checkDay(patch.day)
  if (patch.notes !== undefined && patch.notes !== (rec.o.v ?? '')) rp.o = checkNotes(patch.notes)
  const next = editRecord(rec, rp satisfies RecordPatch, ctx)
  if (next === rec) return unchanged(doc)
  const fields = changedFields(rec, next)
  const t = maxStampRec(next)
  const touched: Touched = [[`ex:${id}`, t]]
  const categories = listed(doc, next.c.v)
  if (categories !== doc.categories) touched.push([`cat:${next.c.v}`, t])
  const undo = entry(ctx, 'Updated expense', [
    { k: 'edit', id, fields: fields.map((f) => undoField(rec, f, next[f].s)) },
  ])
  return result({ ...doc, expenses: withExpenses(doc, [next]), categories }, touched, undo)
}

export function deleteExpenses(doc: Doc, ctx: OpCtx, ids: readonly string[]): OpResult {
  const targets = [...new Set(ids)].flatMap((id) => {
    const rec = doc.expenses.get(id)
    return rec === undefined ? [] : [rec]
  })
  if (targets.length === 0) return unchanged(doc)
  const synced = targets.filter((r) => !isDemo(ctx, r.id))
  const t = synced.length > 0 ? tick(ctx.clock, ctx.wall) : 0
  const tombs = new Map(doc.tombs)
  const touched: Touched = []
  for (const r of synced) {
    tombs.set(r.id, t)
    touched.push([`del:${r.id}`, t])
  }
  const first = targets[0]
  const label =
    targets.length === 1 && first !== undefined
      ? `Deleted "${first.n.v}"`
      : `Deleted ${targets.length} entries`
  const undo = entry(
    ctx,
    label,
    targets.map((prev) => ({ k: 'delete', prev })),
  )
  const next: Doc = {
    ...doc,
    expenses: withExpenses(
      doc,
      [],
      targets.map((r) => r.id),
    ),
    tombs,
  }
  return result(next, touched, undo)
}

/** §7.3: per-id tombstones for exactly the rows this device can see (no watermark). */
export const deleteAllEverywhere = (doc: Doc, ctx: OpCtx): OpResult =>
  deleteExpenses(doc, ctx, [...doc.expenses.keys()])

// ── categories (§7.4) ───────────────────────────────────────────────────────────────────────

const renameStamp = (doc: Doc, name: string): Stamp => doc.renames.get(name)?.s ?? 0
const budgetStamp = (g: BudgetReg | undefined): Stamp =>
  g === undefined ? 0 : Math.max(g.set, g.del)

/** A deletion of a budget key at t (canonical: a hidden register keeps no value). */
const hidden = (g: BudgetReg, t: Stamp): BudgetReg => ({ value: null, set: g.set, del: t })

interface ReAdded {
  readonly doc: Doc
  readonly touched: Touched
  /** Guarded undo items of every budget register written (a rename onto the name carries them). */
  readonly items: readonly UndoItem[]
}

/**
 * Re-add of a renamed-away name (§7.4): `renames[name] := live` and listed. Every budget key that
 * showed under T = resolve(name) and now resolves to `name` (its own key, and any key renamed into it
 * along a chain such as A → name → T) is hidden, and when T's budget came from one of them (so T has
 * no shown key of its own) it is written forward on T. T keeps exactly the budget it showed, the
 * re-added name starts with none, and no budget can show twice (acceptance 13).
 */
function reAdd(doc: Doc, ctx: OpCtx, name: string, reg: RenameReg): ReAdded {
  const before = resolver(doc.renames)
  const after = resolver(new Map(doc.renames).set(name, { to: null, s: reg.s }))
  const target = before(name)
  const moving = [...doc.budgets].filter(([k]) => before(k) === target && after(k) === name)
  const targetOwn = doc.budgets.get(target)
  const base = Math.max(reg.s, budgetStamp(targetOwn), ...moving.map(([, g]) => budgetStamp(g)))
  const t = tick(ctx.clock, ctx.wall, base)
  const touched: Touched = [
    [`ren:${name}`, t],
    [`cat:${name}`, t],
  ]
  // [key, new register, register it replaces]
  const writes: (readonly [string, BudgetReg, BudgetReg | null])[] = []
  const shown = budgetView(doc)[target]
  const source = budgetSource(doc, target)
  if (shown !== undefined && moving.some(([k]) => k === source)) {
    writes.push([target, { value: shown, set: t, del: targetOwn?.del ?? 0 }, targetOwn ?? null])
  }
  for (const [k, g] of moving) if (k === name || isBudgetShown(g)) writes.push([k, hidden(g, t), g])
  const items: UndoItem[] = []
  let budgets = doc.budgets
  if (writes.length > 0) {
    const next = new Map(doc.budgets)
    for (const [k, g, prev] of writes) {
      next.set(k, g)
      touched.push([`bud:${k}`, t])
      items.push({ k: 'reg', key: `bud:${k}`, prev, wrote: t })
    }
    budgets = next
  }
  const renames = new Map(doc.renames).set(name, { to: null, s: t })
  return { doc: { ...doc, renames, budgets, categories: listed(doc, name) }, touched, items }
}

export function addCategory(doc: Doc, ctx: OpCtx, raw: string): OpResult {
  const name = checkCategory(doc, raw)
  const reg = doc.renames.get(name)
  if (reg === undefined || reg.to === null) {
    if (doc.categories.includes(name)) return unchanged(doc)
    const t = tick(ctx.clock, ctx.wall)
    return result({ ...doc, categories: [...doc.categories, name] }, [[`cat:${name}`, t]])
  }
  const r = reAdd(doc, ctx, name, reg)
  return result(r.doc, r.touched)
}

interface Renamed {
  readonly doc: Doc
  readonly items: readonly UndoItem[]
  readonly touched: Touched
}

function renameInto(doc: Doc, ctx: OpCtx, from: string, rawTo: string): Renamed {
  if (from === OTHER) throw new OpError('other-locked', '"Other" cannot be renamed or removed.')
  const to = checkCategory(doc, rawTo)
  if (!displayList(doc).includes(from)) {
    throw new OpError('not-found', 'That category no longer exists.')
  }
  if (to === from) throw new OpError('same-name', 'Choose a different name.')
  // Onto a name that was renamed away: re-add it first (§7.4, so its budget stays where it shows),
  // then merge into it, so the undo sends it back to its old target instead of redirecting it here.
  const toReg = doc.renames.get(to)
  const wasTarget = toReg?.to ?? null
  const re = toReg === undefined || wasTarget === null ? null : reAdd(doc, ctx, to, toReg)
  const cur = re === null ? doc : re.doc
  const existed = displayList(cur).includes(to)
  const t = tick(ctx.clock, ctx.wall, Math.max(renameStamp(cur, from), renameStamp(cur, to)))
  const renames = new Map(cur.renames).set(from, { to, s: t }).set(to, { to: null, s: t })
  const expenses = materializeAll(cur.expenses, renames)
  const moved = [...expenses].filter(([id, rec]) => cur.expenses.get(id) !== rec)
  const item: UndoItem = existed
    ? {
        k: 'recat',
        from,
        into: to,
        ids: moved.map(([id]) => id),
        cWas: moved.map(([, rec]) => rec.c),
        ...(wasTarget === null ? {} : { intoWas: { to: wasTarget, wrote: t } }),
      }
    : { k: 'unrename', from, to, wrote: t }
  const next: Doc = { ...cur, renames, expenses, categories: listed(cur, to) }
  const own: Touched = [
    [`ren:${from}`, t],
    [`ren:${to}`, t],
    [`cat:${to}`, t],
  ]
  return {
    doc: next,
    items: re === null ? [item] : [...re.items, item],
    touched: re === null ? own : [...re.touched, ...own],
  }
}

/** Also covers merge-into-existing. Rows are materialised, never re-stamped; budgets untouched. */
export function renameCategory(doc: Doc, ctx: OpCtx, from: string, to: string): OpResult {
  const r = renameInto(doc, ctx, from, to)
  return result(r.doc, r.touched, entry(ctx, `Renamed "${from}" to "${to.trim()}"`, r.items))
}

/** Hides every shown budget key that resolves to `live` (own or inherited). */
function hideBudgets(
  doc: Doc,
  live: string,
  ctx: OpCtx,
): { budgets: ReadonlyMap<string, BudgetReg>; items: UndoItem[]; touched: Touched } {
  const res = resolver(doc.renames)
  const items: UndoItem[] = []
  const touched: Touched = []
  let budgets: Map<string, BudgetReg> | null = null
  for (const [k, g] of doc.budgets) {
    if (!isBudgetShown(g) || res(k) !== live) continue
    const t = tick(ctx.clock, ctx.wall, budgetStamp(g))
    budgets ??= new Map(doc.budgets)
    budgets.set(k, hidden(g, t))
    items.push({ k: 'reg', key: `bud:${k}`, prev: g, wrote: t })
    touched.push([`bud:${k}`, t])
  }
  return { budgets: budgets ?? doc.budgets, items, touched }
}

/** = rename to 'Other' plus an explicit budget deletion (v0.8 parity). */
export function removeCategory(doc: Doc, ctx: OpCtx, name: string): OpResult {
  if (name === OTHER) throw new OpError('other-locked', '"Other" cannot be renamed or removed.')
  const b = hideBudgets(doc, name, ctx)
  const r = renameInto({ ...doc, budgets: b.budgets }, ctx, name, OTHER)
  return result(
    r.doc,
    [...r.touched, ...b.touched],
    entry(ctx, `Removed "${name}"`, [...r.items, ...b.items]),
  )
}

// ── budgets and currency (§7.5, §7.12) ──────────────────────────────────────────────────────

function checkLive(doc: Doc, name: string): void {
  if (!displayList(doc).includes(name))
    throw new OpError('not-found', 'That category no longer exists.')
}

export function setBudget(doc: Doc, ctx: OpCtx, category: string, amount: number): OpResult {
  const value = checkAmount(amount, 'budget')
  checkLive(doc, category)
  const old = doc.budgets.get(category)
  if (old !== undefined && isBudgetShown(old) && old.value === value) return unchanged(doc)
  const t = tick(ctx.clock, ctx.wall, budgetStamp(old))
  const budgets = new Map(doc.budgets).set(category, { value, set: t, del: old?.del ?? 0 })
  const undo = entry(ctx, `Budget set for "${category}"`, [
    { k: 'reg', key: `bud:${category}`, prev: old ?? null, wrote: t },
  ])
  return result({ ...doc, budgets }, [[`bud:${category}`, t]], undo)
}

export function removeBudget(doc: Doc, ctx: OpCtx, category: string): OpResult {
  const b = hideBudgets(doc, category, ctx)
  if (b.items.length === 0) return unchanged(doc)
  return result(
    { ...doc, budgets: b.budgets },
    b.touched,
    entry(ctx, `Budget removed for "${category}"`, b.items),
  )
}

export function setCurrency(doc: Doc, ctx: OpCtx, code: string): OpResult {
  if (!validCurrency(code))
    throw new OpError('currency', 'Use a 3-letter currency code such as SGD.')
  const old = doc.prefs.get(CURRENCY_KEY)
  if (old?.v === code) return unchanged(doc)
  const t = tick(ctx.clock, ctx.wall, old?.s ?? 0)
  const prefs = new Map(doc.prefs).set(CURRENCY_KEY, { v: code, s: t })
  const undo = entry(ctx, `Currency set to ${code}`, [
    { k: 'reg', key: `pref:${CURRENCY_KEY}`, prev: old ?? null, wrote: t },
  ])
  return result({ ...doc, prefs }, [[`pref:${CURRENCY_KEY}`, t]], undo)
}

// ── undo (§7.2) ─────────────────────────────────────────────────────────────────────────────

interface Step {
  readonly doc: Doc
  readonly applied: number
  readonly skipped: number
  readonly touched: Touched
}

const fieldStamps = (rec: ExpenseRec): Stamp[] => FIELD_KEYS.map((f) => rec[f].s)

function restoreField(rec: ExpenseRec, u: UndoField, t: Stamp): ExpenseRec {
  const at = <T>(r: Reg<T>): Reg<T> => ({ v: r.v, s: t, r: 2 })
  switch (u.f) {
    case 'n':
      return { ...rec, n: at(u.prev) }
    case 'a':
      return { ...rec, a: at(u.prev) }
    case 'c':
      return { ...rec, c: at(u.prev) }
    case 'd':
      return { ...rec, d: at(u.prev) }
    case 'o':
      return { ...rec, o: at(u.prev) }
    case 'x':
      return { ...rec, x: at(u.prev) }
  }
}

type RecordItem = Extract<UndoItem, { readonly k: 'add' | 'edit' | 'delete' }>
type RegisterItem = Exclude<UndoItem, RecordItem>

const isRecordItem = (it: UndoItem): it is RecordItem =>
  it.k === 'add' || it.k === 'edit' || it.k === 'delete'

/**
 * A run of record items against ONE working copy of the records and tombstones, so undoing a
 * 5,000-row clear costs one map copy, not one per row. Guards and revive ids read the run's own
 * earlier writes.
 *   add:    the record is live and untouched since (every field stamp ≤ C) → tombstone it
 *   edit:   per field, the current stamp is the one the op wrote → prev value at tick(base = wrote)
 *   delete: no live copy with the same content under its revive id → revive under that id
 */
function undoRecords(doc: Doc, ctx: OpCtx, items: readonly RecordItem[]): Step {
  const expenses = new Map(doc.expenses)
  const tombs = new Map(doc.tombs)
  const view: Doc = { ...doc, expenses, tombs }
  const res = resolver(doc.renames)
  const writes = new Map<string, ExpenseRec>()
  const dropped: string[] = []
  const touched: Touched = []
  let applied = 0
  let skipped = 0
  let deletedAt: Stamp | null = null
  for (const it of items) {
    if (it.k === 'add') {
      const rec = expenses.get(it.id)
      if (rec === undefined || fieldStamps(rec).some((s) => s > it.C)) {
        skipped++
        continue
      }
      deletedAt ??= tick(ctx.clock, ctx.wall)
      expenses.delete(it.id)
      writes.delete(it.id)
      tombs.set(it.id, deletedAt)
      dropped.push(it.id)
      touched.push([`del:${it.id}`, deletedAt])
      applied++
    } else if (it.k === 'edit') {
      const rec = expenses.get(it.id)
      const ok = rec === undefined ? [] : it.fields.filter((u) => rec[u.f].s === u.wrote)
      if (rec === undefined || ok.length === 0) {
        skipped++
        continue
      }
      const t = tick(ctx.clock, ctx.wall, Math.max(...ok.map((u) => u.wrote)))
      let next = rec
      for (const u of ok) next = restoreField(next, u, t)
      next = materialize(next, res)
      expenses.set(it.id, next)
      writes.set(it.id, next)
      touched.push([`ex:${it.id}`, t])
      if (ok.length === it.fields.length) applied++
      else skipped++
    } else {
      const rec = revive(view, it.prev, ctx)
      if (rec === null) {
        skipped++
        continue
      }
      expenses.set(rec.id, rec)
      writes.set(rec.id, rec)
      touched.push([`ex:${rec.id}`, maxStampRec(rec)])
      applied++
    }
  }
  if (writes.size === 0 && dropped.length === 0) return { doc, applied, skipped, touched }
  const next: Doc = {
    ...doc,
    expenses: deriveExpenses(doc.expenses, [...writes.values()], dropped),
    tombs: dropped.length > 0 ? tombs : doc.tombs,
  }
  return { doc: next, applied, skipped, touched }
}

const isBudgetReg = (g: BudgetReg | PrefReg): g is BudgetReg => 'del' in g

/** A budget or preference register: guarded by the stamp the op wrote. */
function undoReg(
  doc: Doc,
  ctx: OpCtx,
  key: RegKey,
  prev: BudgetReg | PrefReg | null,
  wrote: Stamp,
): Step {
  const name = key.slice(key.indexOf(':') + 1)
  const skip: Step = { doc, applied: 0, skipped: 1, touched: [] }
  if (key.startsWith('bud:')) {
    const cur = doc.budgets.get(name)
    if (cur === undefined || budgetStamp(cur) !== wrote) return skip
    const t = tick(ctx.clock, ctx.wall, wrote)
    const back: BudgetReg =
      prev !== null && isBudgetReg(prev) && isBudgetShown(prev)
        ? { value: prev.value, set: t, del: cur.del }
        : hidden(cur, t)
    return {
      doc: { ...doc, budgets: new Map(doc.budgets).set(name, back) },
      applied: 1,
      skipped: 0,
      touched: [[key, t]],
    }
  }
  const cur = doc.prefs.get(name)
  if (cur === undefined || cur.s !== wrote) return skip
  const t = tick(ctx.clock, ctx.wall, wrote)
  const v = prev !== null && !isBudgetReg(prev) ? prev.v : null
  return {
    doc: { ...doc, prefs: new Map(doc.prefs).set(name, { v, s: t }) },
    applied: 1,
    skipped: 0,
    touched: [[key, t]],
  }
}

type RecatItem = Extract<UndoItem, { readonly k: 'recat' }>

/**
 * Per moved row: its category register is still the one the merge left → it moves back. A merge
 * into a re-added name also sends that name back to its old target while its rename register is
 * still the live one the merge wrote (else that part is skipped and counted).
 */
function undoRecat(doc: Doc, ctx: OpCtx, item: RecatItem): Step {
  const { from, into, ids, cWas, intoWas } = item
  const intoReg = doc.renames.get(into)
  const sendBack =
    intoWas !== undefined &&
    intoReg !== undefined &&
    intoReg.to === null &&
    intoReg.s === intoWas.wrote
      ? intoWas.to
      : null
  const base = Math.max(renameStamp(doc, from), sendBack === null ? 0 : renameStamp(doc, into))
  const t = tick(ctx.clock, ctx.wall, base)
  const renames = new Map(doc.renames).set(from, { to: null, s: t })
  const touched: Touched = [[`ren:${from}`, t]]
  if (sendBack !== null) {
    renames.set(into, { to: sendBack, s: t })
    touched.push([`ren:${into}`, t])
  }
  const moved: ExpenseRec[] = []
  let skipped = intoWas !== undefined && sendBack === null ? 1 : 0
  ids.forEach((id, i) => {
    const rec = doc.expenses.get(id)
    const was = cWas[i]
    if (
      rec === undefined ||
      was === undefined ||
      rec.c.v !== was.v ||
      rec.c.s !== was.s ||
      rec.c.r !== was.r
    ) {
      skipped++
      return
    }
    const back = editRecord(rec, { c: from }, ctx)
    moved.push(back)
    touched.push([`ex:${id}`, back.c.s])
  })
  const expenses = deriveExpenses(doc.expenses, moved)
  const next: Doc = {
    ...doc,
    renames,
    expenses: sendBack === null ? expenses : materializeAll(expenses, renames),
    categories: listed(doc, from),
  }
  return { doc: next, applied: moved.length, skipped, touched }
}

function undoUnrename(doc: Doc, ctx: OpCtx, from: string, to: string, wrote: Stamp): Step {
  const reg = doc.renames.get(from)
  if (reg === undefined || reg.s !== wrote || reg.to !== to)
    return { doc, applied: 0, skipped: 1, touched: [] }
  const t = tick(ctx.clock, ctx.wall, Math.max(wrote, renameStamp(doc, to)))
  const renames = new Map(doc.renames).set(from, { to: null, s: t }).set(to, { to: from, s: t })
  const next: Doc = { ...doc, renames, expenses: materializeAll(doc.expenses, renames) }
  return {
    doc: next,
    applied: 1,
    skipped: 0,
    touched: [
      [`ren:${from}`, t],
      [`ren:${to}`, t],
    ],
  }
}

function undoRegister(doc: Doc, ctx: OpCtx, item: RegisterItem): Step {
  switch (item.k) {
    case 'reg':
      return undoReg(doc, ctx, item.key, item.prev, item.wrote)
    case 'recat':
      return undoRecat(doc, ctx, item)
    case 'unrename':
      return undoUnrename(doc, ctx, item.from, item.to, item.wrote)
  }
}

/**
 * Applies the items in reverse order. Each touches only what still carries the stamp the op wrote,
 * otherwise it is skipped and counted per entry ("Undone, except 2 entries changed on another
 * device"). Consecutive record items run as one batch.
 */
export function undo(doc: Doc, ctx: OpCtx, e: UndoEntry): OpResult {
  let cur = doc
  let applied = 0
  let skipped = 0
  const touched: Touched = []
  const take = (s: Step): void => {
    cur = s.doc
    applied += s.applied
    skipped += s.skipped
    touched.push(...s.touched)
  }
  let run: RecordItem[] = []
  for (const item of [...e.items].reverse()) {
    if (isRecordItem(item)) {
      run.push(item)
      continue
    }
    if (run.length > 0) take(undoRecords(cur, ctx, run))
    run = []
    take(undoRegister(cur, ctx, item))
  }
  if (run.length > 0) take(undoRecords(cur, ctx, run))
  return { doc: cur, touched, report: { applied, skipped } }
}

// ── import (§7.7) ───────────────────────────────────────────────────────────────────────────

/** The file's collections without records, tombstones and devices: what an import joins. */
const fileCollections = (file: Doc): Doc => ({
  ...EMPTY_DOC,
  categories: file.categories,
  renames: file.renames,
  mappings: file.mappings,
  budgets: file.budgets,
  prefs: file.prefs,
})

/** Counts what a restore would do. Refuses a newer file or one over the row cap. */
export function planImport(doc: Doc, file: SanitizeResult): ImportPlan {
  if (file.writer === 'newer')
    throw new OpError('newer-file', 'This backup is from a newer SpendTrack.')
  if (file.report.quarantined.some((q) => q.reason === 'cap')) {
    throw new OpError('too-many', 'This backup has more than 50,000 entries.')
  }
  const renames = keyUnion(doc.renames, file.doc.renames, joinRename)
  const res = resolver(renames)
  const copyHere = dedupedCopyHere(doc, res)
  let added = 0
  let restored = 0
  let updated = 0
  let alreadyHere = 0
  let unrevivable = 0
  for (const rec of file.doc.expenses.values()) {
    const local = doc.expenses.get(rec.id)
    if (doc.tombs.has(rec.id)) {
      const category = res(rec.c.v)
      const id = reviveId(rec, category, takenIn(doc, contentKey(rec, category)))
      if (id === null) unrevivable++
      else if (doc.expenses.has(id)) alreadyHere++
      else restored++
    } else if (local === undefined) {
      if (copyHere(rec)) alreadyHere++
      else added++
    } else if (recEqual(mergeRecord(materialize(local, res), materialize(rec, res)), local))
      alreadyHere++
    else updated++
  }
  const replaceDeletes = [...doc.expenses.keys()].filter((id) => !file.doc.expenses.has(id)).length
  return {
    file: file.doc,
    counts: {
      inFile: file.doc.expenses.size,
      added,
      restored,
      updated,
      alreadyHere,
      unreadable: file.report.quarantined.length + unrevivable,
      deletedInFile: file.report.repairs.filter((q) => q.reason === LIVE_AND_DELETED).length,
    },
    replaceDeletes,
  }
}

/** Every field of `local` that differs from the file copy takes the file's value at a fresh stamp. */
function rewrite(local: ExpenseRec, file: ExpenseRec, ctx: OpCtx): ExpenseRec {
  const changed = FIELD_KEYS.filter((f) => canon(local[f].v) !== canon(file[f].v))
  if (changed.length === 0) return local
  const t = tick(
    ctx.clock,
    ctx.wall,
    Math.max(...changed.map((f) => Math.max(local[f].s, file[f].s))),
  )
  let out = local
  for (const f of changed) out = restoreField(out, undoField(file, f, 0), t)
  return out
}

/**
 * Restore (default): forward writes that never delete and ignore the file's tombstones. Replace:
 * tombstones live rows not in the file and makes every file row current with fresh stamps. Both
 * join categories, renames, mappings, budgets and prefs, and carry a guarded undo entry.
 */
export function applyImport(
  doc: Doc,
  ctx: OpCtx,
  plan: ImportPlan,
  mode: 'restore' | 'replace',
): OpResult {
  const joined = mergeDoc(doc, fileCollections(plan.file)).doc
  const res = resolver(joined.renames)
  const items: UndoItem[] = []
  const touched: Touched = []
  const writes: ExpenseRec[] = []
  let base = joined
  if (mode === 'replace') {
    const gone = [...joined.expenses.keys()].filter((id) => !plan.file.expenses.has(id))
    const del = deleteExpenses(joined, ctx, gone)
    base = del.doc
    items.push(...(del.undo?.items ?? []))
    touched.push(...del.touched)
  }
  // revive ids are checked against the writes so far: two file rows never revive into one id twice
  const working = new Map(base.expenses)
  const view: Doc = { ...base, expenses: working }
  // a replace tombstones the shared root id itself, so there every split-off copy is added
  const copyHere = mode === 'restore' ? dedupedCopyHere(base, res) : () => false
  for (const [id, rec] of [...plan.file.expenses].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const local = base.expenses.get(id)
    if (base.tombs.has(id)) {
      const revived = revive(view, rec, ctx)
      if (revived === null) continue
      working.set(revived.id, revived)
      writes.push(revived)
      items.push({ k: 'add', id: revived.id, C: maxStampRec(revived) })
    } else if (local === undefined) {
      if (copyHere(rec)) continue
      const added = materialize(mode === 'replace' ? reviveRecord(rec, id, ctx) : rec, res)
      writes.push(added)
      items.push({ k: 'add', id, C: maxStampRec(added) })
    } else {
      const next =
        mode === 'replace'
          ? rewrite(local, materialize(rec, res), ctx)
          : mergeRecord(local, materialize(rec, res))
      if (recEqual(next, local)) continue
      const fields = changedFields(local, next)
      writes.push(next)
      items.push({ k: 'edit', id, fields: fields.map((f) => undoField(local, f, next[f].s)) })
    }
  }
  for (const rec of writes) touched.push([`ex:${rec.id}`, maxStampRec(rec)])
  for (const [k, g] of joined.renames) if (doc.renames.get(k) !== g) touched.push([`ren:${k}`, g.s])
  for (const [k, g] of joined.mappings)
    if (doc.mappings.get(k) !== g) touched.push([`map:${k}`, g.s])
  for (const [k, g] of joined.budgets)
    if (doc.budgets.get(k) !== g) touched.push([`bud:${k}`, budgetStamp(g)])
  for (const [k, g] of joined.prefs) if (doc.prefs.get(k) !== g) touched.push([`pref:${k}`, g.s])
  for (const n of joined.categories) if (!doc.categories.includes(n)) touched.push([`cat:${n}`, 0])
  const next: Doc = writes.length === 0 ? base : { ...base, expenses: withExpenses(base, writes) }
  if (next === doc) return unchanged(doc)
  const label = mode === 'replace' ? 'Replaced data with backup' : 'Imported backup'
  return result(next, touched, entry(ctx, label, items))
}
