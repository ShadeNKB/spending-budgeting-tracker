// Expense records as six per-field LWW registers (DATA-ENGINE-SPEC §5, P-14). Pure.
// Each register is ordered by (stamp, rank, canon(value)); a record merge is their product, so it
// is commutative, associative and idempotent. The wire form stays a valid v0.8 record.
import { FIELD_KEYS, KNOWN_RECORD_KEYS, nullRecord } from './constants'
import { localDay, localNoonIso } from './dates'
import { FNV_A, FNV_B, canon, fnv36, fnvLane } from './hash'
import type { CleanExpense, FsEntry, FsMap } from './sanitize'
import { iso, ps, tick } from './stamp'
import type {
  DateValue,
  ExpenseRec,
  Extras,
  FieldKey,
  Json,
  OpCtx,
  Rank,
  Reg,
  Stamp,
} from './types'

/** Values a new record is created with (the op validated them). */
export interface RecordValues {
  readonly n: string
  readonly a: number
  readonly c: string
  readonly day: string
  readonly o: string | null
}

/** Field edits an op may make. `day` moves `date` to local noon unless the date is on that day. */
export type RecordPatch = Partial<RecordValues>

const EMPTY_EXTRAS: Extras = Object.freeze(nullRecord<Json>())

type AnyReg = ExpenseRec[FieldKey]
const regOf = (rec: ExpenseRec, f: FieldKey): AnyReg => rec[f]

// ── seal ────────────────────────────────────────────────────────────────────────────────────

function sealParts(
  id: unknown,
  itemName: unknown,
  amount: unknown,
  category: unknown,
  date: unknown,
  day: unknown,
  notes: unknown,
  createdAt: unknown,
  updatedAt: unknown,
  fs: unknown,
  extras: unknown,
): string {
  return fnv36(
    canon([
      id,
      itemName,
      amount,
      category,
      date,
      day ?? null,
      notes ?? null,
      createdAt,
      updatedAt ?? null,
      fs ?? null,
      extras,
    ]),
  )
}

