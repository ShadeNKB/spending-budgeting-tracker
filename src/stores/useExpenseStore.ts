import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import Fuse from 'fuse.js'
import { isSameDay, parseISO } from 'date-fns'
import { storage } from '../services/storage'
import { DEFAULT_CATEGORIES, FUSE_THRESHOLD, FUSE_SCORE_CUTOFF } from '../constants'
import { generateId } from '../utils/helpers'
import { isRecord } from '../lib/backup'
import { LEGACY_STAMP_ISO, nextStampIso, stampMs } from '../lib/stamps'
import { DEMO_EXPENSES, DEMO_CATEGORIES, DEMO_BUDGETS, DEMO_MAPPINGS } from '../demo/seedData'
import type {
  Expense,
  CategoryMappings,
  CategoryBudgets,
  CategoryBudgetTimestamps,
  CategoryMappingTimestamps,
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
  /** When each mapping was last set here or on another device (sync merges per key by it). */
  mappingUpdatedAt: CategoryMappingTimestamps
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

  setOffline: (v: boolean) => void
  consumeUndo: (id: string) => void
  clearUndo: (id: string) => void
}

const persistSelectors = (s: ExpenseState) => ({
  expenses: s.expenses,
  categories: s.categories,
  categoryMappings: s.categoryMappings,
  mappingUpdatedAt: s.mappingUpdatedAt,
  budgets: s.budgets,
  budgetUpdatedAt: s.budgetUpdatedAt,
  budgetDeletedAt: s.budgetDeletedAt,
  deletedIds: s.deletedIds,
})

/** The fields an edit can change. */
type EditableField = 'itemName' | 'amount' | 'category' | 'date' | 'notes'
const EDITABLE_FIELDS: readonly EditableField[] = [
  'itemName',
  'amount',
  'category',
  'date',
  'notes',
]
type EditableValues = Partial<Pick<Expense, EditableField>>

// Until PR-2 sanitises local data, the store can hold rows read from storage that are not
// valid expenses (objects with missing or mistyped fields; storage drops non-objects). Every
// lookup goes through this so such a row never throws.
const idOf = (row: unknown): string | undefined =>
  isRecord(row) && typeof row.id === 'string' ? row.id : undefined

const stampOf = (e: Expense): number => stampMs(e.updatedAt ?? e.createdAt)

