// The golden vectors of the frozen v0.8.5 model (app 0.9.2, P2-5). The equivalence of
// legacy/v085.ts with the shipped files was proven on 2,000 random inputs per function against
// `git archive v0.9.2 src` (U1 scratch). These deterministic inputs and drivers were then run on
// the SHIPPED code, and the digests of its outputs are pinned in v085.golden.test.ts, so any
// later change to the model that the shipped code would not make fails there.
//
// The drivers take the implementation as an argument: the scratch generator passes the shipped
// modules, the golden test passes the model. Nothing here may change without regenerating the
// digests against the shipped code (they would no longer describe 0.9.2).
import { FNV_A, FNV_B, fnvLane, hex8 } from '../../core/hash'
import { parseJson } from '../support/must'
import { makeRng, type Rng } from '../support/rng'

export const GOLDEN_T0 = Date.UTC(2026, 9, 18, 4, 0, 0)
const iso = (t: number): string => new Date(t).toISOString()

/** One element of a list that holds `undefined` itself (Rng.pick refuses to return undefined). */
const pickAny = (r: Rng, items: readonly unknown[]): unknown => items[r.int(items.length)]

/** A 64-bit digest of a text: two independent FNV-1a lanes. */
export const digest = (text: string): string =>
  hex8(fnvLane(text, FNV_A)) + hex8(fnvLane(text, FNV_B))

const STAMP_TEXTS: readonly string[] = [
  '2026-10-18T04:00:00.000Z',
  '2026-10-18T04:00:00.001Z',
  '2026-10-19T08:30:00.000Z',
  '2026-10-18T04:00:00Z',
  '1970-01-01T00:00:00.000Z',
  '1999-12-31T23:59:59.999Z',
  '2000-01-01T00:00:00.000Z',
  '2099-12-31T23:59:59.999Z',
  '2100-01-01T00:00:00.000Z',
  '9999-12-31T00:00:00.000Z',
  '2026-10-18T12:00:00',
  '2026-10-18 04:00',
  '2026-10-18T04:00:00+08:00',
  '2026-10-18T04:00:00-1000',
  '2026-10-18T04:00+14',
  '2026-10-18',
  'garbage',
  '',
  '2026-02-30T00:00:00.000Z',
  '2026-10-18T24:00:00Z',
  '2026-10-18T24:00:01Z',
  '2026-10-18t04:00:00z',
  '2026-10-18T04:00:00.123456789Z',
  '2026-10-18T04:60:00Z',
  '2026-10-18T04:00:00+24:00',
]

export function stampText(r: Rng): string {
  return r.chance(0.5)
    ? r.pick(STAMP_TEXTS)
    : iso(GOLDEN_T0 + r.int(40) * 3_600_000 + r.pick([0, 1, 999]))
}

