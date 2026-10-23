import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import Fuse from 'fuse.js'
import { isSameDay, parseISO } from 'date-fns'
import { storage } from '../services/storage'
import { DEFAULT_CATEGORIES, FUSE_THRESHOLD, FUSE_SCORE_CUTOFF } from '../constants'
import { generateId } from '../utils/helpers'
import { isRecord } from '../lib/backup'
import { canon, canonRow } from '../lib/canon'
import { LEGACY_STAMP_ISO, nextStampIso, stampMs } from '../lib/stamps'
import { DEMO_EXPENSES, DEMO_CATEGORIES, DEMO_BUDGETS, DEMO_MAPPINGS } from '../demo/seedData'
import type {
  Expense,
  CategoryMappings,
  CategoryBudgets,
  CategoryBudgetTimestamps,
  BackupData,
} from '../types'

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true'

export type SyncStatus = 'idle' | 'saving' | 'saved' | 'error'

interface UndoEntry {
  id: string
  label: string
  expiresAt: number
  undo: () => void
}

interface ExpenseState {
  // Data
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  budgets: CategoryBudgets
  budgetUpdatedAt: CategoryBudgetTimestamps
  budgetDeletedAt: CategoryBudgetTimestamps
  deletedIds: string[]

  // Lifecycle
  hydrated: boolean
  syncStatus: SyncStatus
  lastSavedAt: number | null
  isOffline: boolean

  // Undo stack
  undoStack: UndoEntry[]

  // Actions
  hydrate: () => void
  addExpense: (input: Partial<Expense> & { itemName: string; amount: number }) => Expense
  updateExpense: (id: string, patch: Partial<Expense>) => void
  deleteExpense: (id: string) => void
  clearAllExpenses: () => void

  addCategory: (name: string) => void
  renameCategory: (from: string, to: string) => void
  removeCategory: (name: string) => void
  setBudget: (category: string, amount: number) => void
  removeBudget: (category: string) => void

  getSmartCategory: (itemName: string) => string | null

  importBackup: (data: BackupData) => void
  exportBackup: () => BackupData
  /** Applies a merged document, sharing every unchanged object. Returns whether anything changed. */
  applySync: (data: BackupData) => boolean

  setOffline: (v: boolean) => void
  consumeUndo: (id: string) => void
  clearUndo: (id: string) => void
}

const persistSelectors = (s: ExpenseState) => ({
  expenses: s.expenses,
  categories: s.categories,
  categoryMappings: s.categoryMappings,
  budgets: s.budgets,
  budgetUpdatedAt: s.budgetUpdatedAt,
  budgetDeletedAt: s.budgetDeletedAt,
  deletedIds: s.deletedIds,
})

/** The fields an edit can change. Sync rebases pending ones onto newer remote copies. */
export type EditableField = 'itemName' | 'amount' | 'category' | 'date' | 'notes'
const EDITABLE_FIELDS: readonly EditableField[] = [
  'itemName',
  'amount',
  'category',
  'date',
  'notes',
]
type EditableValues = Partial<Pick<Expense, EditableField>>

// Until PR-2 sanitises local data, the store can hold rows read from storage that are not
// valid expenses (even `null`). Every lookup goes through this so such a row never throws.
const idOf = (row: unknown): string | undefined =>
  isRecord(row) && typeof row.id === 'string' ? row.id : undefined

const stampOf = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

/** Whether two values of an editable field are the same (a no-op edit). */
export function sameValue(field: EditableField, a: unknown, b: unknown): boolean {
  if (field === 'notes') return (a ?? undefined) === (b ?? undefined)
  if (field === 'date' && typeof a === 'string' && typeof b === 'string') {
    // The app shows and edits a date as a local day; it has no time of day to edit. The edit
    // sheet sends the shown day as local noon, while a quick add stores the moment it was
    // added: the same day is no edit, and the stored time stays (contract §7.10).
    return a === b || isSameDay(parseISO(a), parseISO(b))
  }
  return Object.is(a, b)
}

/** The given editable fields of `from` (absent ones as undefined). */
function pickFields(from: EditableValues, fields: Iterable<EditableField>): EditableValues {
  const out: EditableValues = {}
  for (const field of fields) Object.assign(out, { [field]: from[field] })
  return out
}