/** Whether two values of an editable field are the same (a no-op edit). */
function sameValue(field: EditableField, a: unknown, b: unknown): boolean {
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

/**
 * Re-files every row in `from` to `to` with a forward stamp, so last-writer-wins on every
 * device (v0.8.4 included) adopts the re-file instead of a tie-break undoing it. Rows in other
 * categories keep their objects.
 */
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

/** A stamp at `now`, strictly after every stamp the key holds in `stamps`. */
const nextKeyStamp = (now: number, key: string, ...stamps: Readonly<Record<string, string>>[]) =>
  nextStampIso(now, ...stamps.map((at) => stampMs(ownValue(at, key))))

/**
 * Points every item mapping whose category is `from` at `to`, each with a forward stamp, so the
 * change wins the per-key merge on every device. With no mapping on `from`, both objects are
 * returned as they are.
 */
function remap(
  mappings: CategoryMappings,
  stamps: CategoryMappingTimestamps,
  from: string,
  to: string,
  now: number,
): Pick<ExpenseState, 'categoryMappings' | 'mappingUpdatedAt'> {
  const keys = Object.keys(mappings).filter((key) => mappings[key] === from)
  if (from === to || keys.length === 0) {
    return { categoryMappings: mappings, mappingUpdatedAt: stamps }
  }
  // Built from entries, so an item named "__proto__" is a key like any other.
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

/** `record` without `key` (the same object when it has no such key). */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(record, key)) return record
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

/** A stamp for every budget: its own when it has one, else `fallback`. */
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

export const useExpenseStore = create<ExpenseState>()(
  subscribeWithSelector((set, get) => ({
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
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,

    undoStack: [],

    hydrate: () => {
      try {
        let expenses = storage.getExpenses()
        let categories = storage.getCategories() ?? DEFAULT_CATEGORIES
        let categoryMappings = storage.getCategoryMappings()
        let mappingUpdatedAt = storage.getMappingUpdatedAt()
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
          mappingUpdatedAt = {}
          budgets = DEMO_BUDGETS
          budgetUpdatedAt = completeBudgetUpdatedAt(DEMO_BUDGETS, undefined, LEGACY_STAMP_ISO)
          budgetDeletedAt = {}
          deletedIds = []
          storage.saveExpenses(expenses)
          storage.saveCategories(categories)
          storage.saveCategoryMappings(categoryMappings)
          storage.saveMappingUpdatedAt(mappingUpdatedAt)
          storage.saveBudgets(budgets)
          storage.saveBudgetUpdatedAt(budgetUpdatedAt)
          storage.saveBudgetDeletedAt(budgetDeletedAt)
        }

        set({
          expenses,
          categories,
          categoryMappings,
          mappingUpdatedAt,
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
      // Own keys only: "constructor" or "__proto__" would otherwise find Object.prototype.
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
      const at = Date.now()
      const now = new Date(at).toISOString()
      const expense: Expense = {
        id: generateId(),
        itemName,
        amount,
        category,
        date: input.date || now,
        notes: input.notes,
        createdAt: now,
      }

      // The category picked for this item name is learned. A new or changed pick is stamped,
      // so the latest pick wins the per-key merge on every device.
      const normalized = expense.itemName.toLowerCase().trim()
      const learn =
        category !== 'Other' &&
        normalized !== '' &&
        ownValue(get().categoryMappings, normalized) !== category

      set((s) => {
        const learned: Partial<ExpenseState> = learn
          ? {
              categoryMappings: { ...s.categoryMappings, [normalized]: category },
              mappingUpdatedAt: {
                ...s.mappingUpdatedAt,
                [normalized]: nextKeyStamp(at, normalized, s.mappingUpdatedAt),
              },
            }
          : {}
        const undo: UndoEntry = {
          id: `add-${expense.id}`,
          label: `Added "${expense.itemName}"`,
          expiresAt: Date.now() + 5000,
          undo: () => {
            set((st) => ({
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
      set((s) => ({ categories: [...s.categories, t] }))
    },

    renameCategory: (from, to) => {
      const target = to.trim()
      if (!target || from === target) return
      const now = Date.now()
      set((s) => {
        // If the target name already exists, this becomes a merge: the old name leaves the
        // list and its rows, budget and item mappings move to the existing target.
        const targetExists = s.categories.includes(target)
        const moved = ownValue(s.budgets, from)
        const kept = ownValue(s.budgets, target)
        // An existing target budget is kept (not clobbered). The old name's budget leaves with
        // a tombstone and a budget moved over is stamped, so both changes sync.
        const budget: Partial<ExpenseState> =
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
    },

    removeCategory: (name) => {
      const now = Date.now()
      set((s) => ({
        categories: s.categories.filter((c) => c !== name),
        // Its rows and item mappings move to Other, as stamped changes that sync.
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
    },

    // Budget stamps are strictly after the key's last set or delete, so a change made after
    // seeing another device's wins even when this device's clock is behind.
    setBudget: (category, amount) => {
      if (!category || !Number.isFinite(amount) || amount <= 0) return
      // The value it already has is no edit (leaving the budget field unchanged): a fresh stamp
      // would beat a change the other device made that has not arrived here yet.
      if (ownValue(get().budgets, category) === amount) return
      const now = Date.now()
      set((s) => ({
        budgets: { ...s.budgets, [category]: amount },
        budgetUpdatedAt: {
          ...s.budgetUpdatedAt,
          [category]: nextKeyStamp(now, category, s.budgetUpdatedAt, s.budgetDeletedAt),
        },
        budgetDeletedAt: without(s.budgetDeletedAt, category),
      }))
    },

    removeBudget: (category) => {
      const now = Date.now()
      set((s) => ({
        budgets: without(s.budgets, category),
        budgetUpdatedAt: without(s.budgetUpdatedAt, category),
        budgetDeletedAt: {
          ...s.budgetDeletedAt,
          [category]: nextKeyStamp(now, category, s.budgetUpdatedAt, s.budgetDeletedAt),
        },
      }))
    },

    importBackup: (data) => {
      set({
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
    },

    exportBackup: () => {
      const s = get()
      return {
        expenses: s.expenses,
        categories: s.categories,
        categoryMappings: s.categoryMappings,
        mappingUpdatedAt: s.mappingUpdatedAt,
        budgets: s.budgets,
        budgetUpdatedAt: s.budgetUpdatedAt,
        budgetDeletedAt: s.budgetDeletedAt,
        deletedIds: s.deletedIds,
        exportDate: new Date().toISOString(),
        version: '4.0',
      }
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
// The last write failed (storage full or refused): storage is behind the store until a write
// succeeds, so every flush retries it, with or without a new change.
let unsaved = false
let initialized = false

/**
 * Writes a scheduled save, or one that failed, now. No-op when storage is up to date or the
 * store is not hydrated.
 */
export function flushPendingSave(): void {
  if ((!saveTimer && !unsaved) || !useExpenseStore.getState().hydrated) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  save()
}

function save() {
  const slice = persistSelectors(useExpenseStore.getState())
  try {
    storage.saveAll(
      slice.expenses,
      slice.categories,
      slice.categoryMappings,
      slice.budgets,
      slice.budgetUpdatedAt,
      slice.budgetDeletedAt,
      slice.deletedIds,
      slice.mappingUpdatedAt,
    )
  } catch {
    unsaved = true
    useExpenseStore.setState({ syncStatus: 'error' })
    return
  }
  unsaved = false
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
        saveTimer = null
        save()
      }, 400)
    },
    {
      equalityFn: (a, b) =>
        a.expenses === b.expenses &&
        a.categories === b.categories &&
        a.categoryMappings === b.categoryMappings &&
        a.mappingUpdatedAt === b.mappingUpdatedAt &&
        a.budgets === b.budgets &&
        a.budgetUpdatedAt === b.budgetUpdatedAt &&
        a.budgetDeletedAt === b.budgetDeletedAt &&
        a.deletedIds === b.deletedIds,
    },
  )

  if (typeof window !== 'undefined') {
    // Mobile OSes send visibilitychange (not pagehide) when the app is switched away from,
    // then may kill it: write the debounced save, or retry one that failed, before that can
    // happen (F-017).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingSave()
    })
    window.addEventListener('pagehide', flushPendingSave)
    window.addEventListener('beforeunload', flushPendingSave)
    window.addEventListener('online', () => useExpenseStore.getState().setOffline(false))
    window.addEventListener('offline', () => useExpenseStore.getState().setOffline(true))
    // The store read the network state when it loaded; a change before these listeners were
    // attached would otherwise go unseen until the next one.
    const { isOffline, setOffline } = useExpenseStore.getState()
    if (isOffline === navigator.onLine) setOffline(!navigator.onLine)
  }
}