const ownValue = (o: object, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value

/** §5.2: the seal of a wire record (its `h` is ignored; unknown keys are the extras). */
export function sealOf(raw: Readonly<Record<string, unknown>>): string {
  const extras = nullRecord<unknown>()
  for (const k of Object.keys(raw)) {
    if (!KNOWN_RECORD_KEYS.has(k)) {
      Object.defineProperty(extras, k, { value: ownValue(raw, k), enumerable: true })
    }
  }
  const g = (k: string): unknown => ownValue(raw, k)
  return sealParts(
    g('id'),
    g('itemName'),
    g('amount'),
    g('category'),
    g('date'),
    g('day'),
    g('notes'),
    g('createdAt'),
    g('updatedAt'),
    g('fs'),
    extras,
  )
}

const text = (v: string | number): string => JSON.stringify(v)
const optText = (v: string | undefined): string => (v === undefined ? 'null' : JSON.stringify(v))

/**
 * sealOf for a sanitised record, hand-unrolled for decode speed: exactly the canon() text of the
 * same eleven parts (pinned by the golden seals and the record round-trip property).
 */
const sealOfClean = (c: CleanExpense): string =>
  fnv36(
    `[${text(c.id)},${text(c.itemName)},${text(c.amount)},${text(c.category)},${text(c.date)}` +
      `,${optText(c.day)},${optText(c.notes)},${text(c.createdAt)},${optText(c.updatedAt)}` +
      `,${c.fs === undefined ? 'null' : canon(c.fs)}` +
      `,${Object.keys(c.extras).length === 0 ? '{}' : canon(c.extras)}]`,
  )

// ── decode (§5.3) ───────────────────────────────────────────────────────────────────────────

const fsStamp = (e: FsEntry | undefined, C: Stamp): Stamp =>
  e === undefined ? C : Math.max(C, ps(typeof e === 'number' ? e : e[0]))
const fsRank = (e: FsEntry | undefined): Rank =>
  e === undefined || typeof e === 'number' ? 2 : e[1]

function build(
  c: CleanExpense,
  C: Stamp,
  keepDay: boolean,
  stampOf: (f: FieldKey) => Stamp,
  rankOf: (f: FieldKey) => Rank,
): ExpenseRec {
  const reg = <T>(f: FieldKey, v: T): Reg<T> => ({ v, s: stampOf(f), r: rankOf(f) })
  const d: DateValue =
    keepDay && c.day !== undefined ? { date: c.date, day: c.day } : { date: c.date }
  return {
    id: c.id,
    createdAt: c.createdAt,
    C,
    n: reg('n', c.itemName),
    a: reg('a', c.amount),
    c: reg('c', c.category),
    d: reg('d', d),
    o: reg<string | null>('o', c.notes ?? null),
    x: reg('x', c.extras),
  }
}

/**
 * The interpretation table. `srcRank` is 1 for local data, v5 and v0.8.5 payloads; 0 for v0.8.4-
 * payloads and backup files. Sealed → per-field stamps; no seal → legacy whole-record write at U;
 * stale seal with a newer updatedAt → old stamped edit at U; stale seal otherwise → rank 0.
 */
export function decodeRecord(c: CleanExpense, srcRank: 0 | 1): ExpenseRec {
  const C = ps(c.createdAt)
  const U = Math.max(C, ps(c.updatedAt))
  const fs: FsMap = c.fs ?? {}
  if (c.h !== undefined && c.h === sealOfClean(c)) {
    return build(
      c,
      C,
      true,
      (f) => fsStamp(fs[f], C),
      (f) => fsRank(fs[f]),
    )
  }
  if (c.h === undefined)
    return build(
      c,
      C,
      false,
      () => U,
      () => srcRank,
    )
  let maxF = C
  for (const f of FIELD_KEYS) maxF = Math.max(maxF, fsStamp(fs[f], C))
  if (U > maxF)
    return build(
      c,
      C,
      false,
      () => U,
      () => srcRank,
    )
  return build(
    c,
    C,
    false,
    (f) => fsStamp(fs[f], C),
    () => 0,
  )
}

// ── encode (§5.4, P-14) ─────────────────────────────────────────────────────────────────────

interface Encoded {
  readonly obj: Readonly<Record<string, unknown>>
  str?: string
  hA?: number
  hB?: number
}
const cache = new WeakMap<ExpenseRec, Encoded>()

export const maxStampRec = (rec: ExpenseRec): Stamp =>
  Math.max(rec.C, rec.n.s, rec.a.s, rec.c.s, rec.d.s, rec.o.s, rec.x.s)

function isUniform(rec: ExpenseRec): boolean {
  const s = rec.n.s
  for (const f of FIELD_KEYS) {
    const g = regOf(rec, f)
    if (g.r !== 1 || g.s !== s) return false
  }
  return rec.d.v.day === undefined
}

function encodeUncached(rec: ExpenseRec): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const put = (k: string, v: unknown): void => {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: false })
  }
  put('id', rec.id)
  put('itemName', rec.n.v)
  put('amount', rec.a.v)
  put('category', rec.c.v)
  put('date', rec.d.v.date)
  if (rec.o.v !== null) put('notes', rec.o.v)
  put('createdAt', rec.createdAt)
  const U = maxStampRec(rec)
  if (U > rec.C) put('updatedAt', iso(U))
  const uniform = isUniform(rec)
  if (!uniform) {
    if (rec.d.v.day !== undefined) put('day', rec.d.v.day)
    const fs: Record<string, unknown> = {}
    let differs = false
    for (const f of FIELD_KEYS) {
      const g = regOf(rec, f)
      if (g.r === 2 && g.s === rec.C) continue
      fs[f] = g.r === 2 ? g.s : Object.freeze([g.s, g.r])
      differs = true
    }
    if (differs) put('fs', Object.freeze(fs))
  }
  const x = rec.x.v
  for (const k of Object.keys(x).sort()) put(k, x[k])
  if (!uniform) put('h', sealOf(out))
  return Object.freeze(out)
}

function encoded(rec: ExpenseRec): Encoded {
  let e = cache.get(rec)
  if (e === undefined) {
    e = { obj: encodeUncached(rec) }
    cache.set(rec, e)
  }
  return e
}

/** The wire object of a record (frozen, cached per record object). */
export const encodeRecord = (rec: ExpenseRec): Readonly<Record<string, unknown>> => encoded(rec).obj

/** JSON of the wire object, cached: shared by the envelope, the wire and the digest. */
export function recordString(rec: ExpenseRec): string {
  const e = encoded(rec)
  e.str ??= JSON.stringify(e.obj)
  return e.str
}

/** The two FNV lanes of the record string, cached (incremental digest, P-13). */
export function recordHashes(rec: ExpenseRec): readonly [number, number] {
  const e = encoded(rec)
  if (e.hA === undefined || e.hB === undefined) {
    const s = recordString(rec)
    e.hA = fnvLane(s, FNV_A)
    e.hB = fnvLane(s, FNV_B)
  }
  return [e.hA, e.hB]
}

/** Exact equality of meaning (the wire form round-trips every register, §5.4). */
export const recEqual = (a: ExpenseRec, b: ExpenseRec): boolean =>
  a === b || recordString(a) === recordString(b)

// ── merge ───────────────────────────────────────────────────────────────────────────────────

/** Order of two registers of one field: (stamp, rank, canon(value)). */
export function cmpReg(p: Reg<unknown>, q: Reg<unknown>): number {
  if (p === q) return 0
  if (p.s !== q.s) return p.s - q.s
  if (p.r !== q.r) return p.r - q.r
  if (p.v === q.v) return 0
  const a = canon(p.v)
  const b = canon(q.v)
  return a < b ? -1 : a > b ? 1 : 0
}