const DATES: readonly string[] = [
  '2026-10-18T04:00:00.000Z',
  '2026-10-18T13:35:30.774Z',
  '2026-10-18T12:00:00',
  '2026-10-18',
  '2026-10-17T16:30:00.000Z',
  'last tuesday',
  '18/10/2026',
  '2026-02-30',
  '2150-01-01T00:00:00.000Z',
]
export const GOLDEN_CATS: readonly string[] = [
  'Food',
  'Food & Dining',
  'Transport',
  'Other',
  'Meals',
  'Gym',
  'Education',
  'Bills & Utilities',
  '__proto__',
  'constructor',
]
export const GOLDEN_ITEMS: readonly string[] = [
  'chicken rice',
  'kopi',
  'Kopi O',
  'grab to camp',
  'kitchen towel',
  'sql course',
  'constructor',
  '__proto__',
  'toString',
]
const IDS: readonly string[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

/** One v4 expense row as any v4 writer might send it, damaged now and then. */
export function goldenRow(r: Rng, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    itemName: r.pick(GOLDEN_ITEMS),
    amount: r.pick([1.8, 4.5, 12, 21, 300, 0.1 + 0.2]),
    category: r.pick(GOLDEN_CATS),
    date: r.chance(0.85) ? r.pick(DATES.slice(0, 5)) : r.pick(DATES),
    createdAt: stampText(r),
  }
  if (r.chance(0.6)) out.updatedAt = stampText(r)
  if (r.chance(0.3)) out.notes = r.pick(['to camp', '', 'lunch'])
  if (r.chance(0.05)) out.notes = null
  if (r.chance(0.15)) out.day = '2026-10-18'
  if (r.chance(0.1)) out.fs = { a: [GOLDEN_T0, 1] }
  if (r.chance(0.1)) out.h = 'abc123'
  if (r.chance(0.04)) out.amount = r.pick([0, -1, '4.5', null, 1e308])
  if (r.chance(0.03)) out.id = r.pick(['', 7, null])
  if (r.chance(0.03)) out.category = r.pick([null, 5])
  if (r.chance(0.03)) out.updatedAt = r.pick([5, null])
  if (r.chance(0.02)) out.deep = parseJson('['.repeat(20) + ']'.repeat(20))
  return out
}

function stampMap(r: Rng, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.filter(() => r.chance(0.7)).map((k) => [k, stampText(r)]))
}

/** A v4 payload as 0.9.2 (or any v4 writer) might hold or pull. Plain JSON. */
export function goldenPayload(r: Rng): Record<string, unknown> {
  const expenses = IDS.filter(() => r.chance(0.6)).map((id) => goldenRow(r, id))
  const first = expenses[0]
  if (r.chance(0.08) && first !== undefined) expenses.push(goldenRow(r, String(first.id)))
  const mkeys = GOLDEN_ITEMS.filter(() => r.chance(0.4)).map((x) => x.toLowerCase())
  const bkeys = GOLDEN_CATS.filter(() => r.chance(0.35))
  const out: Record<string, unknown> = {
    expenses,
    categories: GOLDEN_CATS.filter(() => r.chance(0.5)),
    categoryMappings: Object.fromEntries(mkeys.map((k) => [k, r.pick(GOLDEN_CATS)])),
    mappingUpdatedAt: stampMap(r, mkeys),
    budgets: Object.fromEntries(
      bkeys.filter(() => r.chance(0.7)).map((k) => [k, r.pick([100, 200, 300, 300.5])]),
    ),
    budgetUpdatedAt: stampMap(r, bkeys),
    budgetDeletedAt: stampMap(
      r,
      bkeys.filter(() => r.chance(0.4)),
    ),
    deletedIds: IDS.filter(() => r.chance(0.2)),
    exportDate: r.chance(0.8) ? stampText(r) : '',
    version: '4.0',
  }
  if (r.chance(0.2)) delete out.mappingUpdatedAt
  if (r.chance(0.1)) delete out.budgetUpdatedAt
  if (r.chance(0.1)) delete out.budgetDeletedAt
  if (r.chance(0.1)) delete out.deletedIds
  if (r.chance(0.3))
    out.wr = { app: '0.8.5', dev: 'abcdef', rev: `r${String(r.int(1e6))}`, at: iso(GOLDEN_T0) }
  if (r.chance(0.15)) out.x5 = { schema: 5, minor: 0, min: r.pick([4, 4, 4, 5, 99]) }
  if (r.chance(0.03)) out.expenses = r.pick(['moved', null, {}, 'x'])
  if (r.chance(0.03)) out.categoryMappings = r.pick([[], 'x', null])
  return out
}