/** The editable fields whose value `patch` actually changes. */
function changedFields(prev: Expense, patch: Partial<Expense>): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => {
    if (!Object.hasOwn(patch, field)) return false
    const next = patch[field]
    if (next === undefined && field !== 'notes') return false
    return !sameValue(field, prev[field], next)
  })
}

// ---------------------------------------------------------------------------
// Pending changes: changes another device is not yet known to hold. Sync rebases pending field
// edits onto a newer remote copy, so a concurrent edit of another field on another device
// survives. A change stays pending until a push from another device that was built on one of
// this device's pushes carrying it comes back (`ackPendingEdits`, see the sync engine), so a
// stale push that lands later cannot take it away. In memory only (the durable outbox is PR-2).
// ---------------------------------------------------------------------------

/** A record's pending fields and the base they were edited on. */
export interface PendingEdit {
  readonly fields: ReadonlySet<EditableField>
  /** Stamp of the copy this device edited, or of a newer copy from another device merged since. */
  readonly baseStamp: number
  /** Each pending field's value in that copy. */
  readonly base: Readonly<EditableValues>
  /**
   * Each pending field's values this device has held since its first edit: the base, every value
   * written here and the values of other devices' copies merged since. A relay copy holding one
   * of them has not changed the field since that device saw this one's value.
   */
  readonly own: ReadonlyMap<EditableField, readonly unknown[]>
}

interface PendingRecord {
  baseStamp: number
  base: EditableValues
  /** Per field: the change that last wrote it here (`seq`) and the values this device held. */
  fields: Map<EditableField, { seq: number; own: readonly unknown[] }>
  /** Stamps of the copies of this record written here: this device's own copies, not news. */
  mine: Set<number>
}

const pendingEdits = new Map<string, PendingRecord>()
let editSeq = 0

// Category names and item mappings have no stamps on the v4 wire either: the merge unions names
// and picks the larger mapping value. Changes made here are kept over the relay copy while
// they are pending, with the same acknowledgement as field edits.
/** Category names this device added (true) or removed (false). */
const pendingCategories = new Map<string, { present: boolean; seq: number }>()
/** Item mappings this device set, with every value each has held here since before then. */
const pendingMappings = new Map<string, { own: readonly (string | undefined)[]; seq: number }>()

function notePendingCategory(name: string, present: boolean) {
  pendingCategories.set(name, { present, seq: ++editSeq })
}

function notePendingMapping(key: string, before: string | undefined, after: string) {
  const own = pendingMappings.get(key)?.own ?? [before]
  pendingMappings.set(key, { own: own.includes(after) ? own : [...own, after], seq: ++editSeq })
}

/** `values` with `value` added, unless the field already holds it there. */
function withValue(
  field: EditableField,
  values: readonly unknown[],
  value: unknown,
): readonly unknown[] {
  return values.some((held) => sameValue(field, held, value)) ? values : [...values, value]
}

/** Records that this device wrote `fields` of `id`, from `before` to `after`. */
function markPending(
  id: string,
  fields: readonly EditableField[],
  before: Expense,
  after: Expense,
) {
  const seq = ++editSeq
  const entry: PendingRecord = pendingEdits.get(id) ?? {
    baseStamp: stampOf(before),
    base: {},
    fields: new Map(),
    mine: new Set(),
  }
  for (const field of fields) {
    const held = entry.fields.get(field)
    // A field already pending keeps its base: the value before this device first changed it.
    if (!held) Object.assign(entry.base, { [field]: before[field] })
    entry.fields.set(field, {
      seq,
      own: withValue(field, held ? held.own : [before[field]], after[field]),
    })
  }
  entry.mine.add(stampOf(after))
  pendingEdits.set(id, entry)
}

/** What this device changed and another device is not yet known to hold. */
export interface PendingSnapshot {
  /** Acknowledges exactly these changes later (`ackPendingEdits`). */
  seq: number
  edits: ReadonlyMap<string, PendingEdit>
  /** Category names added (true) or removed (false) here. */
  categories: ReadonlyMap<string, boolean>
  /**
   * Item mappings set here, with every value each has held here since before then (a relay
   * copy holding one of them has not been changed by another device).
   */
  mappings: ReadonlyMap<string, readonly (string | undefined)[]>
}

