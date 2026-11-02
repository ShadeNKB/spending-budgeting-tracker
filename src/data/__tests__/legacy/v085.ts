// FROZEN: never edit. Model of the shipped v0.8.5 client: app 0.9.2 (PR-0, ab32588 = tag v0.9.2;
// the data layer of v0.9.3 and v0.9.4 is byte-identical).
//
// Re-frozen for PR-2 from the MERGED code (track spec P2-5, LEDGER entry criterion a). PR-1 had
// modelled the PR-0 contract before it merged; what shipped differs: there is no pending-field
// rebase, the echo filter is `wr.rev` plus a content hash and the answered-push rule, stamps use
// lib/stamps.ts (a fixed window, its own ISO grammar), item mappings carry `mappingUpdatedAt`,
// legacy ties keep local re-files (`keepLocalRefiles`), and the merge is whole-record
// last-writer-wins. Verbatim logic from the files at ab32588:
//   src/types.ts:1-10, 40-58              Expense, CategoryMappingTimestamps, BackupData
//   src/lib/stamps.ts:12-67               STAMP_MIN, STAMP_MAX, LEGACY_STAMP_ISO, isoMs, stampMs, nextStampIso
//   src/lib/canon.ts:4-80                 canon (depth cap), nestsWithin, canonRow, fnv1a
//   src/lib/backup.ts:9-103               isRecord, listOf, recordOf (from entries), parseBackup
//   src/services/syncService.ts:19-75     caps, WriterStamp, SyncPayload, errors
//   src/services/syncService.ts:144-454   isSyncableExpense, readRemote, contentKey, mergeBackups
//   src/services/syncService.ts:502-548   pushSync's size guard, pullSync
//   src/services/storage.ts:11-277        keys, getters (repair, removeItem on failure), saveAll, getDeviceId
//   src/stores/useExpenseStore.ts:75-663  store reducers, forward undo, persistence (400 ms debounce)
//   src/stores/applySync.ts:14-84         structure-sharing apply, written at once
//   src/stores/syncEngine.ts:54-715       single flight + again, mergeStep, keepLocalRefiles, echo
//                                         filter (rev + content + answered), old-writer memo, backoff,
//                                         realtime coalescing, setup, lifecycle triggers
//   src/stores/useSyncStore.ts:235-243, 355-392   keepCode, initSync, disconnectSync, triggerSync
//   src/utils/helpers.ts:6-8              generateId (v084 makeGenerateId)
// Permitted deviations (P-25), each marked FROZEN-DEVIATION: the injected clock (Date.now, new
// Date() and the timers they drive), the injected rng (Math.random in generateId and
// crypto.getRandomValues in newRev and newDeviceId), the injected storage (localStorage), and the
// relay port that replaces the Supabase client. Not modelled, because they change neither the data
// nor what is sent: toasts and their routing, the failure streak's copy, lookForNewBuild, the
// demo branch of hydrate (statically dead on the owner's build), the engine chunk's lazy load.
// Casts that exist in the shipped code are kept and marked FROZEN-VERBATIM.
import Fuse from 'fuse.js'
import { isSameDay, isValid, parseISO } from 'date-fns'
import {
  DEFAULT_CATEGORIES,
  FUSE_SCORE_CUTOFF,
  FUSE_THRESHOLD,
  makeGenerateId,
  type CategoryBudgetTimestamps,
  type CategoryBudgets,
  type CategoryMappings,
  type ClockPort,
  type StoragePort,
} from './v084'

// ── src/types.ts ────────────────────────────────────────────────────────────────────────────
export interface Expense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  notes?: string
  createdAt: string
  updatedAt?: string
}
/** When each item mapping was last set (ISO). Keys without a stamp are older than any stamp. */
export type CategoryMappingTimestamps = Record<string, string>
export interface BackupData {
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  mappingUpdatedAt?: CategoryMappingTimestamps
  budgets?: CategoryBudgets
  budgetUpdatedAt?: CategoryBudgetTimestamps
  budgetDeletedAt?: CategoryBudgetTimestamps
  deletedIds?: string[]
  exportDate: string
  version: string
}

// ── injected relay port (FROZEN-DEVIATION) ──────────────────────────────────────────────────
/** A realtime row event as syncService's `changeOf` builds it from postgres_changes. */
export interface RelayChange {
  readonly payload: unknown
  readonly updatedAt: string | null
}
/**
 * The Supabase relay row (select payload, plain upsert, postgres_changes). `subscribe` passes the
 * change payload: the echo filter reads it. The channel has no status here: SUBSCRIBED is taken to
 * arrive as the subscription opens (it runs one catch-up cycle, as it does in the app).
 */
export interface RelayPort085 {
  pull(syncId: string): Promise<{ payload: unknown } | null>
  push(syncId: string, payload: unknown): Promise<void>
  subscribe(syncId: string, onChange: (c: RelayChange) => void): () => void
}

// ── src/lib/stamps.ts ───────────────────────────────────────────────────────────────────────
export const STAMP_MIN = Date.UTC(2000, 0, 1)
export const STAMP_MAX = Date.UTC(2100, 0, 1)
/** Written for budgets whose set time is unknown. Orders as 0. */
export const LEGACY_STAMP_ISO = '1970-01-01T00:00:00.000Z'

/** yyyy-MM-dd, then optionally [T or space]HH:mm[:ss[.fraction]] and an offset (Z, ±HH, ±HHmm, ±HH:mm). */
const ISO_STAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const daysIn = (y: number, mo: number): number =>
  mo === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : (DAYS_IN_MONTH[mo - 1] ?? 0)

/** Minutes east of UTC of an offset group, or NaN when out of range. */
function offsetMinutes(z: string): number {
  if (z === 'Z') return 0
  const hh = Number(z.slice(1, 3))
  const mm = z.length > 3 ? Number(z.slice(-2)) : 0
  if (hh > 23 || mm > 59) return Number.NaN
  return (z.startsWith('-') ? -1 : 1) * (hh * 60 + mm)
}

function isoMs(text: string): number {
  const m = ISO_STAMP.exec(text)
  if (m === null) return Number.NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4] ?? 0)
  const mi = Number(m[5] ?? 0)
  const sec = Number(m[6] ?? 0)
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))
  const endOfDay = h === 24 && mi === 0 && sec === 0 && ms === 0
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || (h > 23 && !endOfDay)) return Number.NaN
  if (mi > 59 || sec > 59) return Number.NaN
  const off = offsetMinutes(m[8] ?? 'Z')
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - off * 60_000
}

/** Epoch ms of an ISO stamp inside [2000, 2100), else 0 ("unknown", loses to every real stamp). */
export function stampMs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const t = isoMs(value)
  return Number.isFinite(t) && t >= STAMP_MIN && t < STAMP_MAX ? Math.floor(t) : 0
}

/** A stamp at `now`, but strictly after every base it supersedes (a slow clock still wins). */
export function nextStampIso(now: number, ...bases: number[]): string {
  const t = Math.min(STAMP_MAX - 1, Math.max(Math.floor(now), ...bases.map((b) => b + 1)))
  return new Date(t).toISOString()
}

// ── src/lib/canon.ts ────────────────────────────────────────────────────────────────────────
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

export const CANON_MAX_DEPTH = 64
const TOO_DEEP = '\u0000'