/** Arbitrary JSON-ish values (canon's inputs), with prototype-named keys and deep nests. */
function goldenJson(r: Rng, depth: number): unknown {
  const k = r.int(depth > 70 ? 4 : 7)
  if (k === 0) return r.pick([null, true, false, 0, -0, 1.5, 1e21, 'x', '', ' ', '__proto__'])
  if (k === 1) return r.int(1000)
  if (k === 2) return stampText(r)
  if (k === 3) return undefined
  if (k === 4) return Array.from({ length: r.int(3) }, () => goldenJson(r, depth + 1))
  if (k === 5 && r.chance(0.3)) return [goldenJson(r, depth + 1)]
  const o: Record<string, unknown> = {}
  for (let i = r.int(4); i > 0; i--) {
    o[r.pick(['b', 'a', 'id', '__proto__', 'z', '1'])] = goldenJson(r, depth + 1)
  }
  return o
}

/** JSON.stringify is typed `string`, but gives undefined for undefined and functions. */
const stringify = (v: unknown): string | undefined => JSON.stringify(v)

const outcome = (f: () => unknown): string => {
  try {
    return stringify(f()) ?? 'undefined'
  } catch (e) {
    return `throw:${e instanceof Error ? e.message : String(e)}`
  }
}

/** The pure functions of 0.9.2 (lib/stamps, lib/canon, lib/backup, services/syncService, …). */
export interface PureImpl<D, E> {
  readonly stampMs: (v: unknown) => number
  readonly nextStampIso: (now: number, bases: readonly number[]) => string
  readonly canon: (v: unknown) => string
  readonly canonRow: (v: unknown) => string
  readonly nestsWithin: (v: unknown, max: number) => boolean
  readonly fnv1a: (s: string) => string
  /** parseBackup at wall time GOLDEN_T0 + 123. */
  readonly parseBackup: (raw: unknown) => unknown
  readonly recordOfStrings: (v: unknown) => unknown
  readonly listOfNumbers: (v: unknown) => unknown
  readonly isSyncableExpense: (v: unknown) => boolean
  readonly readRemote: (p: unknown) => unknown
  /** readRemote's data when it reads the payload as ok, else null. */
  readonly readOk: (p: unknown) => D | null
  readonly contentKey: (p: unknown, opts: { readonly mappingStamps?: boolean }) => string
  /** mergeBackups at wall time GOLDEN_T0 + 123. */
  readonly mergeBackups: (local: D, remote: D) => D
  readonly expensesOf: (d: D) => readonly E[]
  readonly withExpenses: (d: D, expenses: readonly E[]) => D
  readonly categoryOf: (e: E) => string
  /** The same row filed under `category` (nothing else changes, no stamp). */
  readonly refile: (e: E, category: string) => E
  readonly keepLocalRefiles: (merged: D, local: readonly E[], remote: readonly E[]) => D
}

export const PURE_N = 400