/** A copy of the pending changes; `seq` acknowledges exactly these later. */
export function pendingEditsSnapshot(): PendingSnapshot {
  const edits = new Map<string, PendingEdit>()
  for (const [id, entry] of pendingEdits) {
    const own = new Map<EditableField, readonly unknown[]>()
    for (const [field, pending] of entry.fields) own.set(field, pending.own)
    edits.set(id, {
      fields: new Set(entry.fields.keys()),
      baseStamp: entry.baseStamp,
      base: { ...entry.base },
      own,
    })
  }
  const categories = new Map<string, boolean>()
  for (const [name, { present }] of pendingCategories) categories.set(name, present)
  const mappings = new Map<string, readonly (string | undefined)[]>()
  for (const [key, { own }] of pendingMappings) mappings.set(key, own)
  return { seq: editSeq, edits, categories, mappings }
}

/**
 * A copy of `id` from the relay, newer than its pending edits' base, was merged here, and
 * `written` is the copy this device then wrote over it (a rebase), if any. A copy from another
 * device becomes the base, and its values join the edits' own values. One of this device's own
 * copies (its push read back, or carried on in another device's push) moves nothing: a stale
 * copy from another device can be newer than the base and older than ours, and still be news.
 */
export function notePendingBase(id: string, copy: Expense, written: Expense | null): void {
  const entry = pendingEdits.get(id)
  if (!entry) return
  if (written) entry.mine.add(stampOf(written))
  const stamp = stampOf(copy)
  if (entry.mine.has(stamp) || stamp <= entry.baseStamp) return
  for (const [field, pending] of entry.fields) {
    entry.fields.set(field, { seq: pending.seq, own: withValue(field, pending.own, copy[field]) })
  }
  entry.baseStamp = stamp
  entry.base = pickFields(copy, entry.fields.keys())
}

/** Forgets the changes made up to `seq` (another device holds them now), field by field. */
export function ackPendingEdits(seq: number): void {
  for (const [id, entry] of pendingEdits) {
    for (const [field, pending] of entry.fields) if (pending.seq <= seq) entry.fields.delete(field)
    if (entry.fields.size === 0) pendingEdits.delete(id)
  }
  for (const pending of [pendingCategories, pendingMappings]) {
    for (const [key, entry] of pending) if (entry.seq <= seq) pending.delete(key)
  }
}

export function clearPendingEdits(): void {
  pendingEdits.clear()
  pendingCategories.clear()
  pendingMappings.clear()
}

/**
 * Re-files every row in `from` to `to` as an edit of each row's category: a forward stamp, so
 * last-writer-wins on every device (v0.8.4 included) adopts it instead of the tie-break undoing
 * it, and a pending field, so a concurrent edit of another field on a v0.8.5 device survives
 * (the rebase). Rows in other categories keep their objects.
 */
function refile(expenses: Expense[], from: string, to: string): Expense[] {
  if (from === to) return expenses
  const now = Date.now()
  const next = expenses.map((e) => {
    const id = idOf(e)
    if (id === undefined || e.category !== from) return e
    const refiled = { ...e, category: to, updatedAt: nextStampIso(now, stampOf(e)) }
    markPending(id, ['category'], e, refiled)
    return refiled
  })
  return next.some((e, i) => e !== expenses[i]) ? next : expenses
}

// ---------------------------------------------------------------------------
// Structure sharing for applySync: keep every object that is equal by content, so a
// no-op sync notifies no subscriber and nothing downstream recomputes.
// ---------------------------------------------------------------------------

/** The next rows, reusing current objects; null when they are the same rows in any order. */
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

function completeBudgetUpdatedAt(
  budgets: CategoryBudgets,
  existing: CategoryBudgetTimestamps | undefined,
  fallback: string,
): CategoryBudgetTimestamps {
  return Object.fromEntries(
    Object.keys(budgets).map((category) => [category, existing?.[category] ?? fallback]),
  )
}

