// Random valid docs and records drawn from tiny universes, so ties and collisions are common.
import { nullRecord } from '../../core/constants'
import { iso } from '../../core/stamp'
import type {
  BudgetReg,
  DateValue,
  DeviceInfo,
  Doc,
  ExpenseRec,
  Extras,
  Json,
  MapReg,
  PrefReg,
  Rank,
  Reg,
  RenameReg,
  Stamp,
} from '../../core/types'
import type { Rng } from './rng'

export const T0 = Date.UTC(2026, 9, 19, 8)
export const DAY = 86_400_000
export const HOUR = 3_600_000

export const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
export const NAMES = [
  'kopi',
  'grab',
  'chicken rice',
  'constructor',
  '__proto__',
  'toString',
] as const
export const CATS = ['Food', 'Meals', 'Travel', 'Other'] as const
export const NOTES = [null, 'to camp', '__proto__', 'hasOwnProperty'] as const
const AMOUNTS = [1.8, 4.5, 12, 21] as const
const DATES: readonly DateValue[] = [
  { date: '2026-10-18T04:00:00.000Z' },
  { date: '2026-10-18T04:00:00.000Z', day: '2026-10-18' },
  { date: '2026-10-17T04:00:00.000Z', day: '2026-10-17' },
]

export function extrasOf(entries: Readonly<Record<string, Json>>): Extras {
  const x = nullRecord<Json>()
  for (const k of Object.keys(entries).sort()) {
    Object.defineProperty(x, k, { value: entries[k] ?? null, enumerable: true })
  }
  return Object.freeze(x)
}
const EXTRAS: readonly Extras[] = [
  extrasOf({}),
  extrasOf({ kind: 'expense' }),
  extrasOf({ kind: 'transfer', tag: 'toString' }),
]

/** A record whose registers draw from small sets of stamps, ranks and values. */
export function genRecord(
  rng: Rng,
  id: string,
  stamps: readonly Stamp[] = [T0, T0 + 1000, T0 + 2000],
): ExpenseRec {
  const C = rng.pick(stamps)
  const reg = <T>(vals: readonly T[]): Reg<T> => ({
    v: rng.pick(vals),
    s: C + rng.int(3) * 1000,
    r: rng.pick<Rank>([0, 1, 2]),
  })
  return {
    id,
    createdAt: iso(C),
    C,
    n: reg(NAMES),
    a: reg(AMOUNTS),
    c: reg(CATS),
    d: reg(DATES),
    o: reg<string | null>(NOTES),
    x: reg(EXTRAS),
  }
}

export interface GenOptions {
  /** Include rename entries (associativity only holds without renames in flight). */
  readonly renames?: boolean
  readonly ids?: readonly string[]
}

/** A random valid doc (I-doc-1..5 hold): live and tombstoned ids are disjoint. */
export function genDoc(rng: Rng, opts: GenOptions = {}): Doc {
  const ids = opts.ids ?? IDS
  const times = [0, T0, T0 + 1000, T0 + 2000, T0 + 3000]
  const expenses = new Map<string, ExpenseRec>()
  const tombs = new Map<string, Stamp>()
  for (const id of ids) {
    const roll = rng.next()
    if (roll < 0.55) expenses.set(id, genRecord(rng, id))
    else if (roll < 0.75) tombs.set(id, rng.pick(times))
  }
  const categories = CATS.filter(() => rng.chance(0.7))
  const renames = new Map<string, RenameReg>()
  if (opts.renames ?? true) {
    for (const c of CATS) {
      if (!rng.chance(0.3)) continue
      // 'Other' is never a rename source; a remove writes its live marker
      renames.set(c, {
        to: c === 'Other' || rng.chance(0.3) ? null : rng.pick(CATS),
        s: rng.pick(times),
      })
    }
  }
  const mappings = new Map<string, MapReg>()
  for (const k of ['kopi', 'chicken rice', 'grab']) {
    if (rng.chance(0.5)) mappings.set(k, { v: rng.pick(CATS), s: rng.pick(times) })
  }
  const budgets = new Map<string, BudgetReg>()
  for (const c of CATS) {
    if (!rng.chance(0.4)) continue
    const set = rng.pick(times)
    const del = rng.chance(0.3) ? rng.pick(times) : 0
    const hidden = del > 0 && del >= set
    const value = rng.chance(0.2) || hidden ? null : rng.pick([100, 200, 300])
    if (value === null && set === 0 && del === 0) continue
    budgets.set(c, { value, set, del })
  }
  const prefs = new Map<string, PrefReg>()
  if (rng.chance(0.5))
    prefs.set('currency', { v: rng.pick(['SGD', 'EUR', 'MYR']), s: rng.pick(times) })
  const devices = new Map<string, DeviceInfo>()
  if (rng.chance(0.3)) {
    devices.set(rng.pick(['k3f9x2', 'p0p0p0']), {
      name: rng.pick(['Phone', 'Laptop']),
      app: rng.pick(['0.9.0', '0.9.1']),
      mode: 'table',
      e2e: false,
      seen: rng.pick(times),
    })
  }
  return { expenses, tombs, categories, renames, mappings, budgets, prefs, devices }
}

/** Wraps a map so any mutation throws (purity checks: inputs are never mutated). */
export function frozenMap<K, V>(m: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const copy = new Map(m)
  const fail = (): never => {
    throw new Error('mutation of a frozen input map')
  }
  return Object.freeze(Object.assign(copy, { set: fail, delete: fail, clear: fail }))
}

function deepFreeze(v: unknown): void {
  if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return
  Object.freeze(v)
  for (const k of Object.keys(v)) deepFreeze(Object.getOwnPropertyDescriptor(v, k)?.value)
}

/** A deep-frozen copy of a doc: maps reject mutation, records and registers are frozen. */
export function freezeDoc(doc: Doc): Doc {
  for (const rec of doc.expenses.values()) deepFreeze(rec)
  for (const m of [doc.renames, doc.mappings, doc.budgets, doc.prefs, doc.devices]) {
    for (const v of m.values()) deepFreeze(v)
  }
  return Object.freeze({
    expenses: frozenMap(doc.expenses),
    tombs: frozenMap(doc.tombs),
    categories: Object.freeze([...doc.categories]),
    renames: frozenMap(doc.renames),
    mappings: frozenMap(doc.mappings),
    budgets: frozenMap(doc.budgets),
    prefs: frozenMap(doc.prefs),
    devices: frozenMap(doc.devices),
  })
}

/** Build a doc from partial collections (unit tests). */
export function docOf(
  parts: Partial<{
    expenses: readonly ExpenseRec[]
    tombs: readonly (readonly [string, Stamp])[]
    categories: readonly string[]
    renames: readonly (readonly [string, RenameReg])[]
    mappings: readonly (readonly [string, MapReg])[]
    budgets: readonly (readonly [string, BudgetReg])[]
    prefs: readonly (readonly [string, PrefReg])[]
  }>,
): Doc {
  return {
    expenses: new Map((parts.expenses ?? []).map((r) => [r.id, r])),
    tombs: new Map(parts.tombs ?? []),
    categories: parts.categories ?? [],
    renames: new Map(parts.renames ?? []),
    mappings: new Map(parts.mappings ?? []),
    budgets: new Map(parts.budgets ?? []),
    prefs: new Map(parts.prefs ?? []),
    devices: new Map(),
  }
}
