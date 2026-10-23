// FROZEN: never edit. Model of the v0.8.5 client (PR-0 "Stop the bleeding").
//
// Provenance (P-26): PR-0 has not merged when PR-1 is written, so this is a model of the PR-0
// CONTRACT (DATA-ENGINE-SPEC §17.2 PR-0 items 1–7, 10, 11, 13), built on the verbatim v0.8.4 parts
// that PR-0 keeps (types, constants, parseBackup, storage). Reconcile it with PR-0's merged code
// before PR-2. Same permitted deviations as v084.ts (injected clock/timers, rng, storage, relay).
//
//  1  triggerSync: single-flight + `again`, FRESH exportBackup() after the pull await, push only if
//     the merged doc differs canonically from the remote (ignoring exportDate, version, wr, x5, key
//     order, and the order of expenses, categories and deletedIds).
//  2  mergeBackups ties are deterministic (larger canonical JSON / larger value); tombstone cap 20,000.
//  3  every push carries `wr`; echo filter on new.payload.wr.rev; 300 ms coalescing; a 10-minute
//     memo against an old (no wr, no x5) writer.
//  4  applySync: no keyword migration, structural sharing, persistence flushed right away.
//  5  no migration in hydrate / import either.
//  6  pending field edits are rebased onto a newer remote copy.
//  7  forward stamps on edits and on undo; undo of a delete re-adds under a new id.
// 10  lenient pull validation (bad rows are dropped from the merge input, never deleted).
// 11  fence awareness: `expenses: 'moved'` or `x5.min > 4` → never push.
// 13  spendtrack:app = '0.8.5' on every save; spendtrack:dev = 6 base36 chars.
import Fuse from 'fuse.js'
import { isValid, parseISO } from 'date-fns'
import { newRev } from '../../core/ids'
import {
  DEFAULT_CATEGORIES,
  FUSE_SCORE_CUTOFF,
  FUSE_THRESHOLD,
  isRecord,
  makeGenerateId,
  makeStorage,
  type BackupData,
  type CategoryBudgetTimestamps,
  type CategoryBudgets,
  type CategoryMappings,
  type ClockPort,
  type Expense,
  type RelayPort,
  type StoragePort,
  type V084Storage,
} from './v084'

export const TOMBSTONE_CAP_085 = 20_000
const PUSH_DEBOUNCE_MS = 3000
const MAX_RETRY_DELAY_MS = 60 * 1000
const PERSIST_DEBOUNCE_MS = 400
const COALESCE_MS = 300
const MEMO_MS = 10 * 60 * 1000
const APP = '0.8.5'

function ts(value: string | undefined): number {
  return value ? new Date(value).getTime() : 0
}