export const useExpenseStore = create<ExpenseState>()(
  subscribeWithSelector((set, get) => ({
    expenses: [],
    categories: DEFAULT_CATEGORIES,
    categoryMappings: {},
    budgets: {},
    budgetUpdatedAt: {},
    budgetDeletedAt: {},
    deletedIds: [],

    hydrated: false,
    syncStatus: 'idle',
    lastSavedAt: null,
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,

    undoStack: [],

    hydrate: () => {
      try {
        let expenses = storage.getExpenses()
        let categories = storage.getCategories() ?? DEFAULT_CATEGORIES
        let categoryMappings = storage.getCategoryMappings()
        let budgets = storage.getBudgets()
        let budgetUpdatedAt = completeBudgetUpdatedAt(
          budgets,
          storage.getBudgetUpdatedAt(),
          LEGACY_STAMP_ISO,
        )
        let budgetDeletedAt = storage.getBudgetDeletedAt()
        let deletedIds = storage.getDeletedIds()

        // In demo mode, seed sample data on first visit (empty storage)
        if (IS_DEMO && expenses.length === 0) {
          expenses = DEMO_EXPENSES
          categories = DEMO_CATEGORIES
          categoryMappings = DEMO_MAPPINGS
          budgets = DEMO_BUDGETS
          budgetUpdatedAt = completeBudgetUpdatedAt(DEMO_BUDGETS, undefined, LEGACY_STAMP_ISO)
          budgetDeletedAt = {}
          deletedIds = []
          storage.saveExpenses(expenses)
          storage.saveCategories(categories)
          storage.saveCategoryMappings(categoryMappings)
          storage.saveBudgets(budgets)
          storage.saveBudgetUpdatedAt(budgetUpdatedAt)
          storage.saveBudgetDeletedAt(budgetDeletedAt)
        }

        set({
          expenses,
          categories,
          categoryMappings,
          budgets,
          budgetUpdatedAt,
          budgetDeletedAt,
          deletedIds,
          hydrated: true,
        })
      } catch (err) {
        console.error('hydrate error', err)
        set({ hydrated: true, syncStatus: 'error' })
      }
    },

    getSmartCategory: (itemName: string) => {
      const mappings = get().categoryMappings
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
    },

    addExpense: (input) => {
      const amount = input.amount
      // Reject invalid/negative amounts at the store boundary so corrupted
      // imports or programmatic mutations cannot leave bad data in storage.
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Amount must be a finite number greater than 0.')
      }
      const itemName = input.itemName.trim()
      if (!itemName) throw new Error('Item name is required.')
      const smart = get().getSmartCategory(itemName)
      const category = input.category || smart || 'Other'
      const now = new Date().toISOString()
      const expense: Expense = {
        id: generateId(),
        itemName,
        amount,
        category,
        date: input.date || now,
        notes: input.notes,
        createdAt: now,
      }

      // The category picked for this item name is learned, and kept pending for sync.
      const normalized = expense.itemName.toLowerCase().trim()
      const known = get().categoryMappings
      const before = Object.hasOwn(known, normalized) ? known[normalized] : undefined
      const learn = category !== 'Other' && normalized !== '' && before !== category
      if (learn) notePendingMapping(normalized, before, category)

      set((s) => {
        const nextMappings = learn
          ? { ...s.categoryMappings, [normalized]: category }
          : s.categoryMappings
        const undo: UndoEntry = {
          id: `add-${expense.id}`,
          label: `Added "${expense.itemName}"`,
          expiresAt: Date.now() + 5000,
          undo: () => {
            set((st) => ({
              expenses: st.expenses.filter((e) => e.id !== expense.id),
              deletedIds: [...new Set([...st.deletedIds, expense.id])],
            }))
          },
        }
        return {
          expenses: [expense, ...s.expenses],
          categoryMappings: nextMappings,
          undoStack: [...s.undoStack, undo].slice(-5),
        }
      })
      return expense
    },

    updateExpense: (id, patch) => {
      const prev = get().expenses.find((e) => idOf(e) === id)
      if (!prev) return
      const fields = changedFields(prev, patch)
      if (fields.length === 0) return // nothing changed: no stamp, no undo entry, no sync
      const now = Date.now()
      // A stamp strictly after the copy it replaces, so the edit wins even on a slow clock.
      const next: Expense = {
        ...prev,
        ...pickFields(patch, fields),
        updatedAt: nextStampIso(now, stampOf(prev)),
      }
      markPending(id, fields, prev, next)
      set((s) => ({
        expenses: s.expenses.map((e) => (idOf(e) === id ? next : e)),
        undoStack: [
          ...s.undoStack,
          {
            id: `update-${id}-${now}`,
            label: 'Updated expense',
            expiresAt: now + 5000,
            // Undo is a forward write: the old values under a newer stamp, so sync keeps it.
            undo: () => {
              const current = get().expenses.find((e) => idOf(e) === id)
              if (!current) return
              const restored: Expense = {
                ...current,
                ...pickFields(prev, fields),
                updatedAt: nextStampIso(Date.now(), stampOf(current)),
              }
              markPending(id, fields, current, restored)
              set((st) => ({ expenses: st.expenses.map((e) => (idOf(e) === id ? restored : e)) }))
            },
          },
        ].slice(-5),
      }))
    },

    deleteExpense: (id) => {
      const prev = get().expenses.find((e) => idOf(e) === id)
      if (!prev) return
      set((s) => ({
        expenses: s.expenses.filter((e) => idOf(e) !== id),
        deletedIds: [...new Set([...s.deletedIds, id])],
        undoStack: [
          ...s.undoStack,
          {
            id: `del-${id}-${Date.now()}`,
            label: `Deleted "${prev.itemName}"`,
            expiresAt: Date.now() + 5000,
            // The tombstone stays (a revived id would be deleted again by the next sync), so
            // the entry comes back under a new id, stamped after the deleted copy.
            undo: () => {
              const revived: Expense = {
                ...prev,
                id: generateId(),
                updatedAt: nextStampIso(Date.now(), stampOf(prev)),
              }
              set((st) => ({ expenses: [revived, ...st.expenses] }))
            },
          },
        ].slice(-5),
      }))
    },

    clearAllExpenses: () => {
      const ids = get().expenses.flatMap((e) => idOf(e) ?? [])
      set((s) => ({
        expenses: [],
        deletedIds: [...new Set([...s.deletedIds, ...ids])],
        undoStack: [],
      }))
    },

    addCategory: (name) => {
      const t = name.trim()
      if (!t || get().categories.includes(t)) return
      notePendingCategory(t, true)
      set((s) => ({ categories: [...s.categories, t] }))
    },

    renameCategory: (from, to) => {
      const target = to.trim()
      if (!target || from === target) return
      const existing = get().categories
      // If the target name already exists, this becomes a merge. Drop the
      // old category from the list (don't add a duplicate) and reassign all
      // expenses + budget keys from `from` to the existing `target`.
      const targetExists = existing.includes(target)
      const expenses = refile(get().expenses, from, target)
      notePendingCategory(from, false)
      notePendingCategory(target, true)
      set((s) => ({
        categories: targetExists
          ? s.categories.filter((c) => c !== from)
          : s.categories.map((c) => (c === from ? target : c)),
        expenses,
        budgets:
          s.budgets[from] !== undefined
            ? {
                ...Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== from)),
                // Prefer existing target budget if there's a conflict (don't clobber).
                [target]: s.budgets[target] ?? s.budgets[from],
              }
            : s.budgets,
        budgetUpdatedAt:
          s.budgets[from] !== undefined
            ? {
                ...Object.fromEntries(
                  Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== from),
                ),
                [target]:
                  s.budgetUpdatedAt[target] ?? s.budgetUpdatedAt[from] ?? new Date().toISOString(),
              }
            : s.budgetUpdatedAt,
        budgetDeletedAt:
          s.budgets[from] !== undefined
            ? Object.fromEntries(
                Object.entries(s.budgetDeletedAt).filter(([k]) => k !== from && k !== target),
              )
            : s.budgetDeletedAt,
      }))
    },

    removeCategory: (name) => {
      const now = new Date().toISOString()
      // Its rows move to Other, as edits that sync (see refile).
      const expenses = refile(get().expenses, name, 'Other')
      notePendingCategory(name, false)
      set((s) => ({
        categories: s.categories.filter((c) => c !== name),
        expenses,
        budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== name)),
        budgetUpdatedAt: Object.fromEntries(
          Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== name),
        ),
        budgetDeletedAt:
          s.budgets[name] !== undefined ? { ...s.budgetDeletedAt, [name]: now } : s.budgetDeletedAt,
      }))
    },

    setBudget: (category, amount) => {
      if (!category || amount <= 0) return
      set((s) => ({
        budgets: { ...s.budgets, [category]: amount },
        budgetUpdatedAt: { ...s.budgetUpdatedAt, [category]: new Date().toISOString() },
        budgetDeletedAt: Object.fromEntries(
          Object.entries(s.budgetDeletedAt).filter(([k]) => k !== category),
        ),
      }))
    },

    removeBudget: (category) => {
      set((s) => ({
        budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== category)),
        budgetUpdatedAt: Object.fromEntries(
          Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== category),
        ),
        budgetDeletedAt: { ...s.budgetDeletedAt, [category]: new Date().toISOString() },
      }))
    },

    importBackup: (data) => {
      set({
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
    },

    exportBackup: () => {
      const s = get()
      return {
        expenses: s.expenses,
        categories: s.categories,
        categoryMappings: s.categoryMappings,
        budgets: s.budgets,
        budgetUpdatedAt: s.budgetUpdatedAt,
        budgetDeletedAt: s.budgetDeletedAt,
        deletedIds: s.deletedIds,
        exportDate: new Date().toISOString(),
        version: '4.0',
      }
    },

    applySync: (data) => {
      const s = get()
      const budgets = data.budgets ?? {}
      const next = {
        expenses: shareRows(s.expenses, data.expenses) ?? s.expenses,
        categories: keepIfSameSet(
          s.categories,
          data.categories.length ? data.categories : DEFAULT_CATEGORIES,
        ),
        categoryMappings: keepIfEqual(s.categoryMappings, data.categoryMappings),
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
        next.budgets !== s.budgets ||
        next.budgetUpdatedAt !== s.budgetUpdatedAt ||
        next.budgetDeletedAt !== s.budgetDeletedAt ||
        next.deletedIds !== s.deletedIds
      if (!changed) return false
      set(next)
      // Remote data is written at once: no debounce window for a kill to lose it in.
      flushPendingSave()
      return true
    },

    setOffline: (v) => set({ isOffline: v }),

    consumeUndo: (id) => {
      // Prune any expired entries while we're here — keeps the stack tidy
      // even when the user never explicitly undoes.
      const now = Date.now()
      const entry = get().undoStack.find((u) => u.id === id)
      if (!entry || entry.expiresAt < now) {
        set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
        return
      }
      entry.undo()
      set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
    },

    clearUndo: (id) => {
      set((s) => ({ undoStack: s.undoStack.filter((u) => u.id !== id) }))
    },
  })),
)