const pick = <T>(p: Reg<T>, q: Reg<T>): Reg<T> => (cmpReg(p, q) >= 0 ? p : q)

/** Product of the six registers; createdAt by (C, createdAt) minimum. Returns a side when equal. */
export function mergeRecord(a: ExpenseRec, b: ExpenseRec): ExpenseRec {
  if (a === b) return a
  const keepA = a.C < b.C || (a.C === b.C && a.createdAt <= b.createdAt)
  const n = pick(a.n, b.n)
  const am = pick(a.a, b.a)
  const c = pick(a.c, b.c)
  const d = pick(a.d, b.d)
  const o = pick(a.o, b.o)
  const x = pick(a.x, b.x)
  if (keepA && n === a.n && am === a.a && c === a.c && d === a.d && o === a.o && x === a.x) return a
  if (!keepA && n === b.n && am === b.a && c === b.c && d === b.d && o === b.o && x === b.x)
    return b
  const base = keepA ? a : b
  return { id: a.id, createdAt: base.createdAt, C: base.C, n, a: am, c, d, o, x }
}

/** Fields whose value differs (a materialisation-only category change is not a loss). */
export function lostFields(before: ExpenseRec, after: ExpenseRec): FieldKey[] {
  if (before === after) return []
  return FIELD_KEYS.filter((f) => {
    const p = regOf(before, f)
    const q = regOf(after, f)
    return p !== q && p.v !== q.v && canon(p.v) !== canon(q.v)
  })
}

// ── ops (§5.5) ──────────────────────────────────────────────────────────────────────────────

export function addRecord(id: string, v: RecordValues, ctx: OpCtx): ExpenseRec {
  const C = tick(ctx.clock, ctx.wall)
  const reg = <T>(value: T): Reg<T> => ({ v: value, s: C, r: 2 })
  return {
    id,
    createdAt: iso(C),
    C,
    n: reg(v.n),
    a: reg(v.a),
    c: reg(v.c),
    d: reg<DateValue>({ date: localNoonIso(v.day), day: v.day }),
    o: reg(v.o),
    x: reg(EMPTY_EXTRAS),
  }
}

/** Stamps only the fields whose value changes, all at one tick above their own stamps. */
export function editRecord(rec: ExpenseRec, patch: RecordPatch, ctx: OpCtx): ExpenseRec {
  const next: { n?: string; a?: number; c?: string; d?: DateValue; o?: string | null } = {}
  if (patch.n !== undefined && patch.n !== rec.n.v) next.n = patch.n
  if (patch.a !== undefined && patch.a !== rec.a.v) next.a = patch.a
  if (patch.c !== undefined && patch.c !== rec.c.v) next.c = patch.c
  if (patch.o !== undefined && patch.o !== rec.o.v) next.o = patch.o
  if (patch.day !== undefined) {
    const current = rec.d.v
    const currentDay = current.day ?? localDay(current.date)
    if (patch.day !== currentDay) {
      const keep = localDay(current.date) === patch.day
      next.d = { date: keep ? current.date : localNoonIso(patch.day), day: patch.day }
    }
  }
  const changed = FIELD_KEYS.filter((f) => f in next)
  if (changed.length === 0) return rec
  const base = Math.max(...changed.map((f) => regOf(rec, f).s))
  const t = tick(ctx.clock, ctx.wall, base)
  const at = <T>(v: T): Reg<T> => ({ v, s: t, r: 2 })
  return {
    ...rec,
    ...(next.n === undefined ? {} : { n: at(next.n) }),
    ...(next.a === undefined ? {} : { a: at(next.a) }),
    ...(next.c === undefined ? {} : { c: at(next.c) }),
    ...(next.d === undefined ? {} : { d: at(next.d) }),
    ...(next.o === undefined ? {} : { o: at(next.o) }),
  }
}

/** Re-creates a record under a new id with fresh stamps; createdAt and C are kept. */
export function reviveRecord(rec: ExpenseRec, newId: string, ctx: OpCtx): ExpenseRec {
  const t = tick(ctx.clock, ctx.wall, maxStampRec(rec))
  const at = <T>(r: Reg<T>): Reg<T> => ({ v: r.v, s: t, r: 2 })
  return {
    id: newId,
    createdAt: rec.createdAt,
    C: rec.C,
    n: at(rec.n),
    a: at(rec.a),
    c: at(rec.c),
    d: at(rec.d),
    o: at(rec.o),
    x: at(rec.x),
  }
}

/** c.v := resolve(c.v). Stamp and rank unchanged: no row is ever re-stamped by a rename (§6.5.3). */
export function materialize(rec: ExpenseRec, resolve: (name: string) => string): ExpenseRec {
  const to = resolve(rec.c.v)
  return to === rec.c.v ? rec : { ...rec, c: { v: to, s: rec.c.s, r: rec.c.r } }
}