function write(value: unknown, depth: number): string {
  if (!isObject(value)) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return 'null'
    }
    return JSON.stringify(value)
  }
  if (depth >= CANON_MAX_DEPTH) return TOO_DEEP
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    return `[${items.map((item) => write(item, depth + 1)).join(',')}]`
  }
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const member: unknown = Reflect.get(value, key)
    if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue
    parts.push(`${JSON.stringify(key)}:${write(member, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

/** JSON with object keys sorted, `undefined` members dropped and arrays kept in order. */
export function canon(value: unknown): string {
  return write(value, 0)
}

export function nestsWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, depth] = next
    if (!isObject(item)) continue
    if (depth > max) return false
    const children: readonly unknown[] = Array.isArray(item) ? item : Object.values(item)
    for (const child of children) stack.push([child, depth + 1])
  }
  return true
}

const rowCache = new WeakMap<object, string>()

/** `canon` with a per-object cache, for expense rows. */
export function canonRow(row: unknown): string {
  if (!isObject(row)) return canon(row)
  const cached = rowCache.get(row)
  if (cached !== undefined) return cached
  const text = canon(row)
  rowCache.set(row, text)
  return text
}

/** FNV-1a 32-bit over UTF-16 code units, in base 36. Detects change; it is not security. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

// ── src/lib/backup.ts ───────────────────────────────────────────────────────────────────────
export const MAX_IMPORT_EXPENSES = 50_000

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isString = (value: unknown): value is string => typeof value === 'string'
export const isNumber = (value: unknown): value is number => typeof value === 'number'

export function listOf<T>(value: unknown, isItem: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(isItem) : []
}

export function recordOf<T>(
  value: unknown,
  isEntry: (entry: unknown) => entry is T,
): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, T] => isEntry(pair[1])),
  )
}

export class BackupTooLargeError extends Error {
  constructor(public readonly count: number) {
    super(`Backup has ${count.toLocaleString()} entries — too large to import safely.`)
    this.name = 'BackupTooLargeError'
  }
}

function optionalString(value: unknown, field: string, itemName: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`bad ${field} on "${itemName}"`)
  return value
}

export function parseBackupExpense(value: unknown): Expense {
  if (!isRecord(value)) throw new Error('malformed expense')
  const { id, itemName, amount, date, category } = value
  if (typeof id !== 'string' || !id) throw new Error('missing id')
  if (typeof itemName !== 'string') throw new Error('missing itemName')
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`bad amount on "${itemName}"`)
  }
  if (typeof date !== 'string' || !isValid(parseISO(date))) {
    throw new Error(`bad date on "${itemName}"`)
  }
  if (typeof category !== 'string') throw new Error('missing category')
  const createdAt = optionalString(value.createdAt, 'createdAt', itemName) ?? date
  const updatedAt = optionalString(value.updatedAt, 'updatedAt', itemName)
  const notes = optionalString(value.notes, 'notes', itemName)
  return {
    id,
    itemName,
    amount,
    category,
    date,
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(notes === undefined ? {} : { notes }),
  }
}

export function parseBackup(raw: unknown, clock: ClockPort): BackupData {
  if (!isRecord(raw)) throw new Error('not an object')
  const rawExpenses = raw.expenses
  if (!Array.isArray(rawExpenses)) throw new Error('missing expenses[]')
  if (rawExpenses.length > MAX_IMPORT_EXPENSES) throw new BackupTooLargeError(rawExpenses.length)
  return {
    expenses: rawExpenses.map((x: unknown) => parseBackupExpense(x)),
    categories: listOf(raw.categories, isString),
    categoryMappings: recordOf(raw.categoryMappings, isString),
    mappingUpdatedAt: recordOf(raw.mappingUpdatedAt, isString),
    budgets: recordOf(raw.budgets, isNumber),
    budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
    budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
    deletedIds: listOf(raw.deletedIds, isString),
    // FROZEN-DEVIATION: new Date() is the injected clock.
    exportDate:
      typeof raw.exportDate === 'string' ? raw.exportDate : new Date(clock.now()).toISOString(),
    version: typeof raw.version === 'string' ? raw.version : '4.0',
  }
}

// ── src/services/syncService.ts ─────────────────────────────────────────────────────────────
const PAYLOAD_WARN_BYTES = 800 * 1024
const PAYLOAD_MAX_CHARS = 1024 * 1024
export const TOMBSTONE_CAP = 20_000

export type WriterClass = 'v5' | 'v085' | 'legacy'

export interface WriterStamp {
  app: string
  dev: string
  rev: string
  at: string
}

export type SyncPayload = Omit<BackupData, 'expenses'> & {
  expenses: readonly unknown[]
  wr: WriterStamp
}

export type RemoteRead =
  | { kind: 'empty' }
  | { kind: 'moved' }
  | { kind: 'update-required' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'ok'
      data: BackupData
      passthrough: unknown[]
      writer: WriterClass
    }

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`Sync payload is ${(bytes / 1024).toFixed(0)} KB — too large to safely sync.`)
    this.name = 'PayloadTooLargeError'
  }
}

export type TransportErrorKind = 'network' | 'server' | 'permission'

export class SyncTransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'SyncTransportError'
  }
}

const optionalText = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'string'

const ROW_MAX_NESTING = 16

export function isSyncableExpense(row: unknown): row is Expense {
  if (!isRecord(row)) return false
  const { id, itemName, amount, date, category } = row
  return (
    typeof id === 'string' &&
    id !== '' &&
    typeof itemName === 'string' &&
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    typeof date === 'string' &&
    isValid(parseISO(date)) &&
    typeof category === 'string' &&
    optionalText(row.notes) &&
    (row.createdAt === undefined || typeof row.createdAt === 'string') &&
    (row.updatedAt === undefined || typeof row.updatedAt === 'string') &&
    nestsWithin(row, ROW_MAX_NESTING)
  )
}

function writerOf(raw: Record<string, unknown>): WriterClass {
  if (isRecord(raw.x5)) return 'v5'
  if (isRecord(raw.wr)) return 'v085'
  return 'legacy'
}

/** Classifies and reads a pulled payload. Never throws. */
export function readRemote(raw: unknown): RemoteRead {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'the synced copy is not an object' }
  if (raw.expenses === 'moved') return { kind: 'moved' }
  const x5 = raw.x5
  if (isRecord(x5) && typeof x5.min === 'number' && x5.min > 4) return { kind: 'update-required' }
  const rows = raw.expenses
  if (!Array.isArray(rows))
    return { kind: 'invalid', reason: 'the synced copy has no expense list' }

  const items: readonly unknown[] = rows
  const writer = writerOf(raw)
  const expenses: Expense[] = []
  const passthrough: unknown[] = []
  for (const item of items) {
    if (isSyncableExpense(item)) expenses.push(item)
    else passthrough.push(item)
  }
  return {
    kind: 'ok',
    data: {
      expenses,
      categories: listOf(raw.categories, isString),
      categoryMappings: recordOf(raw.categoryMappings, isString),
      mappingUpdatedAt: recordOf(raw.mappingUpdatedAt, isString),
      budgets: recordOf(raw.budgets, isNumber),
      budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
      budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
      deletedIds: listOf(raw.deletedIds, isString),
      exportDate: typeof raw.exportDate === 'string' ? raw.exportDate : '',
      version: '4.0',
    },
    passthrough,
    writer,
  }
}

function sortedList(value: unknown, item: (x: unknown) => string): unknown {
  if (!Array.isArray(value)) return value
  const items: readonly unknown[] = value
  return items.map(item).sort()
}

function sortedSet(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const items: readonly unknown[] = value
  return [...new Set(items.map(canon))].sort()
}

export function contentKey(payload: unknown, opts: { mappingStamps?: boolean } = {}): string {
  const p = isRecord(payload) ? payload : {}
  return canon({
    expenses: sortedList(p.expenses, canonRow),
    categories: sortedSet(p.categories),
    categoryMappings: p.categoryMappings,
    mappingUpdatedAt: opts.mappingStamps === false ? {} : (p.mappingUpdatedAt ?? {}),
    budgets: p.budgets,
    budgetUpdatedAt: p.budgetUpdatedAt,
    budgetDeletedAt: p.budgetDeletedAt ?? {},
    deletedIds: sortedSet(p.deletedIds),
  })
}

const ownEntries = <T>(record: Record<string, T> | undefined): [string, T][] =>
  record ? Object.entries(record) : []

const expenseStamp = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

/** The newer copy; on equal stamps the larger canonical JSON (the local copy when identical). */
function pickExpense(l: Expense, r: Expense): Expense {
  const lt = expenseStamp(l)
  const rt = expenseStamp(r)
  if (lt !== rt) return lt > rt ? l : r
  return canonRow(l) >= canonRow(r) ? l : r
}

const larger = (a: string, b: string): string => (a >= b ? a : b)

interface MappingSide {
  value: string
  at: string | undefined
  t: number
}

function mappingSide(
  values: Map<string, string>,
  stamps: Map<string, string>,
  key: string,
): MappingSide | null {
  const value = values.get(key)
  if (value === undefined) return null
  const at = stamps.get(key)
  return { value, at, t: stampMs(at) }
}

/** The newer pick; on equal stamps the larger value, then the larger stamp text. */
function pickMapping(l: MappingSide, r: MappingSide): MappingSide {
  if (l.t !== r.t) return l.t > r.t ? l : r
  if (l.value !== r.value) return l.value > r.value ? l : r
  return (l.at ?? '') >= (r.at ?? '') ? l : r
}

function mergeMappings(
  local: BackupData,
  remote: BackupData,
): Pick<BackupData, 'categoryMappings' | 'mappingUpdatedAt'> {
  const lv = new Map(ownEntries(local.categoryMappings))
  const rv = new Map(ownEntries(remote.categoryMappings))
  const ls = new Map(ownEntries(local.mappingUpdatedAt))
  const rs = new Map(ownEntries(remote.mappingUpdatedAt))
  const mappings: [string, string][] = []
  const stamps: [string, string][] = []
  for (const key of new Set([...lv.keys(), ...rv.keys()])) {
    const l = mappingSide(lv, ls, key)
    const r = mappingSide(rv, rs, key)
    const winner = l && r ? pickMapping(l, r) : (l ?? r)
    if (!winner) continue
    mappings.push([key, winner.value])
    if (winner.t > 0 && winner.at !== undefined) stamps.push([key, winner.at])
  }
  return {
    categoryMappings: Object.fromEntries(mappings),
    mappingUpdatedAt: Object.fromEntries(stamps),
  }
}

interface BudgetSide {
  value: number | undefined
  set: number
  setAt: string | undefined
  del: number
  delAt: string | undefined
}

function budgetSide(
  budgets: Map<string, number>,
  updatedAt: Map<string, string>,
  deletedAt: Map<string, string>,
  key: string,
): BudgetSide {
  const raw = budgets.get(key)
  const value = raw !== undefined && Number.isFinite(raw) ? raw : undefined
  const setAt = updatedAt.get(key)
  const delAt = deletedAt.get(key)
  return {
    value,
    set: value === undefined ? -1 : stampMs(setAt),
    setAt,
    del: delAt === undefined ? -1 : stampMs(delAt),
    delAt,
  }
}

function mergeBudgets(local: BackupData, remote: BackupData) {
  const lb = new Map(ownEntries(local.budgets))
  const rb = new Map(ownEntries(remote.budgets))
  const lu = new Map(ownEntries(local.budgetUpdatedAt))
  const ru = new Map(ownEntries(remote.budgetUpdatedAt))
  const ld = new Map(ownEntries(local.budgetDeletedAt))
  const rd = new Map(ownEntries(remote.budgetDeletedAt))
  const keys = new Set([
    ...lb.keys(),
    ...rb.keys(),
    ...lu.keys(),
    ...ru.keys(),
    ...ld.keys(),
    ...rd.keys(),
  ])

  const budgets: [string, number][] = []
  const updatedAt: [string, string][] = []
  const deletedAt: [string, string][] = []

  for (const key of keys) {
    const l = budgetSide(lb, lu, ld, key)
    const r = budgetSide(rb, ru, rd, key)
    const maxDel = Math.max(l.del, r.del)
    const maxSet = Math.max(l.set, r.set)

    if (maxDel > 0 && maxDel >= maxSet) {
      const stamps = [l, r].filter((s) => s.del === maxDel).map((s) => s.delAt ?? '')
      deletedAt.push([key, stamps.reduce(larger)])
      continue
    }
    if (maxSet >= 0) {
      let winner: BudgetSide | null = null
      for (const side of [l, r]) {
        if (side.value === undefined || side.set !== maxSet) continue
        if (
          winner?.value === undefined ||
          side.value > winner.value ||
          (side.value === winner.value && (side.setAt ?? '') > (winner.setAt ?? ''))
        ) {
          winner = side
        }
      }
      if (winner?.value !== undefined) {
        budgets.push([key, winner.value])
        updatedAt.push([
          key,
          maxSet > 0 && winner.setAt !== undefined ? winner.setAt : LEGACY_STAMP_ISO,
        ])
      }
    }
  }

  return {
    budgets: Object.fromEntries(budgets),
    budgetUpdatedAt: Object.fromEntries(updatedAt),
    budgetDeletedAt: Object.fromEntries(deletedAt),
  }
}

export function mergeBackups(local: BackupData, remote: BackupData, clock: ClockPort): BackupData {
  const localMap = new Map<string, Expense>(local.expenses.map((e) => [e.id, e]))
  const remoteMap = new Map<string, Expense>(remote.expenses.map((e) => [e.id, e]))

  const tombstones = new Set<string>([...(local.deletedIds ?? []), ...(remote.deletedIds ?? [])])

  const merged: Expense[] = []
  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    if (tombstones.has(id)) continue
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (l && r) merged.push(pickExpense(l, r))
    else if (l) merged.push(l)
    else if (r) merged.push(r)
  }

  const time = new Map(merged.map((e) => [e, new Date(e.date).getTime()]))
  merged.sort((a, b) => (time.get(b) ?? 0) - (time.get(a) ?? 0))

  const categories = [...new Set([...local.categories, ...remote.categories])]
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES)

  return {
    expenses: merged,
    categories,
    ...mergeMappings(local, remote),
    ...mergeBudgets(local, remote),
    deletedIds: [...tombstones].slice(-TOMBSTONE_CAP),
    // FROZEN-DEVIATION: new Date() is the injected clock.
    exportDate: new Date(clock.now()).toISOString(),
    version: '4.0',
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── src/services/storage.ts ─────────────────────────────────────────────────────────────────
const KEY_EXPENSES = 'expenses'
const KEY_CATEGORIES = 'categories'
const KEY_MAPPINGS = 'categoryMappings'
const KEY_MAPPING_UPDATED_AT = 'categoryMappingUpdatedAt'
const KEY_BUDGETS = 'categoryBudgets'
const KEY_BUDGET_UPDATED_AT = 'categoryBudgetUpdatedAt'
const KEY_BUDGET_DELETED_AT = 'categoryBudgetDeletedAt'
const KEY_DELETED_IDS = 'deletedExpenseIds'
const KEY_SYNC_ID = 'syncId'
const KEY_APP = 'spendtrack:app'
const KEY_DEVICE = 'spendtrack:dev'

export const WRITER_VERSION = '0.8.5'

const DEVICE_ID_PATTERN = /^[0-9a-z]{6}$/

export class StorageQuotaError extends Error {
  constructor(
    public key: string,
    public bytes: number,
  ) {
    super(`localStorage quota exceeded while writing "${key}" (${bytes} bytes).`)
    this.name = 'StorageQuotaError'
  }
}

export function makeStorage092(localStorage: StoragePort, rng: () => number) {
  let sessionDeviceId: string | null = null

  // FROZEN-DEVIATION: crypto.getRandomValues is the injected rng.
  function newDeviceId(): string {
    const bytes = Array.from({ length: 6 }, () => Math.floor(rng() * 256))
    return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
  }

  // FROZEN-DEVIATION: no window, so the quota event is not dispatched.
  function safeSet(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch (err) {
      const isQuota =
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      if (isQuota) throw new StorageQuotaError(key, value.length)
      throw err
    }
  }

  return {
    getExpenses(): Expense[] {
      try {
        const raw = localStorage.getItem(KEY_EXPENSES)
        if (!raw) return []
        // FROZEN-VERBATIM
        const parsed = JSON.parse(raw) as unknown
        // FROZEN-VERBATIM: object rows are kept as they are (F-005).
        if (Array.isArray(parsed)) return listOf(parsed, isRecord) as unknown as Expense[]
      } catch {
        try {
          const raw = localStorage.getItem(KEY_EXPENSES)
          if (raw) {
            const repaired = raw.replace(/,(\s*[}\]])/g, '$1')
            // FROZEN-VERBATIM
            const parsed = JSON.parse(repaired) as unknown
            // FROZEN-VERBATIM
            if (Array.isArray(parsed)) return listOf(parsed, isRecord) as unknown as Expense[]
          }
        } catch {
          localStorage.removeItem(KEY_EXPENSES)
        }
      }
      return []
    },
    saveExpenses(data: Expense[]): void {
      safeSet(KEY_EXPENSES, JSON.stringify(data))
    },
    getCategories(): string[] | null {
      try {
        const raw = localStorage.getItem(KEY_CATEGORIES)
        if (!raw) return null
        const categories = listOf(JSON.parse(raw), isString)
        if (categories.length > 0) return categories
      } catch {
        localStorage.removeItem(KEY_CATEGORIES)
      }
      return null
    },
    saveCategories(data: string[]): void {
      safeSet(KEY_CATEGORIES, JSON.stringify(data))
    },
    getCategoryMappings(): CategoryMappings {
      try {
        const raw = localStorage.getItem(KEY_MAPPINGS)
        if (raw) return recordOf(JSON.parse(raw), isString)
      } catch {
        localStorage.removeItem(KEY_MAPPINGS)
      }
      return {}
    },
    saveCategoryMappings(data: CategoryMappings): void {
      safeSet(KEY_MAPPINGS, JSON.stringify(data))
    },
    getMappingUpdatedAt(): CategoryMappingTimestamps {
      try {
        const raw = localStorage.getItem(KEY_MAPPING_UPDATED_AT)
        if (raw) return recordOf(JSON.parse(raw), isString)
      } catch {
        localStorage.removeItem(KEY_MAPPING_UPDATED_AT)
      }
      return {}
    },
    saveMappingUpdatedAt(data: CategoryMappingTimestamps): void {
      safeSet(KEY_MAPPING_UPDATED_AT, JSON.stringify(data))
    },
    getBudgets(): CategoryBudgets {
      try {
        const raw = localStorage.getItem(KEY_BUDGETS)
        if (raw) return recordOf(JSON.parse(raw), isNumber)
      } catch {
        localStorage.removeItem(KEY_BUDGETS)
      }
      return {}
    },
    saveBudgets(data: CategoryBudgets): void {
      safeSet(KEY_BUDGETS, JSON.stringify(data))
    },
    getBudgetUpdatedAt(): CategoryBudgetTimestamps {
      try {
        const raw = localStorage.getItem(KEY_BUDGET_UPDATED_AT)
        if (raw) return recordOf(JSON.parse(raw), isString)
      } catch {
        localStorage.removeItem(KEY_BUDGET_UPDATED_AT)
      }
      return {}
    },
    saveBudgetUpdatedAt(data: CategoryBudgetTimestamps): void {
      safeSet(KEY_BUDGET_UPDATED_AT, JSON.stringify(data))
    },
    getBudgetDeletedAt(): CategoryBudgetTimestamps {
      try {
        const raw = localStorage.getItem(KEY_BUDGET_DELETED_AT)
        if (raw) return recordOf(JSON.parse(raw), isString)
      } catch {
        localStorage.removeItem(KEY_BUDGET_DELETED_AT)
      }
      return {}
    },
    saveBudgetDeletedAt(data: CategoryBudgetTimestamps): void {
      safeSet(KEY_BUDGET_DELETED_AT, JSON.stringify(data))
    },
    getDeletedIds(): string[] {
      try {
        const raw = localStorage.getItem(KEY_DELETED_IDS)
        if (!raw) return []
        // FROZEN-VERBATIM
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed))
          return parsed.filter((id): id is string => typeof id === 'string')
      } catch {
        localStorage.removeItem(KEY_DELETED_IDS)
      }
      return []
    },
    saveDeletedIds(data: string[]): void {
      safeSet(KEY_DELETED_IDS, JSON.stringify(data))
    },
    saveAll(
      expenses: Expense[],
      categories: string[],
      mappings: CategoryMappings,
      budgets?: CategoryBudgets,
      budgetUpdatedAt?: CategoryBudgetTimestamps,
      budgetDeletedAt?: CategoryBudgetTimestamps,
      deletedIds?: string[],
      mappingUpdatedAt?: CategoryMappingTimestamps,
    ): void {
      this.saveExpenses(expenses)
      this.saveCategories(categories)
      this.saveCategoryMappings(mappings)
      if (mappingUpdatedAt !== undefined) this.saveMappingUpdatedAt(mappingUpdatedAt)
      if (budgets !== undefined) this.saveBudgets(budgets)
      if (budgetUpdatedAt !== undefined) this.saveBudgetUpdatedAt(budgetUpdatedAt)
      if (budgetDeletedAt !== undefined) this.saveBudgetDeletedAt(budgetDeletedAt)
      if (deletedIds !== undefined) this.saveDeletedIds(deletedIds)
      try {
        safeSet(KEY_APP, WRITER_VERSION)
      } catch {
        // The marker is best-effort; the data keys above are what matter.
      }
    },
    getDeviceId(): string {
      try {
        const stored = localStorage.getItem(KEY_DEVICE)
        if (stored !== null && DEVICE_ID_PATTERN.test(stored)) return stored
      } catch {
        // Storage unavailable: fall through to the session id.
      }
      sessionDeviceId ??= newDeviceId()
      try {
        safeSet(KEY_DEVICE, sessionDeviceId)
      } catch {
        // Not persisted; the id still holds for this session.
      }
      return sessionDeviceId
    },
    getSyncId(): string | null {
      return localStorage.getItem(KEY_SYNC_ID)
    },
    saveSyncId(id: string | null): void {
      if (id === null) {
        localStorage.removeItem(KEY_SYNC_ID)
      } else {
        safeSet(KEY_SYNC_ID, id)
      }
    },
  }
}
export type V092Storage = ReturnType<typeof makeStorage092>

// ── src/stores/useExpenseStore.ts (helpers) ─────────────────────────────────────────────────
type EditableField = 'itemName' | 'amount' | 'category' | 'date' | 'notes'
const EDITABLE_FIELDS: readonly EditableField[] = [
  'itemName',
  'amount',
  'category',
  'date',
  'notes',
]
type EditableValues = Partial<Pick<Expense, EditableField>>

const idOf = (row: unknown): string | undefined =>
  isRecord(row) && typeof row.id === 'string' ? row.id : undefined

const stampOf = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

function sameValue(field: EditableField, a: unknown, b: unknown): boolean {
  if (field === 'notes') return (a ?? undefined) === (b ?? undefined)
  if (field === 'date' && typeof a === 'string' && typeof b === 'string') {
    return a === b || isSameDay(parseISO(a), parseISO(b))
  }
  return Object.is(a, b)
}

function pickFields(from: EditableValues, fields: Iterable<EditableField>): EditableValues {
  const out: EditableValues = {}
  for (const field of fields) Object.assign(out, { [field]: from[field] })
  return out
}

function changedFields(prev: Expense, patch: Partial<Expense>): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => {
    if (!Object.hasOwn(patch, field)) return false
    const next = patch[field]
    if (next === undefined && field !== 'notes') return false
    return !sameValue(field, prev[field], next)
  })
}

function refile(expenses: Expense[], from: string, to: string, now: number): Expense[] {
  if (from === to) return expenses
  const next = expenses.map((e) =>
    idOf(e) === undefined || e.category !== from
      ? e
      : { ...e, category: to, updatedAt: nextStampIso(now, stampOf(e)) },
  )
  return next.some((e, i) => e !== expenses[i]) ? next : expenses
}

const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const nextKeyStamp = (now: number, key: string, ...stamps: Readonly<Record<string, string>>[]) =>
  nextStampIso(now, ...stamps.map((at) => stampMs(ownValue(at, key))))

function remap(
  mappings: CategoryMappings,
  stamps: CategoryMappingTimestamps,
  from: string,
  to: string,
  now: number,
): Pick<V085State, 'categoryMappings' | 'mappingUpdatedAt'> {
  const keys = Object.keys(mappings).filter((key) => mappings[key] === from)
  if (from === to || keys.length === 0) {
    return { categoryMappings: mappings, mappingUpdatedAt: stamps }
  }
  return {
    categoryMappings: Object.fromEntries(
      Object.entries(mappings).map(([key, value]) => [key, value === from ? to : value]),
    ),
    mappingUpdatedAt: {
      ...stamps,
      ...Object.fromEntries(keys.map((key) => [key, nextKeyStamp(now, key, stamps)])),
    },
  }
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(record, key)) return record
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

export function completeBudgetUpdatedAt(
  budgets: CategoryBudgets,
  existing: CategoryBudgetTimestamps | undefined,
  fallback: string,
): CategoryBudgetTimestamps {
  return Object.fromEntries(
    Object.keys(budgets).map((category) => [
      category,
      (existing && ownValue(existing, category)) ?? fallback,
    ]),
  )
}

// ── src/stores/applySync.ts (helpers) ───────────────────────────────────────────────────────
function shareRows(current: readonly Expense[], next: readonly Expense[]): Expense[] | null {
  const byId = new Map<string, Expense>()
  const unused = new Map<Expense, number>()
  for (const row of current) {
    unused.set(row, (unused.get(row) ?? 0) + 1)
    const id = idOf(row)
    if (id !== undefined && !byId.has(id)) byId.set(id, row)
  }
  let changed = next.length !== current.length
  const rows = next.map((row) => {
    let kept = row
    if (!unused.has(row)) {
      const id = idOf(row)
      const mine = id === undefined ? undefined : byId.get(id)
      if (mine !== undefined && canonRow(mine) === canonRow(row)) kept = mine
    }
    const left = unused.get(kept) ?? 0
    if (left > 0) unused.set(kept, left - 1)
    else changed = true
    return kept
  })
  return changed ? rows : null
}

function keepIfSameSet(current: string[], next: string[]): string[] {
  const a = new Set(current)
  const b = new Set(next)
  return a.size === b.size && [...a].every((x) => b.has(x)) ? current : next
}

const keepIfEqual = <T>(current: T, next: T): T => (canon(current) === canon(next) ? current : next)

// ── src/stores/syncEngine.ts (pure parts) ───────────────────────────────────────────────────
const PUSH_DEBOUNCE_MS = 3000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60_000
const REMOTE_COALESCE_MS = 300
const REMOTE_MIN_GAP_MS = 2000
const RESUME_AFTER_MS = 30_000
const OLD_WRITER_MEMO_MS = 10 * 60_000
const ECHO_MEMORY = 8
const PERSIST_DEBOUNCE_MS = 400
const FAILING_AFTER_MS = 10 * 60_000

function remember<T>(list: T[], value: T) {
  list.push(value)
  if (list.length > ECHO_MEMORY) list.shift()
}

/** The relay before its first push: merging with it normalises the local copy. */
const EMPTY: BackupData = {
  expenses: [],
  categories: [],
  categoryMappings: {},
  deletedIds: [],
  exportDate: '',
  version: '4.0',
}

/**
 * A v0.8.4 device re-files rows by keyword (and renames) without touching their stamps, so its
 * copy ties with this one and differs only in the category. This device keeps its own copy.
 * Only for a legacy writer: v0.8.5 and v5 stamp every change.
 */
export function keepLocalRefiles(
  merged: BackupData,
  local: readonly Expense[],
  remote: readonly Expense[],
): BackupData {
  const mine = new Map(local.map((e) => [e.id, e]))
  const theirs = new Map(remote.map((e) => [e.id, e]))
  const expenses = merged.expenses.map((m) => {
    const l = mine.get(m.id)
    const r = theirs.get(m.id)
    if (!l || !r || m === l || l.category === r.category || stampOf(l) !== stampOf(r)) return m
    if (canon({ ...l, category: undefined }) !== canon({ ...r, category: undefined })) return m
    return l
  })
  return expenses.some((e, i) => e !== merged.expenses[i]) ? { ...merged, expenses } : merged
}

// ── the client: store + persistence + engine + sync store ───────────────────────────────────
interface UndoEntry085 {
  id: string
  label: string
  expiresAt: number
  undo: () => void
}

export interface V085State {
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  mappingUpdatedAt: CategoryMappingTimestamps
  budgets: CategoryBudgets
  budgetUpdatedAt: CategoryBudgetTimestamps
  budgetDeletedAt: CategoryBudgetTimestamps
  deletedIds: string[]
  hydrated: boolean
  syncStatus: 'idle' | 'saving' | 'saved' | 'error'
  lastSavedAt: number | null
  undoStack: UndoEntry085[]
}

/** The collections both the persistence listener and the engine's local-change listener select. */
const DATA_KEYS = [
  'expenses',
  'categories',
  'categoryMappings',
  'mappingUpdatedAt',
  'budgets',
  'budgetUpdatedAt',
  'budgetDeletedAt',
  'deletedIds',
] as const

export type SyncErrorKind = 'network' | 'server' | 'permission' | 'invalid'
export type SyncPauseReason = 'too-large' | 'moved' | 'update-required'
export type SyncResult085 =
  | { ok: true; pushed: boolean; changedLocal: boolean }
  | { ok: false; error: SyncErrorKind | SyncPauseReason | 'off' | 'offline' }
export type CloudStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'paused'
interface SyncFailure {
  kind: SyncErrorKind | SyncPauseReason | 'offline'
  since: number
}

interface SentPush {
  rev: string
  hash: string
  mappingStamps: boolean
  answered: boolean
}

type Step =
  | { kind: 'done'; result: SyncResult085 }
  | {
      kind: 'push'
      payload: SyncPayload
      sent: SentPush
      snapRev: number
      changedLocal: boolean
      memoKey: string | null
    }

class InvalidRemoteError extends Error {}

const offResult = (): SyncResult085 => ({ ok: false, error: 'off' })

const isPausedKind = (kind: SyncFailure['kind']): boolean =>
  kind === 'too-large' || kind === 'moved' || kind === 'update-required'

export class V085Client {
  s: V085State = {
    expenses: [],
    categories: DEFAULT_CATEGORIES,
    categoryMappings: {},
    mappingUpdatedAt: {},
    budgets: {},
    budgetUpdatedAt: {},
    budgetDeletedAt: {},
    deletedIds: [],
    hydrated: false,
    syncStatus: 'idle',
    lastSavedAt: null,
    undoStack: [],
  }
  readonly storage: V092Storage
  readonly generateId: () => string

  // useSyncStore
  syncId: string | null = null
  cloudStatus: CloudStatus = 'off'
  lastSyncAt: number | null = null
  lastError: SyncFailure | null = null
  pendingLocal = false
  waitingForOld = false
  legacyWriterAt: number | null = null
  /** navigator.onLine (FROZEN-DEVIATION: a field the test sets through setOnline). */
  online = true

  /** Instrumentation, not app state: answered pushes and the rev of the last one. */
  pushes = 0
  lastRev: string | null = null

  // persistence (installPersistence)
  private saveTimer: number | null = null
  private unsaved = false

  // syncEngine module state
  private started = false
  private setupGen = 0
  private realtimeUnsub: (() => void) | null = null
  private subscribingGen: number | null = null
  private pushTimer: number | null = null
  private retryTimer: number | null = null
  private remoteTimer: number | null = null
  private retryAttempt = 0
  /** The failure streak's start: it dates `lastError` (keptOffline), nothing else. */
  private streakSince: number | null = null
  private lastRemoteCycleAt = Number.NEGATIVE_INFINITY
  private running = false
  private again = false
  private queued: ((result: SyncResult085) => void)[] = []
  private current: ((result: SyncResult085) => void)[] = []
  private localRev = 0
  private applying = false
  private readonly sentPushes: SentPush[] = []
  private readonly sentUpdatedAt: number[] = []
  private readonly pushedThisSession = new Set<string>()
  readonly oldWriterMemo = new Map<string, number>()

  constructor(
    readonly clock: ClockPort,
    readonly rng: () => number,
    readonly local: StoragePort,
    readonly relay: RelayPort085,
  ) {
    this.storage = makeStorage092(local, rng)
    this.generateId = makeGenerateId(clock, rng)
  }

  /** This device's writer id (created and saved on first use, as getDeviceId does). */
  get dev(): string {
    return this.storage.getDeviceId()
  }

  /** The relay fenced this device off: it never pushes until reloaded. */
  get moved(): boolean {
    return this.lastError?.kind === 'moved' || this.lastError?.kind === 'update-required'
  }

  private now(): number {
    // FROZEN-DEVIATION: Date.now() is the injected clock.
    return this.clock.now()
  }

  private iso(t: number): string {
    return new Date(t).toISOString()
  }

  // ── store: set + the two listeners (installPersistence, engine start) ─────────────────────

  private set(update: Partial<V085State> | ((s: V085State) => Partial<V085State>)): void {
    const prev = this.s
    const next = { ...prev, ...(typeof update === 'function' ? update(prev) : update) }
    this.s = next
    if (!DATA_KEYS.some((k) => prev[k] !== next[k])) return
    this.onPersistChange()
    if (this.started) this.onLocalChange()
  }

  private onPersistChange(): void {
    if (!this.s.hydrated) return
    this.s = { ...this.s, syncStatus: 'saving' }
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, PERSIST_DEBOUNCE_MS)
  }

  flushPendingSave(): void {
    if ((this.saveTimer === null && !this.unsaved) || !this.s.hydrated) return
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.save()
  }

  private save(): void {
    const s = this.s
    try {
      this.storage.saveAll(
        s.expenses,
        s.categories,
        s.categoryMappings,
        s.budgets,
        s.budgetUpdatedAt,
        s.budgetDeletedAt,
        s.deletedIds,
        s.mappingUpdatedAt,
      )
    } catch {
      this.unsaved = true
      this.s = { ...this.s, syncStatus: 'error' }
      return
    }
    this.unsaved = false
    this.s = { ...this.s, syncStatus: 'saved', lastSavedAt: this.now() }
  }

  // ── store actions ───────────────────────────────────────────────────────────────────────

  /** Runs before persistence and the engine subscribe (bootstrap order), so it notifies neither. */
  hydrate(): void {
    try {
      const budgets = this.storage.getBudgets()
      this.s = {
        ...this.s,
        expenses: this.storage.getExpenses(),
        categories: this.storage.getCategories() ?? DEFAULT_CATEGORIES,
        categoryMappings: this.storage.getCategoryMappings(),
        mappingUpdatedAt: this.storage.getMappingUpdatedAt(),
        budgets,
        budgetUpdatedAt: completeBudgetUpdatedAt(
          budgets,
          this.storage.getBudgetUpdatedAt(),
          LEGACY_STAMP_ISO,
        ),
        budgetDeletedAt: this.storage.getBudgetDeletedAt(),
        deletedIds: this.storage.getDeletedIds(),
        hydrated: true,
      }
    } catch {
      this.s = { ...this.s, hydrated: true, syncStatus: 'error' }
    }
  }

  getSmartCategory(itemName: string): string | null {
    const mappings = this.s.categoryMappings
    if (!itemName) return null
    const normalized = itemName.toLowerCase().trim()
    const exact = ownValue(mappings, normalized)
    if (exact) return exact

    const entries = Object.entries(mappings).map(([item, category]) => ({ item, category }))
    if (!entries.length) return null
    const fuse = new Fuse(entries, {
      keys: ['item'],
      threshold: FUSE_THRESHOLD,
      includeScore: true,
      minMatchCharLength: 2,
    })
    const hit = fuse.search(normalized)[0]
    return hit && (hit.score ?? 1) < FUSE_SCORE_CUTOFF ? hit.item.category : null
  }

  addExpense(input: Partial<Expense> & { itemName: string; amount: number }): Expense {
    const amount = input.amount
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a finite number greater than 0.')
    }
    const itemName = input.itemName.trim()
    if (!itemName) throw new Error('Item name is required.')
    const smart = this.getSmartCategory(itemName)
    const category = input.category || smart || 'Other'
    const at = this.now()
    const now = new Date(at).toISOString()
    const expense: Expense = {
      id: this.generateId(),
      itemName,
      amount,
      category,
      date: input.date || now,
      notes: input.notes,
      createdAt: now,
    }

    const normalized = expense.itemName.toLowerCase().trim()
    const learn =
      category !== 'Other' &&
      normalized !== '' &&
      ownValue(this.s.categoryMappings, normalized) !== category

    this.set((s) => {
      const learned: Partial<V085State> = learn
        ? {
            categoryMappings: { ...s.categoryMappings, [normalized]: category },
            mappingUpdatedAt: {
              ...s.mappingUpdatedAt,
              [normalized]: nextKeyStamp(at, normalized, s.mappingUpdatedAt),
            },
          }
        : {}
      const undo: UndoEntry085 = {
        id: `add-${expense.id}`,
        label: `Added "${expense.itemName}"`,
        expiresAt: this.now() + 5000,
        undo: () => {
          this.set((st) => ({
            expenses: st.expenses.filter((e) => idOf(e) !== expense.id),
            deletedIds: [...new Set([...st.deletedIds, expense.id])],
          }))
        },
      }
      return {
        expenses: [expense, ...s.expenses],
        ...learned,
        undoStack: [...s.undoStack, undo].slice(-5),
      }
    })
    return expense
  }

  updateExpense(id: string, patch: Partial<Expense>): void {
    const prev = this.s.expenses.find((e) => idOf(e) === id)
    if (!prev) return
    const fields = changedFields(prev, patch)
    if (fields.length === 0) return
    const now = this.now()
    const next: Expense = {
      ...prev,
      ...pickFields(patch, fields),
      updatedAt: nextStampIso(now, stampOf(prev)),
    }
    this.set((s) => ({
      expenses: s.expenses.map((e) => (idOf(e) === id ? next : e)),
      undoStack: [
        ...s.undoStack,
        {
          id: `update-${id}-${now}`,
          label: 'Updated expense',
          expiresAt: now + 5000,
          undo: () => {
            const current = this.s.expenses.find((e) => idOf(e) === id)
            if (!current) return
            const restored: Expense = {
              ...current,
              ...pickFields(prev, fields),
              updatedAt: nextStampIso(this.now(), stampOf(current)),
            }
            this.set((st) => ({
              expenses: st.expenses.map((e) => (idOf(e) === id ? restored : e)),
            }))
          },
        },
      ].slice(-5),
    }))
  }

  deleteExpense(id: string): void {
    const prev = this.s.expenses.find((e) => idOf(e) === id)
    if (!prev) return
    this.set((s) => ({
      expenses: s.expenses.filter((e) => idOf(e) !== id),
      deletedIds: [...new Set([...s.deletedIds, id])],
      undoStack: [
        ...s.undoStack,
        {
          id: `del-${id}-${this.now()}`,
          label: `Deleted "${prev.itemName}"`,
          expiresAt: this.now() + 5000,
          undo: () => {
            const revived: Expense = {
              ...prev,
              id: this.generateId(),
              updatedAt: nextStampIso(this.now(), stampOf(prev)),
            }
            this.set((st) => ({ expenses: [revived, ...st.expenses] }))
          },
        },
      ].slice(-5),
    }))
  }

  clearAllExpenses(): void {
    const ids = this.s.expenses.flatMap((e) => idOf(e) ?? [])
    this.set((s) => ({
      expenses: [],
      deletedIds: [...new Set([...s.deletedIds, ...ids])],
      undoStack: [],
    }))
  }

  addCategory(name: string): void {
    const t = name.trim()
    if (!t || this.s.categories.includes(t)) return
    this.set((s) => ({ categories: [...s.categories, t] }))
  }

  renameCategory(from: string, to: string): void {
    const target = to.trim()
    if (!target || from === target) return
    const now = this.now()
    this.set((s) => {
      const targetExists = s.categories.includes(target)
      const moved = ownValue(s.budgets, from)
      const kept = ownValue(s.budgets, target)
      const budget: Partial<V085State> =
        moved === undefined
          ? {}
          : {
              budgets: { ...without(s.budgets, from), [target]: kept ?? moved },
              budgetUpdatedAt:
                kept === undefined
                  ? {
                      ...without(s.budgetUpdatedAt, from),
                      [target]: nextKeyStamp(now, target, s.budgetUpdatedAt, s.budgetDeletedAt),
                    }
                  : without(s.budgetUpdatedAt, from),
              budgetDeletedAt: {
                ...without(s.budgetDeletedAt, target),
                [from]: nextKeyStamp(now, from, s.budgetUpdatedAt, s.budgetDeletedAt),
              },
            }
      return {
        categories: targetExists
          ? s.categories.filter((c) => c !== from)
          : s.categories.map((c) => (c === from ? target : c)),
        expenses: refile(s.expenses, from, target, now),
        ...remap(s.categoryMappings, s.mappingUpdatedAt, from, target, now),
        ...budget,
      }
    })
  }

  removeCategory(name: string): void {
    const now = this.now()
    this.set((s) => ({
      categories: s.categories.filter((c) => c !== name),
      expenses: refile(s.expenses, name, 'Other', now),
      ...remap(s.categoryMappings, s.mappingUpdatedAt, name, 'Other', now),
      budgets: without(s.budgets, name),
      budgetUpdatedAt: without(s.budgetUpdatedAt, name),
      budgetDeletedAt:
        ownValue(s.budgets, name) === undefined
          ? s.budgetDeletedAt
          : {
              ...s.budgetDeletedAt,
              [name]: nextKeyStamp(now, name, s.budgetUpdatedAt, s.budgetDeletedAt),
            },
    }))
  }

  setBudget(category: string, amount: number): void {
    if (!category || !Number.isFinite(amount) || amount <= 0) return
    if (ownValue(this.s.budgets, category) === amount) return
    const now = this.now()
    this.set((s) => ({
      budgets: { ...s.budgets, [category]: amount },
      budgetUpdatedAt: {
        ...s.budgetUpdatedAt,
        [category]: nextKeyStamp(now, category, s.budgetUpdatedAt, s.budgetDeletedAt),
      },
      budgetDeletedAt: without(s.budgetDeletedAt, category),
    }))
  }

  removeBudget(category: string): void {
    const now = this.now()
    this.set((s) => ({
      budgets: without(s.budgets, category),
      budgetUpdatedAt: without(s.budgetUpdatedAt, category),
      budgetDeletedAt: {
        ...s.budgetDeletedAt,
        [category]: nextKeyStamp(now, category, s.budgetUpdatedAt, s.budgetDeletedAt),
      },
    }))
  }

  importBackup(data: BackupData): void {
    this.set({
      expenses: data.expenses,
      categories: data.categories.length ? data.categories : DEFAULT_CATEGORIES,
      categoryMappings: data.categoryMappings,
      mappingUpdatedAt: Object.fromEntries(
        Object.entries(data.mappingUpdatedAt ?? {}).filter(([key]) =>
          Object.hasOwn(data.categoryMappings, key),
        ),
      ),
      budgets: data.budgets ?? {},
      budgetUpdatedAt: completeBudgetUpdatedAt(
        data.budgets ?? {},
        data.budgetUpdatedAt,
        data.exportDate,
      ),
      budgetDeletedAt: data.budgetDeletedAt ?? {},
      deletedIds: data.deletedIds ?? [],
    })
  }

  exportBackup(): BackupData {
    const s = this.s
    return {
      expenses: s.expenses,
      categories: s.categories,
      categoryMappings: s.categoryMappings,
      mappingUpdatedAt: s.mappingUpdatedAt,
      budgets: s.budgets,
      budgetUpdatedAt: s.budgetUpdatedAt,
      budgetDeletedAt: s.budgetDeletedAt,
      deletedIds: s.deletedIds,
      exportDate: this.iso(this.now()),
      version: '4.0',
    }
  }

  consumeUndo(id: string): void {
    const now = this.now()
    const entry = this.s.undoStack.find((u) => u.id === id)
    if (!entry || entry.expiresAt < now) {
      this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
      return
    }
    entry.undo()
    this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
  }

  clearUndo(id: string): void {
    this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.id !== id) }))
  }

  /** applySync.ts: applies `data` sharing every unchanged object; written at once. */
  private applySync(data: BackupData): boolean {
    const s = this.s
    const budgets = data.budgets ?? {}
    const next = {
      expenses: shareRows(s.expenses, data.expenses) ?? s.expenses,
      categories: keepIfSameSet(
        s.categories,
        data.categories.length ? data.categories : DEFAULT_CATEGORIES,
      ),
      categoryMappings: keepIfEqual(s.categoryMappings, data.categoryMappings),
      mappingUpdatedAt: keepIfEqual(s.mappingUpdatedAt, data.mappingUpdatedAt ?? {}),
      budgets: keepIfEqual(s.budgets, budgets),
      budgetUpdatedAt: keepIfEqual(
        s.budgetUpdatedAt,
        completeBudgetUpdatedAt(budgets, data.budgetUpdatedAt, LEGACY_STAMP_ISO),
      ),
      budgetDeletedAt: keepIfEqual(s.budgetDeletedAt, data.budgetDeletedAt ?? {}),
      deletedIds: keepIfSameSet(s.deletedIds, data.deletedIds ?? []),
    }
    const changed =
      next.expenses !== s.expenses ||
      next.categories !== s.categories ||
      next.categoryMappings !== s.categoryMappings ||
      next.mappingUpdatedAt !== s.mappingUpdatedAt ||
      next.budgets !== s.budgets ||
      next.budgetUpdatedAt !== s.budgetUpdatedAt ||
      next.budgetDeletedAt !== s.budgetDeletedAt ||
      next.deletedIds !== s.deletedIds
    if (!changed) return false
    this.set(next)
    this.flushPendingSave()
    return true
  }

  // ── syncService transport (FROZEN-DEVIATION: the relay port replaces the SDK) ─────────────

  private async pushSync(syncId: string, payload: SyncPayload): Promise<{ updatedAt: string }> {
    const serialized = JSON.stringify(payload)
    if (serialized.length > PAYLOAD_WARN_BYTES) {
      if (serialized.length > PAYLOAD_MAX_CHARS) throw new PayloadTooLargeError(serialized.length)
    }
    const updatedAt = this.iso(this.now())
    try {
      await this.relay.push(syncId, payload)
    } catch (err) {
      throw new SyncTransportError('network', errorText(err))
    }
    return { updatedAt }
  }

  private async pullSync(syncId: string): Promise<unknown> {
    let row: unknown
    try {
      row = await this.relay.pull(syncId)
    } catch (err) {
      throw new SyncTransportError('network', errorText(err))
    }
    return isRecord(row) ? row.payload : null
  }

  // ── syncEngine ──────────────────────────────────────────────────────────────────────────

  private isOffline(): boolean {
    return !this.online
  }

  private configured(): boolean {
    return this.syncId !== null
  }

  private clearPushTimer(): void {
    if (this.pushTimer !== null) this.clock.clearTimeout(this.pushTimer)
    this.pushTimer = null
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearTimers(): void {
    this.clearPushTimer()
    this.clearRetry()
    if (this.remoteTimer !== null) this.clock.clearTimeout(this.remoteTimer)
    this.remoteTimer = null
  }

  private stopRealtime(): void {
    const unsubscribe = this.realtimeUnsub
    this.realtimeUnsub = null
    unsubscribe?.()
  }

  // FROZEN-DEVIATION: crypto.getRandomValues is the injected rng.
  private newRev(): string {
    const bytes = Array.from({ length: 16 }, () => Math.floor(this.rng() * 256))
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  private writerStamp(): WriterStamp {
    return {
      app: WRITER_VERSION,
      dev: this.storage.getDeviceId(),
      rev: this.newRev(),
      at: this.iso(this.now()),
    }
  }

  private succeed(
    snapRev: number,
    pushed: boolean,
    changedLocal: boolean,
    heldBack: boolean,
  ): SyncResult085 {
    const behind = this.localRev !== snapRev
    if (behind) this.again = true
    this.retryAttempt = 0
    this.streakSince = null
    this.cloudStatus = 'synced'
    this.lastSyncAt = this.now()
    this.lastError = null
    this.pendingLocal = behind || heldBack
    this.waitingForOld = heldBack
    return { ok: true, pushed, changedLocal }
  }

  private keptOffline(prev: SyncFailure): boolean {
    const failing =
      (prev.kind === 'network' ||
        prev.kind === 'server' ||
        prev.kind === 'invalid' ||
        prev.kind === 'permission') &&
      this.now() - prev.since >= FAILING_AFTER_MS
    return isPausedKind(prev.kind) || prev.kind === 'permission' || failing
  }

  private goOffline(): SyncResult085 {
    this.clearRetry()
    const prev = this.lastError
    if (prev !== null && this.keptOffline(prev)) {
      return { ok: false, error: prev.kind }
    }
    this.cloudStatus = 'offline'
    this.lastError = {
      kind: 'offline',
      since: prev?.kind === 'offline' ? prev.since : this.now(),
    }
    return { ok: false, error: 'offline' }
  }

  private pause(reason: SyncPauseReason): SyncResult085 {
    this.clearRetry()
    this.streakSince = null
    const prev = this.lastError
    this.cloudStatus = 'paused'
    this.lastError = { kind: reason, since: prev?.kind === reason ? prev.since : this.now() }
    return { ok: false, error: reason }
  }

  private fail(err: unknown): SyncResult085 {
    if (err instanceof PayloadTooLargeError) return this.pause('too-large')
    const kind: SyncErrorKind = err instanceof SyncTransportError ? err.kind : 'invalid'
    if (kind === 'network' && this.isOffline()) return this.goOffline()
    this.streakSince ??= this.now()
    const since = this.streakSince
    this.cloudStatus = 'error'
    this.lastError = { kind, since }
    this.scheduleRetry()
    return { ok: false, error: kind }
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (this.isOffline()) return
    this.retryAttempt = Math.min(this.retryAttempt + 1, 16)
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.retryAttempt - 1))
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      void this.requestCycle()
    }, delay)
  }

  /** The synchronous section: read, merge into the CURRENT state, apply, decide. No await. */
  private mergeStep(code: string, raw: unknown): Step {
    const rem = readRemote(raw)
    if (rem.kind === 'moved' || rem.kind === 'update-required') {
      return { kind: 'done', result: this.pause(rem.kind) }
    }
    if (rem.kind === 'invalid') throw new InvalidRemoteError(rem.reason)

    const snapRev = this.localRev
    this.clearPushTimer()
    const local = this.exportBackup()
    const readable = local.expenses.filter(isSyncableExpense)
    const unreadable = local.expenses.filter((row) => !isSyncableExpense(row))
    const mine: BackupData = { ...local, expenses: readable }
    const legacy = rem.kind === 'ok' && rem.writer === 'legacy'
    const remote = rem.kind === 'ok' ? rem.data : EMPTY
    const plain = mergeBackups(mine, remote, this.clock)
    const merged = legacy ? keepLocalRefiles(plain, readable, remote.expenses) : plain

    const known = new Set([...merged.expenses.map((e) => e.id), ...(merged.deletedIds ?? [])])
    const keep = unreadable.filter((row) => {
      const id = idOf(row)
      return id === undefined || !known.has(id)
    })
    const dead = new Set(merged.deletedIds ?? [])
    const passthrough =
      rem.kind === 'ok'
        ? rem.passthrough.filter((row) => {
            const id = idOf(row)
            return id === undefined || !dead.has(id)
          })
        : []

    this.applying = true
    let changedLocal: boolean
    try {
      changedLocal = this.applySync(
        keep.length ? { ...merged, expenses: [...merged.expenses, ...keep] } : merged,
      )
    } finally {
      this.applying = false
    }

    const outgoing = { ...merged, expenses: [...passthrough, ...merged.expenses], version: '4.0' }
    const keyOpts = { mappingStamps: !legacy }
    const outKey = contentKey(outgoing, keyOpts)
    const relayKey = rem.kind === 'ok' ? contentKey(raw, keyOpts) : null

    const pushedBefore = this.pushedThisSession.has(code)
    if (legacy && pushedBefore) this.legacyWriterAt = this.now()
    const memoKey = legacy && relayKey !== null ? fnv1a(`${relayKey}\n${outKey}`) : null

    const equal = outKey === relayKey
    if (equal && !(legacy && !pushedBefore)) {
      return { kind: 'done', result: this.succeed(snapRev, false, changedLocal, false) }
    }
    if (
      !equal &&
      memoKey !== null &&
      (this.oldWriterMemo.get(memoKey) ?? Number.NEGATIVE_INFINITY) >
        this.now() - OLD_WRITER_MEMO_MS
    ) {
      return { kind: 'done', result: this.succeed(snapRev, false, changedLocal, true) }
    }

    const payload: SyncPayload = { ...outgoing, wr: this.writerStamp() }
    const sent: SentPush = {
      rev: payload.wr.rev,
      hash: fnv1a(outKey),
      mappingStamps: keyOpts.mappingStamps,
      answered: false,
    }
    remember(this.sentPushes, sent)
    return { kind: 'push', payload, sent, snapRev, changedLocal, memoKey }
  }

  private async runCycle(): Promise<SyncResult085> {
    const code = this.syncId
    if (code === null) return offResult()
    const gen = this.setupGen
    if (this.isOffline()) return this.goOffline()
    this.cloudStatus = 'syncing'

    let raw: unknown
    try {
      raw = await this.pullSync(code)
    } catch (err) {
      return gen === this.setupGen ? this.fail(err) : offResult()
    }
    if (gen !== this.setupGen) return offResult()

    let step: Step
    try {
      step = this.mergeStep(code, raw)
    } catch (err) {
      return this.fail(err)
    }
    if (step.kind === 'done') return step.result

    let updatedAt: string
    try {
      updatedAt = (await this.pushSync(code, step.payload)).updatedAt
    } catch (err) {
      return gen === this.setupGen ? this.fail(err) : offResult()
    }
    step.sent.answered = true
    if (gen !== this.setupGen) return offResult()
    remember(this.sentUpdatedAt, Date.parse(updatedAt))
    this.pushedThisSession.add(code)
    if (step.memoKey !== null) this.oldWriterMemo.set(step.memoKey, this.now())
    this.pushes++
    this.lastRev = step.sent.rev
    return this.succeed(step.snapRev, true, step.changedLocal, false)
  }

  private moreRequested(): boolean {
    return this.again || this.queued.length > 0
  }

  private async runLoop(): Promise<void> {
    this.running = true
    try {
      do {
        this.current = this.queued
        this.queued = []
        this.again = false
        this.clearRetry()
        const gen = this.setupGen
        let result: SyncResult085
        try {
          result = await this.runCycle()
        } catch (err) {
          result = this.fail(err)
        }
        for (const resolve of this.current) resolve(result)
        this.current = []
        if (
          !result.ok &&
          gen === this.setupGen &&
          (this.retryTimer !== null || result.error === 'off')
        ) {
          for (const resolve of this.queued) resolve(result)
          this.queued = []
          this.again = false
        }
      } while (this.moreRequested())
    } finally {
      this.running = false
    }
  }

  private requestCycle(): Promise<SyncResult085> {
    if (!this.configured()) return Promise.resolve(offResult())
    return new Promise((resolve) => {
      this.queued.push(resolve)
      if (this.running) this.again = true
      else void this.runLoop()
    })
  }

  /** Our own push coming back: our rev, exactly our content, from a push that cannot have landed over a newer one. */
  private isOwnEcho(payload: Record<string, unknown>): boolean {
    const wr = payload.wr
    if (!isRecord(wr)) return false
    const rev = wr.rev
    const sent = this.sentPushes.find((push) => push.rev === rev)
    return (
      sent !== undefined &&
      (sent.answered || sent === this.sentPushes.at(-1)) &&
      fnv1a(contentKey(payload, { mappingStamps: sent.mappingStamps })) === sent.hash
    )
  }

  onRemoteChange(change: RelayChange): void {
    const { payload } = change
    if (isRecord(payload)) {
      if (this.isOwnEcho(payload)) return
    } else if (
      payload === undefined &&
      change.updatedAt !== null &&
      this.sentUpdatedAt.includes(Date.parse(change.updatedAt))
    ) {
      return
    }
    if (this.remoteTimer !== null) return
    const wait = Math.max(
      REMOTE_COALESCE_MS,
      this.lastRemoteCycleAt + REMOTE_MIN_GAP_MS - this.now(),
    )
    this.remoteTimer = this.clock.setTimeout(() => {
      this.remoteTimer = null
      this.lastRemoteCycleAt = this.now()
      void this.requestCycle()
    }, wait)
  }

  private ensureSubscribed(gen: number): void {
    const code = this.syncId
    if (code === null || gen !== this.setupGen || this.realtimeUnsub !== null) return
    if (this.subscribingGen === gen) return
    this.subscribingGen = gen
    try {
      const unsubscribe = this.relay.subscribe(code, (change) => {
        if (gen === this.setupGen) this.onRemoteChange(change)
      })
      if (gen === this.setupGen) {
        this.stopRealtime()
        this.realtimeUnsub = unsubscribe
        // SUBSCRIBED: events are not replayed after a drop, so every (re)subscribe catches up.
        void this.requestCycle()
      } else {
        unsubscribe()
      }
    } finally {
      if (this.subscribingGen === gen) this.subscribingGen = null
    }
  }

  /** Connects to `syncId`: saves it, runs the first cycle, then subscribes to realtime. */
  async setupSync(syncId: string): Promise<SyncResult085> {
    this.start()
    const sameCode = this.syncId === syncId
    try {
      this.storage.saveSyncId(syncId)
    } catch {
      // keepCode: the code still works for this session.
    }
    const gen = ++this.setupGen
    this.stopRealtime()
    this.clearTimers()
    this.retryAttempt = 0
    this.streakSince = null
    this.syncId = syncId
    this.cloudStatus = 'idle'
    this.lastError = null
    this.pendingLocal = true
    this.waitingForOld = false
    this.legacyWriterAt = sameCode ? this.legacyWriterAt : null
    const result = await this.requestCycle()
    if (gen === this.setupGen && !this.isOffline()) this.ensureSubscribed(gen)
    return result
  }

  /** useSyncStore.initSync at start-up: set up the saved code, if any. */
  initSync(): Promise<SyncResult085> | null {
    let saved: string | null
    try {
      saved = this.storage.getSyncId()
    } catch {
      saved = null
    }
    if (!saved) return null
    if (this.syncId === null) {
      this.syncId = saved
      this.cloudStatus = 'idle'
      this.pendingLocal = true
    }
    return this.setupSync(saved)
  }

  /** useSyncStore.disconnectSync. */
  disconnectSync(): void {
    this.stop()
    try {
      this.storage.saveSyncId(null)
    } catch {
      // Storage unavailable: the code is forgotten for this session anyway.
    }
    this.syncId = null
    this.cloudStatus = 'off'
    this.lastSyncAt = null
    this.lastError = null
    this.pendingLocal = false
    this.waitingForOld = false
    this.legacyWriterAt = null
  }

  private stop(): void {
    this.setupGen++
    this.stopRealtime()
    this.clearTimers()
    this.retryAttempt = 0
  }

  /** useSyncStore.triggerSync: with no engine loaded yet it sets up again. */
  triggerSync(opts?: { resetBackoff?: boolean }): Promise<SyncResult085> {
    const syncId = this.syncId
    if (syncId === null) return Promise.resolve(offResult())
    if (!this.started) return this.setupSync(syncId)
    if (opts?.resetBackoff) this.retryAttempt = 0
    return this.requestCycle()
  }

  scheduleSyncPush(): void {
    if (!this.configured()) return
    this.clearPushTimer()
    this.pushTimer = this.clock.setTimeout(() => {
      this.pushTimer = null
      void this.requestCycle()
    }, PUSH_DEBOUNCE_MS)
  }

  private onLocalChange(): void {
    if (this.applying || !this.s.hydrated) return
    this.localRev++
    if (!this.configured()) return
    if (!this.pendingLocal || this.waitingForOld) {
      this.pendingLocal = true
      this.waitingForOld = false
    }
    this.scheduleSyncPush()
  }

  /** The engine's start(): wires local changes (and, below, the lifecycle handlers). Once. */
  private start(): void {
    this.started = true
  }

  /** document visibilitychange: persistence flushes first (bootstrap), then the engine. */
  setVisible(visible: boolean): void {
    if (!visible) {
      this.flushPendingSave()
      if (!this.started) return
      if (this.configured() && (this.pushTimer !== null || this.pendingLocal)) {
        this.clearPushTimer()
        void this.requestCycle()
      }
      return
    }
    if (!this.started || !this.configured()) return
    if (this.now() - (this.lastSyncAt ?? 0) > RESUME_AFTER_MS) {
      this.retryAttempt = 0
      this.ensureSubscribed(this.setupGen)
      void this.requestCycle()
    }
  }

  /** window online / offline. */
  setOnline(online: boolean): void {
    this.online = online
    if (!this.started || !this.configured()) return
    if (online) {
      this.retryAttempt = 0
      this.ensureSubscribed(this.setupGen)
      void this.requestCycle()
    } else {
      this.goOffline()
    }
  }

  /** The tab closes (FROZEN-DEVIATION: its timers and subscription die with it). */
  close(): void {
    this.stop()
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
    this.saveTimer = null
  }
}