// Persistence side-effect: write to localStorage on data changes.
let saveTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false

/** Writes a scheduled save now. No-op when nothing is scheduled or the store is not hydrated. */
export function flushPendingSave(): void {
  if (!saveTimer || !useExpenseStore.getState().hydrated) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    persistCurrentState()
  } catch {
    useExpenseStore.setState({ syncStatus: 'error' })
  }
}

function persistCurrentState() {
  const slice = persistSelectors(useExpenseStore.getState())
  storage.saveAll(
    slice.expenses,
    slice.categories,
    slice.categoryMappings,
    slice.budgets,
    slice.budgetUpdatedAt,
    slice.budgetDeletedAt,
    slice.deletedIds,
  )
  useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: Date.now() })
}

export function installPersistence() {
  if (initialized) return
  initialized = true

  useExpenseStore.subscribe(
    persistSelectors,
    () => {
      if (!useExpenseStore.getState().hydrated) return
      useExpenseStore.setState({ syncStatus: 'saving' })
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        try {
          persistCurrentState()
        } catch {
          useExpenseStore.setState({ syncStatus: 'error' })
        }
      }, 400)
    },
    {
      equalityFn: (a, b) =>
        a.expenses === b.expenses &&
        a.categories === b.categories &&
        a.categoryMappings === b.categoryMappings &&
        a.budgets === b.budgets &&
        a.budgetUpdatedAt === b.budgetUpdatedAt &&
        a.budgetDeletedAt === b.budgetDeletedAt &&
        a.deletedIds === b.deletedIds,
    },
  )

  if (typeof window !== 'undefined') {
    // Mobile OSes send visibilitychange (not pagehide) when the app is switched away from,
    // then may kill it: write the debounced save before that can happen (F-017).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingSave()
    })
    window.addEventListener('pagehide', flushPendingSave)
    window.addEventListener('beforeunload', flushPendingSave)
    window.addEventListener('online', () => useExpenseStore.getState().setOffline(false))
    window.addEventListener('offline', () => useExpenseStore.getState().setOffline(true))
  }
}
