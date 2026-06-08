import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import Fuse from 'fuse.js'
import { storage } from '../services/storage'
import { DEFAULT_CATEGORIES, FUSE_THRESHOLD, FUSE_SCORE_CUTOFF } from '../constants'
import { generateId, migrateExpenses } from '../utils/helpers'
import { DEMO_EXPENSES, DEMO_CATEGORIES, DEMO_BUDGETS, DEMO_MAPPINGS } from '../demo/seedData'
import type {
  Expense,
  CategoryMappings,
  CategoryBudgets,
  CategoryBudgetTimestamps,
  BackupData,
} from '../types'

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true'
const LEGACY_BUDGET_UPDATED_AT = '1970-01-01T00:00:00.000Z'

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
  applySync: (data: BackupData) => void

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
        let expenses = migrateExpenses(storage.getExpenses())
        let categories = storage.getCategories() ?? DEFAULT_CATEGORIES
        let categoryMappings = storage.getCategoryMappings()
        let budgets = storage.getBudgets()
        let budgetUpdatedAt = completeBudgetUpdatedAt(
          budgets,
          storage.getBudgetUpdatedAt(),
          LEGACY_BUDGET_UPDATED_AT,
        )
        let budgetDeletedAt = storage.getBudgetDeletedAt()
        let deletedIds = storage.getDeletedIds()

        // In demo mode, seed sample data on first visit (empty storage)
        if (IS_DEMO && expenses.length === 0) {
          expenses = DEMO_EXPENSES
          categories = DEMO_CATEGORIES
          categoryMappings = DEMO_MAPPINGS
          budgets = DEMO_BUDGETS
          budgetUpdatedAt = completeBudgetUpdatedAt(
            DEMO_BUDGETS,
            undefined,
            LEGACY_BUDGET_UPDATED_AT,
          )
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
      const amount = Number(input.amount)
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

      set((s) => {
        const normalized = expense.itemName.toLowerCase().trim()
        const nextMappings =
          category !== 'Other' && normalized
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
      const prev = get().expenses.find((e) => e.id === id)
      if (!prev) return
      set((s) => ({
        expenses: s.expenses.map((e) =>
          e.id === id ? { ...e, ...patch, updatedAt: new Date().toISOString() } : e,
        ),
        undoStack: [
          ...s.undoStack,
          {
            id: `update-${id}-${Date.now()}`,
            label: 'Updated expense',
            expiresAt: Date.now() + 5000,
            undo: () =>
              set((st) => ({ expenses: st.expenses.map((e) => (e.id === id ? prev : e)) })),
          },
        ].slice(-5),
      }))
    },

    deleteExpense: (id) => {
      const prev = get().expenses.find((e) => e.id === id)
      if (!prev) return
      set((s) => ({
        expenses: s.expenses.filter((e) => e.id !== id),
        deletedIds: [...new Set([...s.deletedIds, id])],
        undoStack: [
          ...s.undoStack,
          {
            id: `del-${id}-${Date.now()}`,
            label: `Deleted "${prev.itemName}"`,
            expiresAt: Date.now() + 5000,
            undo: () =>
              set((st) => ({
                expenses: [prev, ...st.expenses],
                deletedIds: st.deletedIds.filter((d) => d !== id),
              })),
          },
        ].slice(-5),
      }))
    },

    clearAllExpenses: () => {
      const ids = get().expenses.map((e) => e.id)
      set((s) => ({
        expenses: [],
        deletedIds: [...new Set([...s.deletedIds, ...ids])],
        undoStack: [],
      }))
    },

    addCategory: (name) => {
      const t = name.trim()
      if (!t) return
      set((s) => (s.categories.includes(t) ? s : { categories: [...s.categories, t] }))
    },

    renameCategory: (from, to) => {
      const target = to.trim()
      if (!target || from === target) return
      const existing = get().categories
      // If the target name already exists, this becomes a merge. Drop the
      // old category from the list (don't add a duplicate) and reassign all
      // expenses + budget keys from `from` to the existing `target`.
      const targetExists = existing.includes(target)
      set((s) => ({
        categories: targetExists
          ? s.categories.filter((c) => c !== from)
          : s.categories.map((c) => (c === from ? target : c)),
        expenses: s.expenses.map((e) => (e.category === from ? { ...e, category: target } : e)),
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
      set((s) => ({
        categories: s.categories.filter((c) => c !== name),
        expenses: s.expenses.map((e) => (e.category === name ? { ...e, category: 'Other' } : e)),
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
        expenses: data.expenses ? migrateExpenses(data.expenses) : [],
        categories: data.categories?.length ? data.categories : DEFAULT_CATEGORIES,
        categoryMappings: data.categoryMappings ?? {},
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
      set({
        expenses: data.expenses ? migrateExpenses(data.expenses) : [],
        categories: data.categories?.length ? data.categories : DEFAULT_CATEGORIES,
        categoryMappings: data.categoryMappings ?? {},
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
    (slice) => {
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
    const flushPendingSave = () => {
      if (!saveTimer || !useExpenseStore.getState().hydrated) return
      clearTimeout(saveTimer)
      saveTimer = null
      try {
        persistCurrentState()
      } catch {
        useExpenseStore.setState({ syncStatus: 'error' })
      }
    }

    window.addEventListener('pagehide', flushPendingSave)
    window.addEventListener('beforeunload', flushPendingSave)
    window.addEventListener('online', () => useExpenseStore.getState().setOffline(false))
    window.addEventListener('offline', () => useExpenseStore.getState().setOffline(true))
  }
}