/** One digest per function family over PURE_N deterministic inputs each. */
export function pureDigests<D, E>(impl: PureImpl<D, E>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}

  let r = makeRng(1)
  let acc = ''
  for (let i = 0; i < PURE_N; i++) {
    let s = stampText(r)
    if (r.chance(0.3)) {
      const at = r.int(s.length + 1)
      s = s.slice(0, at) + r.pick(['', '9', 'Z', ' ', ':', '.', '-']) + s.slice(at + 1)
    }
    const v: unknown = r.chance(0.05) ? pickAny(r, [5, null, undefined, {}]) : s
    const now = GOLDEN_T0 + r.int(1e9) - 5e8
    const bases = Array.from({ length: r.int(3) }, () =>
      r.chance(0.2) ? Date.UTC(2100, 0, 1) + r.int(5) : impl.stampMs(stampText(r)),
    )
    acc += `${String(impl.stampMs(v))}|${impl.nextStampIso(now, bases)}\n`
  }
  out.stamps = digest(acc)

  r = makeRng(2)
  acc = ''
  for (let i = 0; i < PURE_N; i++) {
    let v = goldenJson(r, 0)
    if (r.chance(0.05)) {
      let deep: unknown = 1
      for (let d = r.int(90); d > 0; d--) deep = [deep]
      v = deep
    }
    const max = r.int(20)
    const c = outcome(() => impl.canon(v))
    acc += `${c}|${outcome(() => impl.canonRow(v))}|${String(impl.nestsWithin(v, max))}|`
    acc += `${outcome(() => impl.fnv1a(impl.canon(v)))}\n`
  }
  out.canon = digest(acc)

  r = makeRng(3)
  acc = ''
  for (let i = 0; i < PURE_N; i++) {
    const raw: unknown = r.chance(0.05) ? r.pick([null, [], 'x', 5]) : goldenPayload(r)
    const rec = goldenJson(r, 0)
    acc += `${outcome(() => impl.parseBackup(raw))}|${outcome(() => impl.recordOfStrings(rec))}|`
    acc += `${outcome(() => impl.listOfNumbers(rec))}\n`
  }
  out.backup = digest(acc)

  r = makeRng(4)
  acc = ''
  for (let i = 0; i < PURE_N; i++) {
    const x = goldenRow(r, r.pick(IDS))
    const p: unknown = r.chance(0.05) ? pickAny(r, [null, undefined, [], 'x', 5]) : goldenPayload(r)
    acc += `${String(impl.isSyncableExpense(x))}|${outcome(() => impl.readRemote(p))}`
    for (const opts of [{}, { mappingStamps: false }, { mappingStamps: true }]) {
      acc += `|${impl.contentKey(p, opts)}`
    }
    acc += '\n'
  }
  out.readRemote = digest(acc)

  r = makeRng(5)
  acc = ''
  for (let i = 0; i < PURE_N; i++) {
    const a = impl.readOk(goldenPayload(r))
    const b = impl.readOk(goldenPayload(r))
    if (a === null || b === null) continue
    acc += `${outcome(() => impl.mergeBackups(a, b))}|${outcome(() => impl.mergeBackups(b, a))}\n`
  }
  out.mergeBackups = digest(acc)

  r = makeRng(6)
  acc = ''
  for (let i = 0; i < PURE_N; i++) {
    const a = impl.readOk(goldenPayload(r))
    if (a === null) continue
    // the remote: the same rows re-filed (category only) half the time, so the rule fires
    const local = impl.expensesOf(a)
    const remote = local.map((e) =>
      r.chance(0.5) ? impl.refile(e, r.pick(['Gaming', 'Shopping', impl.categoryOf(e)])) : e,
    )
    const merged = impl.mergeBackups(a, impl.withExpenses(a, remote))
    acc += `${outcome(() => impl.keepLocalRefiles(merged, local, remote))}\n`
  }
  out.keepLocalRefiles = digest(acc)
  return out
}

// ── the store (useExpenseStore + installPersistence) ─────────────────────────────────────────

export const V4_STORE_KEYS: readonly string[] = [
  'expenses',
  'categories',
  'categoryMappings',
  'categoryMappingUpdatedAt',
  'categoryBudgets',
  'categoryBudgetUpdatedAt',
  'categoryBudgetDeletedAt',
  'deletedExpenseIds',
]

/** Identical v4 keys for both sides, a few of them damaged. */
export function goldenKeys(r: Rng): Map<string, string> {
  const p = goldenPayload(r)
  const list: unknown = p.expenses
  const values: Record<string, unknown> = {
    expenses: Array.isArray(list)
      ? [...list.map((x: unknown) => x), ...(r.chance(0.1) ? [null, 5] : [])]
      : [],
    categories: p.categories,
    categoryMappings: p.categoryMappings,
    categoryMappingUpdatedAt: p.mappingUpdatedAt,
    categoryBudgets: p.budgets,
    categoryBudgetUpdatedAt: p.budgetUpdatedAt,
    categoryBudgetDeletedAt: p.budgetDeletedAt,
    deletedExpenseIds: p.deletedIds,
  }
  const out = new Map<string, string>()
  for (const k of V4_STORE_KEYS) {
    if (r.chance(0.1) || values[k] === undefined) continue
    let text = JSON.stringify(values[k])
    if (r.chance(0.04)) text = text.slice(0, Math.max(1, text.length - 3)) // truncated
    if (r.chance(0.04)) text = text.replace(/\]$/, ',]').replace(/\}$/, ',}') // trailing comma
    out.set(k, text)
  }
  return out
}