/** Canonical JSON: keys sorted, undefined dropped. */
export function canon085(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x: unknown) => canon085(x)).join(',')}]`
  const keys = Object.keys(v).sort()
  const parts: string[] = []
  for (const k of keys) {
    const x: unknown = Object.getOwnPropertyDescriptor(v, k)?.value
    if (x !== undefined) parts.push(`${JSON.stringify(k)}:${canon085(x)}`)
  }
  return `{${parts.join(',')}}`
}

/** Item 2: v0.8.4 mergeBackups with deterministic ties and a 20,000 tombstone cap. */
export function mergeBackups085(
  local: BackupData,
  remote: BackupData,
  clock: ClockPort,
): BackupData {
  const localMap = new Map<string, Expense>(local.expenses.map((e) => [e.id, e]))
  const remoteMap = new Map<string, Expense>(remote.expenses.map((e) => [e.id, e]))
  const tombstones = new Set<string>([...(local.deletedIds ?? []), ...(remote.deletedIds ?? [])])
  const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()])
  const merged: Expense[] = []
  for (const id of allIds) {
    if (tombstones.has(id)) continue
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (!l) {
      if (r) merged.push(r)
      continue
    }
    if (!r) {
      merged.push(l)
      continue
    }
    const lTime = ts(l.updatedAt ?? l.createdAt)
    const rTime = ts(r.updatedAt ?? r.createdAt)
    if (lTime > rTime) merged.push(l)
    else if (rTime > lTime) merged.push(r)
    else merged.push(canon085(l) >= canon085(r) ? l : r)
  }
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const categories = [...new Set([...local.categories, ...remote.categories])]
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES)
  const categoryMappings: CategoryMappings = {
    ...remote.categoryMappings,
    ...local.categoryMappings,
  }
  for (const [k, v] of Object.entries(remote.categoryMappings)) {
    const mine = local.categoryMappings[k]
    if (mine !== undefined && v > mine) categoryMappings[k] = v
  }
  const allBudgetKeys = new Set<string>([
    ...Object.keys(local.budgets ?? {}),
    ...Object.keys(remote.budgets ?? {}),
    ...Object.keys(local.budgetUpdatedAt ?? {}),
    ...Object.keys(remote.budgetUpdatedAt ?? {}),
    ...Object.keys(local.budgetDeletedAt ?? {}),
    ...Object.keys(remote.budgetDeletedAt ?? {}),
  ])
  const mergedBudgets: CategoryBudgets = {}
  const mergedBudgetUpdatedAt: CategoryBudgetTimestamps = {}
  const mergedBudgetDeletedAt: CategoryBudgetTimestamps = {}
  for (const key of allBudgetKeys) {
    const localSetTs = ts(
      local.budgetUpdatedAt?.[key] ??
        (local.budgets?.[key] !== undefined ? local.exportDate : undefined),
    )
    const remoteSetTs = ts(
      remote.budgetUpdatedAt?.[key] ??
        (remote.budgets?.[key] !== undefined ? remote.exportDate : undefined),
    )
    const localDelTs = ts(local.budgetDeletedAt?.[key])
    const remoteDelTs = ts(remote.budgetDeletedAt?.[key])
    const winningDelTs = Math.max(localDelTs, remoteDelTs)
    const winningSetTs = Math.max(localSetTs, remoteSetTs)
    if (winningDelTs > 0 && winningDelTs >= winningSetTs) {
      const delSrc = localDelTs >= remoteDelTs ? local : remote
      const deletedAt = delSrc.budgetDeletedAt?.[key]
      if (deletedAt) mergedBudgetDeletedAt[key] = deletedAt
      continue
    }
    if (winningSetTs > 0) {
      const setSrc = localSetTs >= remoteSetTs ? local : remote
      const val = setSrc.budgets?.[key]
      if (val !== undefined) mergedBudgets[key] = val
      const setTs = setSrc.budgetUpdatedAt?.[key] ?? setSrc.exportDate
      if (setTs) mergedBudgetUpdatedAt[key] = setTs
      continue
    }
    const lv = local.budgets?.[key]
    const rv = remote.budgets?.[key]
    const v = lv === undefined ? rv : rv === undefined ? lv : Math.max(lv, rv)
    if (v !== undefined) mergedBudgets[key] = v
  }
  return {
    expenses: merged,
    categories,
    categoryMappings,
    budgets: mergedBudgets,
    budgetUpdatedAt: mergedBudgetUpdatedAt,
    budgetDeletedAt: mergedBudgetDeletedAt,
    deletedIds: [...tombstones].slice(-TOMBSTONE_CAP_085),
    exportDate: new Date(clock.now()).toISOString(),
    version: '4.0',
  }
}

/** Item 1: the comparison that decides whether a push teaches the relay anything. */
export function sameContent(a: BackupData, b: BackupData): boolean {
  const view = (d: BackupData): string =>
    canon085([
      [...d.expenses].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
      [...d.categories].sort(),
      d.categoryMappings,
      d.budgets ?? {},
      d.budgetUpdatedAt ?? {},
      d.budgetDeletedAt ?? {},
      [...(d.deletedIds ?? [])].sort(),
    ])
  return view(a) === view(b)
}

const isRow = (x: unknown): x is Expense =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  typeof x.itemName === 'string' &&
  typeof x.amount === 'number' &&
  Number.isFinite(x.amount) &&
  typeof x.date === 'string' &&
  isValid(parseISO(x.date))

const strRecord = (x: unknown): Record<string, string> =>
  isRecord(x)
    ? Object.fromEntries(
        Object.entries(x).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {}
const numRecord = (x: unknown): Record<string, number> =>
  isRecord(x)
    ? Object.fromEntries(
        Object.entries(x).filter((e): e is [string, number] => typeof e[1] === 'number'),
      )
    : {}

export type Pulled085 =
  | { readonly kind: 'ok'; readonly data: BackupData; readonly oldWriter: boolean }
  | { readonly kind: 'moved' }
  | { readonly kind: 'error' }

/** Items 10 + 11: lenient validation and fence awareness. */
export function validatePull(raw: unknown): Pulled085 {
  if (!isRecord(raw)) return { kind: 'error' }
  const x5 = raw.x5
  const min = isRecord(x5) ? x5.min : undefined
  if (raw.expenses === 'moved' || (typeof min === 'number' && min > 4)) return { kind: 'moved' }
  if (!Array.isArray(raw.expenses)) return { kind: 'error' }
  const data: BackupData = {
    expenses: raw.expenses.filter(isRow),
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((c): c is string => typeof c === 'string')
      : [],
    categoryMappings: strRecord(raw.categoryMappings),
    budgets: numRecord(raw.budgets),
    budgetUpdatedAt: strRecord(raw.budgetUpdatedAt),
    budgetDeletedAt: strRecord(raw.budgetDeletedAt),
    deletedIds: Array.isArray(raw.deletedIds)
      ? raw.deletedIds.filter((d): d is string => typeof d === 'string')
      : [],
    exportDate: typeof raw.exportDate === 'string' ? raw.exportDate : '',
    version: typeof raw.version === 'string' ? raw.version : '4.0',
  }
  return { kind: 'ok', data, oldWriter: raw.wr === undefined && raw.x5 === undefined }
}

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
  budgets: CategoryBudgets
  budgetUpdatedAt: CategoryBudgetTimestamps
  budgetDeletedAt: CategoryBudgetTimestamps
  deletedIds: string[]
  hydrated: boolean
  undoStack: UndoEntry085[]
}

type Field = keyof Pick<Expense, 'itemName' | 'amount' | 'category' | 'date' | 'notes'>

function completeBudgetUpdatedAt(
  budgets: CategoryBudgets,
  existing: CategoryBudgetTimestamps | undefined,
  fallback: string,
): CategoryBudgetTimestamps {
  return Object.fromEntries(Object.keys(budgets).map((c) => [c, existing?.[c] ?? fallback]))
}

export class V085Client {
  s: V085State = {
    expenses: [],
    categories: DEFAULT_CATEGORIES,
    categoryMappings: {},
    budgets: {},
    budgetUpdatedAt: {},
    budgetDeletedAt: {},
    deletedIds: [],
    hydrated: false,
    undoStack: [],
  }
  readonly storage: V084Storage
  readonly generateId: () => string
  readonly dev: string
  syncId: string | null = null
  syncApplying = false
  moved = false
  pushes = 0
  lastRev: string | null = null
  /** Item 6: field edits since the last successful push. */
  readonly pending = new Map<string, Set<Field>>()
  /** Item 3: hash of an old-writer relay payload → when we pushed over it. */
  readonly memo = new Map<string, number>()
  private running = false
  private again = false
  private waiters: (() => void)[] = []
  private pushTimer: number | null = null
  private retryTimer: number | null = null
  private coalesceTimer: number | null = null
  private retryAttempt = 0
  private saveTimer: number | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    readonly clock: ClockPort,
    readonly rng: () => number,
    readonly local: StoragePort,
    readonly relay: RelayPort,
  ) {
    this.storage = makeStorage(local)
    this.generateId = makeGenerateId(clock, rng)
    const stored = local.getItem('spendtrack:dev')
    this.dev =
      stored ??
      Math.floor(rng() * 36 ** 6)
        .toString(36)
        .padStart(6, '0')
    if (stored === null) local.setItem('spendtrack:dev', this.dev)
  }

  private iso(t: number): string {
    return new Date(t).toISOString()
  }

  private set(update: Partial<V085State> | ((s: V085State) => Partial<V085State>)): void {
    const prev = this.s
    const next = { ...prev, ...(typeof update === 'function' ? update(prev) : update) }
    this.s = next
    const persisted =
      prev.expenses !== next.expenses ||
      prev.categories !== next.categories ||
      prev.categoryMappings !== next.categoryMappings ||
      prev.budgets !== next.budgets ||
      prev.budgetUpdatedAt !== next.budgetUpdatedAt ||
      prev.budgetDeletedAt !== next.budgetDeletedAt ||
      prev.deletedIds !== next.deletedIds
    if (persisted && next.hydrated) {
      if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
      this.saveTimer = this.clock.setTimeout(() => {
        this.saveTimer = null
        this.persistCurrentState()
      }, PERSIST_DEBOUNCE_MS)
    }
    const synced =
      prev.expenses !== next.expenses ||
      prev.categories !== next.categories ||
      prev.categoryMappings !== next.categoryMappings ||
      prev.budgets !== next.budgets ||
      prev.deletedIds !== next.deletedIds
    if (synced && next.hydrated && !this.syncApplying) this.scheduleSyncPush()
  }

  persistCurrentState(): void {
    const s = this.s
    this.storage.saveAll(
      s.expenses,
      s.categories,
      s.categoryMappings,
      s.budgets,
      s.budgetUpdatedAt,
      s.budgetDeletedAt,
      s.deletedIds,
    )
    this.local.setItem('spendtrack:app', APP)
  }

  flushPendingSave(): void {
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.s.hydrated) this.persistCurrentState()
  }

  hydrate(): void {
    const budgets = this.storage.getBudgets()
    this.set({
      expenses: this.storage.getExpenses(),
      categories: this.storage.getCategories() ?? DEFAULT_CATEGORIES,
      categoryMappings: this.storage.getCategoryMappings(),
      budgets,
      budgetUpdatedAt: completeBudgetUpdatedAt(
        budgets,
        this.storage.getBudgetUpdatedAt(),
        '1970-01-01T00:00:00.000Z',
      ),
      budgetDeletedAt: this.storage.getBudgetDeletedAt(),
      deletedIds: this.storage.getDeletedIds(),
      hydrated: true,
    })
  }

  getSmartCategory(itemName: string): string | null {
    const mappings = this.s.categoryMappings
    if (!itemName) return null
    const normalized = itemName.toLowerCase().trim()
    if (mappings[normalized]) return mappings[normalized]
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

  private pushUndo(entry: UndoEntry085): UndoEntry085[] {
    return [...this.s.undoStack, entry].slice(-5)
  }

  addExpense(input: Partial<Expense> & { itemName: string; amount: number }): Expense {
    if (!Number.isFinite(input.amount) || input.amount <= 0)
      throw new Error('Amount must be a finite number greater than 0.')
    const itemName = input.itemName.trim()
    if (!itemName) throw new Error('Item name is required.')
    const category = input.category || this.getSmartCategory(itemName) || 'Other'
    const now = this.iso(this.clock.now())
    const expense: Expense = {
      id: this.generateId(),
      itemName,
      amount: input.amount,
      category,
      date: input.date || now,
      notes: input.notes,
      createdAt: now,
    }
    const normalized = itemName.toLowerCase().trim()
    this.set((s) => ({
      expenses: [expense, ...s.expenses],
      categoryMappings:
        category !== 'Other' && normalized
          ? { ...s.categoryMappings, [normalized]: category }
          : s.categoryMappings,
      undoStack: this.pushUndo({
        id: `add-${expense.id}`,
        label: `Added "${itemName}"`,
        expiresAt: this.clock.now() + 5000,
        undo: () => {
          this.set((st) => ({
            expenses: st.expenses.filter((e) => e.id !== expense.id),
            deletedIds: [...new Set([...st.deletedIds, expense.id])],
          }))
        },
      }),
    }))
    return expense
  }

  /** Item 7: a forward stamp strictly above the version being replaced. */
  private stampAfter(prev: Expense): string {
    return this.iso(Math.max(this.clock.now(), ts(prev.updatedAt ?? prev.createdAt) + 1))
  }

  private trackPending(id: string, fields: readonly Field[]): void {
    const set = this.pending.get(id) ?? new Set<Field>()
    for (const f of fields) set.add(f)
    this.pending.set(id, set)
  }

  updateExpense(id: string, patch: Partial<Pick<Expense, Field>>): void {
    const prev = this.s.expenses.find((e) => e.id === id)
    if (!prev) return
    const fields = Object.keys(patch).filter((k): k is Field => k in patch)
    this.trackPending(id, fields)
    const before = Object.fromEntries(fields.map((f) => [f, prev[f]]))
    this.set((s) => ({
      expenses: s.expenses.map((e) =>
        e.id === id ? { ...e, ...patch, updatedAt: this.stampAfter(e) } : e,
      ),
      undoStack: this.pushUndo({
        id: `update-${id}-${this.clock.now()}`,
        label: 'Updated expense',
        expiresAt: this.clock.now() + 5000,
        undo: () => {
          this.trackPending(id, fields)
          this.set((st) => ({
            expenses: st.expenses.map((e) =>
              e.id === id ? { ...e, ...before, updatedAt: this.stampAfter(e) } : e,
            ),
          }))
        },
      }),
    }))
  }

  deleteExpense(id: string): void {
    const prev = this.s.expenses.find((e) => e.id === id)
    if (!prev) return
    this.set((s) => ({
      expenses: s.expenses.filter((e) => e.id !== id),
      deletedIds: [...new Set([...s.deletedIds, id])],
      undoStack: this.pushUndo({
        id: `del-${id}-${this.clock.now()}`,
        label: `Deleted "${prev.itemName}"`,
        expiresAt: this.clock.now() + 5000,
        undo: () => {
          // Item 7: re-add under a new id; the old id stays tombstoned.
          const now = this.iso(this.clock.now())
          const again: Expense = { ...prev, id: this.generateId(), updatedAt: now }
          this.set((st) => ({ expenses: [again, ...st.expenses] }))
        },
      }),
    }))
  }

  clearAllExpenses(): void {
    const ids = this.s.expenses.map((e) => e.id)
    this.set((s) => ({
      expenses: [],
      deletedIds: [...new Set([...s.deletedIds, ...ids])],
      undoStack: [],
    }))
  }

  addCategory(name: string): void {
    const t = name.trim()
    if (!t) return
    this.set((s) => (s.categories.includes(t) ? s : { categories: [...s.categories, t] }))
  }

  /** Unchanged from v0.8.4 (still an unstamped re-file: §12.3 row 9). */
  renameCategory(from: string, to: string): void {
    const target = to.trim()
    if (!target || from === target) return
    const targetExists = this.s.categories.includes(target)
    const now = this.iso(this.clock.now())
    this.set((s) => ({
      categories: targetExists
        ? s.categories.filter((c) => c !== from)
        : s.categories.map((c) => (c === from ? target : c)),
      expenses: s.expenses.map((e) => (e.category === from ? { ...e, category: target } : e)),
      budgets:
        s.budgets[from] !== undefined
          ? {
              ...Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== from)),
              [target]: s.budgets[target] ?? s.budgets[from],
            }
          : s.budgets,
      budgetUpdatedAt:
        s.budgets[from] !== undefined
          ? {
              ...Object.fromEntries(Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== from)),
              [target]: s.budgetUpdatedAt[target] ?? s.budgetUpdatedAt[from] ?? now,
            }
          : s.budgetUpdatedAt,
      budgetDeletedAt:
        s.budgets[from] !== undefined
          ? Object.fromEntries(
              Object.entries(s.budgetDeletedAt).filter(([k]) => k !== from && k !== target),
            )
          : s.budgetDeletedAt,
    }))
  }

  removeCategory(name: string): void {
    const now = this.iso(this.clock.now())
    this.set((s) => ({
      categories: s.categories.filter((c) => c !== name),
      expenses: s.expenses.map((e) => (e.category === name ? { ...e, category: 'Other' } : e)),
      budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== name)),
      budgetUpdatedAt: Object.fromEntries(
        Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== name),
      ),
      budgetDeletedAt:
        s.budgets[name] !== undefined ? { ...s.budgetDeletedAt, [name]: now } : s.budgetDeletedAt,
    }))
  }

  setBudget(category: string, amount: number): void {
    if (!category || amount <= 0) return
    const now = this.iso(this.clock.now())
    this.set((s) => ({
      budgets: { ...s.budgets, [category]: amount },
      budgetUpdatedAt: { ...s.budgetUpdatedAt, [category]: now },
      budgetDeletedAt: Object.fromEntries(
        Object.entries(s.budgetDeletedAt).filter(([k]) => k !== category),
      ),
    }))
  }

  removeBudget(category: string): void {
    const now = this.iso(this.clock.now())
    this.set((s) => ({
      budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== category)),
      budgetUpdatedAt: Object.fromEntries(
        Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== category),
      ),
      budgetDeletedAt: { ...s.budgetDeletedAt, [category]: now },
    }))
  }

  /** Item 5: import without migration. */
  importBackup(data: BackupData): void {
    this.set({
      expenses: data.expenses,
      categories: data.categories.length ? data.categories : DEFAULT_CATEGORIES,
      categoryMappings: data.categoryMappings,
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
      budgets: s.budgets,
      budgetUpdatedAt: s.budgetUpdatedAt,
      budgetDeletedAt: s.budgetDeletedAt,
      deletedIds: s.deletedIds,
      exportDate: this.iso(this.clock.now()),
      version: '4.0',
    }
  }

  /** Item 4: no migration; arrays/objects kept when canonically equal; persistence flushed now. */
  applySync(data: BackupData): void {
    const keep = <T>(cur: T, next: T): T => (canon085(cur) === canon085(next) ? cur : next)
    const s = this.s
    this.set({
      expenses: keep(s.expenses, data.expenses),
      categories: keep(s.categories, data.categories.length ? data.categories : DEFAULT_CATEGORIES),
      categoryMappings: keep(s.categoryMappings, data.categoryMappings),
      budgets: keep(s.budgets, data.budgets ?? {}),
      budgetUpdatedAt: keep(
        s.budgetUpdatedAt,
        completeBudgetUpdatedAt(data.budgets ?? {}, data.budgetUpdatedAt, data.exportDate),
      ),
      budgetDeletedAt: keep(s.budgetDeletedAt, data.budgetDeletedAt ?? {}),
      deletedIds: keep(s.deletedIds, data.deletedIds ?? []),
    })
    this.flushPendingSave()
  }

  consumeUndo(id: string): void {
    const now = this.clock.now()
    const entry = this.s.undoStack.find((u) => u.id === id)
    if (entry && entry.expiresAt >= now) entry.undo()
    this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
  }

  // ── sync ────────────────────────────────────────────────────────────────────────────────

  setupSync(syncId: string): Promise<void> {
    this.storage.saveSyncId(syncId)
    this.syncId = syncId
    if (this.unsubscribe) this.unsubscribe()
    return this.triggerSync().then(() => {
      this.unsubscribe = this.relay.subscribe(syncId, () => this.onRemoteEvent(null))
    })
  }

  /** Item 3: echo filter on wr.rev, then 300 ms trailing coalescing. */
  onRemoteEvent(rev: string | null): void {
    if (rev !== null && rev === this.lastRev) return
    if (this.coalesceTimer !== null) this.clock.clearTimeout(this.coalesceTimer)
    this.coalesceTimer = this.clock.setTimeout(() => {
      this.coalesceTimer = null
      void this.triggerSync()
    }, COALESCE_MS)
  }

  /** Item 1: resolves after the NEXT completed cycle, never with a stale in-flight promise. */
  triggerSync(): Promise<void> {
    if (!this.syncId) return Promise.resolve()
    const done = new Promise<void>((resolve) => this.waiters.push(resolve))
    if (this.running) {
      this.again = true
      return done
    }
    this.running = true
    void (async () => {
      do {
        this.again = false
        await this.runCycle()
      } while (this.againRequested())
      this.running = false
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w()
    })()
    return done
  }

  /** Read through a call: a write during an await sets it, which control-flow analysis cannot see. */
  private againRequested(): boolean {
    return this.again
  }

  /**
   * Item 6: rebase pending local field edits onto a remote copy that brings something new in
   * another field. A remote copy that differs only in our own pending fields is our base: rebasing
   * onto it would only re-stamp the whole record at `now` and erase a concurrent edit of another
   * field made on a v5 device (found by the simulation, §12.3 row 4; reconcile with PR-0).
   */
  private rebase(merged: BackupData, remote: BackupData, local: BackupData): BackupData {
    if (this.pending.size === 0) return merged
    const remoteById = new Map(remote.expenses.map((e) => [e.id, e]))
    const localById = new Map(local.expenses.map((e) => [e.id, e]))
    const expenses = merged.expenses.map((m) => {
      const fields = this.pending.get(m.id)
      const r = remoteById.get(m.id)
      const l = localById.get(m.id)
      if (!fields || !r || !l) return m
      const picked = Object.fromEntries([...fields].map((f) => [f, l[f]]))
      const unstamped = (e: Expense): string => canon085({ ...e, updatedAt: undefined })
      if (unstamped({ ...r, ...picked }) === unstamped(l)) return m
      const at = Math.max(
        this.clock.now(),
        ts(l.updatedAt ?? l.createdAt) + 1,
        ts(r.updatedAt ?? r.createdAt) + 1,
      )
      return { ...r, ...picked, updatedAt: this.iso(at) }
    })
    return { ...merged, expenses }
  }

  private async runCycle(): Promise<void> {
    const syncId = this.syncId
    if (!syncId || this.moved) return
    try {
      const pulled = await this.relay.pull(syncId)
      // ── synchronous from here to the push ──
      const local = this.exportBackup()
      let merged = local
      let memoKey: string | null = null
      if (pulled !== null) {
        const v = validatePull(pulled.payload)
        if (v.kind === 'moved') {
          this.moved = true
          return
        }
        if (v.kind === 'error') throw new Error('invalid remote')
        merged = this.rebase(mergeBackups085(local, v.data, this.clock), v.data, local)
        this.syncApplying = true
        try {
          this.applySync(merged)
        } finally {
          this.syncApplying = false
        }
        if (sameContent(merged, v.data)) {
          this.retryAttempt = 0
          return
        }
        if (v.oldWriter) {
          memoKey = canon085(v.data)
          const at = this.memo.get(memoKey)
          if (at !== undefined && at > this.clock.now() - MEMO_MS) return
        }
      }
      const rev = newRev(this.rng)
      const payload = {
        ...merged,
        wr: { app: APP, dev: this.dev, rev, at: this.iso(this.clock.now()) },
      }
      const pendingAtPush = new Map([...this.pending].map(([id, f]) => [id, f.size]))
      await this.relay.push(syncId, payload)
      this.pushes++
      this.lastRev = rev
      if (memoKey !== null) this.memo.set(memoKey, this.clock.now())
      for (const [id, size] of pendingAtPush) {
        if (this.pending.get(id)?.size === size) this.pending.delete(id)
      }
      this.retryAttempt = 0
    } catch {
      this.syncApplying = false
      this.scheduleRetry()
    }
  }

  scheduleSyncPush(): void {
    if (!this.syncId) return
    if (this.pushTimer !== null) this.clock.clearTimeout(this.pushTimer)
    this.pushTimer = this.clock.setTimeout(() => {
      this.pushTimer = null
      void this.triggerSync()
    }, PUSH_DEBOUNCE_MS)
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryAttempt = Math.min(this.retryAttempt + 1, 8)
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1500 * Math.pow(2, this.retryAttempt))
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      void this.triggerSync()
    }, delay)
  }

  close(): void {
    for (const h of [this.pushTimer, this.retryTimer, this.saveTimer, this.coalesceTimer]) {
      if (h !== null) this.clock.clearTimeout(h)
    }
    this.pushTimer = null
    this.retryTimer = null
    this.saveTimer = null
    this.coalesceTimer = null
    if (this.unsubscribe) this.unsubscribe()
    this.unsubscribe = null
  }
}