/** What a driven store shows between actions (the public state the screens read). */
export interface StoreSnapshot {
  readonly ids: readonly string[]
  readonly categories: readonly string[]
  readonly budgets: Readonly<Record<string, number>>
  readonly undoIds: readonly string[]
}

/** What the driver adds: the add sheet's and quick add's fields. */
export interface GoldenAdd {
  itemName: string
  amount: number
  category?: string
  date?: string
  notes?: string
}

/** What the driver edits (`notes` may be present and undefined, as the edit sheet sends it). */
export interface GoldenPatch {
  amount?: number
  itemName?: string
  category?: string
  date?: string
  notes?: string | undefined
}

/** The JSON the driver compares after every action. */
export function storeView(
  exported: unknown,
  undoStack: readonly { readonly id: string; readonly label: string; readonly expiresAt: number }[],
  syncStatus: unknown,
  lastSavedAt: unknown,
): string {
  return JSON.stringify({
    data: exported,
    undo: undoStack.map((u) => [u.id, u.label, u.expiresAt]),
    status: syncStatus,
    savedAt: lastSavedAt,
  })
}

/** One 0.9.2 store, the shipped one or the model, behind the same actions. */
export interface StoreTarget<D> {
  readonly snapshot: () => StoreSnapshot
  /** JSON of exportBackup, the undo stack, syncStatus and lastSavedAt. */
  readonly view: () => string
  readonly addExpense: (input: GoldenAdd) => unknown
  readonly updateExpense: (id: string, patch: GoldenPatch) => unknown
  readonly deleteExpense: (id: string) => unknown
  readonly consumeUndo: (id: string) => unknown
  readonly renameCategory: (from: string, to: string) => unknown
  readonly removeCategory: (name: string) => unknown
  readonly setBudget: (category: string, amount: number) => unknown
  readonly removeBudget: (category: string) => unknown
  readonly addCategory: (name: string) => unknown
  readonly importBackup: (data: D) => unknown
  readonly exportBackup: () => D
  readonly clearAllExpenses: () => unknown
  readonly clearUndo: (id: string) => unknown
  readonly flushPendingSave: () => void
  /** Every saved storage key, sorted. */
  readonly savedKeys: () => readonly (readonly [string, string])[]
}

export interface StoreHarness<D> {
  /** A fresh store hydrated from these keys at wall time `wall`, with id stream `seq`. */
  readonly start: (
    keys: ReadonlyMap<string, string>,
    wall: number,
    seq: number,
  ) => Promise<StoreTarget<D>>
  readonly advance: (ms: number) => Promise<void>
  /** readRemote's data when ok (the model's reading is used on both sides). */
  readonly readOk: (p: unknown) => D | null
  readonly stop: () => void
}

export const STORE_SEQS = 60
export const STORE_STEPS = 30

const attempt = (f: () => unknown): string => {
  try {
    f()
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Digest of STORE_SEQS random 30-action sequences: every action's outcome and view, then keys. */
export async function storeDigest<D>(h: StoreHarness<D>): Promise<string> {
  let acc = ''
  for (let seq = 0; seq < STORE_SEQS; seq++) {
    const r = makeRng(1000 + seq)
    const s0 = await h.start(goldenKeys(r), GOLDEN_T0 + seq * 1000, seq)
    acc += `${String(seq)}:${s0.view()}\n`
    for (let step = 0; step < STORE_STEPS; step++) {
      const s = s0.snapshot()
      const ids = [...s.ids, 'nope']
      const undoIds = [...s.undoIds, 'bogus']
      const k = r.int(16)
      let a: string
      if (k <= 3) {
        const input: GoldenAdd = {
          itemName: r.pick([...GOLDEN_ITEMS, '  Kopi  ', '']),
          amount: r.pick([1.8, 4.5, 12, 0, -1, Number.NaN, Infinity]),
          ...(r.chance(0.5) ? { category: r.pick([...GOLDEN_CATS, '']) } : {}),
          ...(r.chance(0.5)
            ? {
                date: r.pick([
                  '2026-10-18T04:00:00.000Z',
                  '2026-10-17T04:00:00.000Z',
                  '2026-10-18T12:00:00',
                  '',
                ]),
              }
            : {}),
          ...(r.chance(0.3) ? { notes: r.pick(['to camp', '']) } : {}),
        }
        a = attempt(() => s0.addExpense(input))
      } else if (k <= 6) {
        const id = r.pick(ids)
        const patch: GoldenPatch = {}
        if (r.chance(0.5)) patch.amount = r.pick([2, 45, 4.5, 12])
        if (r.chance(0.3)) patch.itemName = r.pick(GOLDEN_ITEMS)
        if (r.chance(0.3)) patch.category = r.pick(GOLDEN_CATS)
        if (r.chance(0.3)) {
          patch.date = r.pick([
            '2026-10-18T04:00:00.000Z',
            '2026-10-18T09:00:00.000Z',
            '2026-10-10T04:00:00.000Z',
            '2026-10-18T12:00:00',
          ])
        }
        if (r.chance(0.3)) {
          const n = r.int(3)
          patch.notes = n === 0 ? '' : n === 1 ? 'lunch' : undefined
        }
        a = attempt(() => s0.updateExpense(id, patch))
      } else if (k === 7) {
        const id = r.pick(ids)
        a = attempt(() => s0.deleteExpense(id))
      } else if (k === 8) {
        const id = r.pick(undoIds)
        a = attempt(() => s0.consumeUndo(id))
      } else if (k === 9) {
        const from = r.pick([...s.categories, 'Ghost'])
        const to = r.pick([...GOLDEN_CATS, ' Meals ', '', from])
        a = attempt(() => s0.renameCategory(from, to))
      } else if (k === 10) {
        const name = r.pick([...s.categories, 'Ghost'])
        a = attempt(() => s0.removeCategory(name))
      } else if (k === 11) {
        const cat = r.pick([...GOLDEN_CATS, ''])
        const amount = r.chance(0.3)
          ? Object.hasOwn(s.budgets, cat)
            ? (s.budgets[cat] ?? 100)
            : 100
          : r.pick([100, 250, 0, Number.NaN])
        a = attempt(() => s0.setBudget(cat, amount))
      } else if (k === 12) {
        const cat = r.pick(GOLDEN_CATS)
        a = attempt(() => s0.removeBudget(cat))
      } else if (k === 13) {
        const name = r.pick([...GOLDEN_CATS, '  New one ', ''])
        a = attempt(() => s0.addCategory(name))
      } else if (k === 14) {
        const importing = r.chance(0.5)
        const clearing = !importing && r.chance(0.5)
        if (importing) {
          const data = h.readOk(goldenPayload(r)) ?? s0.exportBackup()
          a = attempt(() => s0.importBackup(data))
        } else if (clearing) {
          a = attempt(() => s0.clearAllExpenses())
        } else {
          const id = r.pick(undoIds)
          a = attempt(() => s0.clearUndo(id))
        }
      } else {
        const ms = r.pick([0, 1, 399, 400, 401, 4999, 5000, 5001, 8000])
        await h.advance(ms)
        a = `t+${String(ms)}`
        if (r.chance(0.3)) s0.flushPendingSave()
      }
      acc += `${a}|${s0.view()}\n`
    }
    await h.advance(1000)
    s0.flushPendingSave()
    acc += `${JSON.stringify(s0.savedKeys())}\n`
    h.stop()
  }
  return digest(acc)
}
