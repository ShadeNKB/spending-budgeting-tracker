import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import Fuse from "fuse.js";
import { storage } from "../services/storage";
import { DEFAULT_CATEGORIES, FUSE_THRESHOLD, FUSE_SCORE_CUTOFF } from "../constants";
import { generateId, migrateExpenses } from "../utils/helpers";
import {
  DEMO_EXPENSES,
  DEMO_CATEGORIES,
  DEMO_BUDGETS,
  DEMO_MAPPINGS,
} from "../demo/seedData";
import type {
  Expense,
  CategoryMappings,
  CategoryBudgets,
  BackupData,
} from "../types";

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === "true";

export type SyncStatus = "idle" | "saving" | "saved" | "error";

interface UndoEntry {
  id: string;
  label: string;
  expiresAt: number;
  undo: () => void;
}

interface ExpenseState {
  // Data
  expenses: Expense[];
  categories: string[];
  categoryMappings: CategoryMappings;
  budgets: CategoryBudgets;

  // Lifecycle
  hydrated: boolean;
  syncStatus: SyncStatus;
  lastSavedAt: number | null;
  isOffline: boolean;

  // Undo stack
  undoStack: UndoEntry[];

  // Actions
  hydrate: () => void;
  addExpense: (input: Partial<Expense> & { itemName: string; amount: number }) => Expense;
  updateExpense: (id: string, patch: Partial<Expense>) => void;
  deleteExpense: (id: string) => void;
  deleteMany: (ids: string[]) => void;

  addCategory: (name: string) => void;
  renameCategory: (from: string, to: string) => void;
  removeCategory: (name: string) => void;
  setBudget: (category: string, amount: number) => void;
  removeBudget: (category: string) => void;

  getSmartCategory: (itemName: string) => string | null;

  importBackup: (data: BackupData) => void;
  exportBackup: () => BackupData;

  setOffline: (v: boolean) => void;
  consumeUndo: (id: string) => void;
  clearUndo: (id: string) => void;
}

const persistSelectors = (s: ExpenseState) => ({
  expenses: s.expenses,
  categories: s.categories,
  categoryMappings: s.categoryMappings,
  budgets: s.budgets,
});

export const useExpenseStore = create<ExpenseState>()(
  subscribeWithSelector((set, get) => ({
    expenses: [],
    categories: DEFAULT_CATEGORIES,
    categoryMappings: {},
    budgets: {},

    hydrated: false,
    syncStatus: "idle",
    lastSavedAt: null,
    isOffline: typeof navigator !== "undefined" ? !navigator.onLine : false,

    undoStack: [],

    hydrate: () => {
      try {
        let expenses = migrateExpenses(storage.getExpenses());
        let categories = storage.getCategories() ?? DEFAULT_CATEGORIES;
        let categoryMappings = storage.getCategoryMappings();
        let budgets = storage.getBudgets();

        // In demo mode, seed sample data on first visit (empty storage)
        if (IS_DEMO && expenses.length === 0) {
          expenses = DEMO_EXPENSES;
          categories = DEMO_CATEGORIES;
          categoryMappings = DEMO_MAPPINGS;
          budgets = DEMO_BUDGETS;
          storage.saveExpenses(expenses);
          storage.saveCategories(categories);
          storage.saveCategoryMappings(categoryMappings);
          storage.saveBudgets(budgets);
        }

        set({ expenses, categories, categoryMappings, budgets, hydrated: true });
      } catch (err) {
        console.error("hydrate error", err);
        set({ hydrated: true, syncStatus: "error" });
      }
    },

    getSmartCategory: (itemName: string) => {
      const mappings = get().categoryMappings;
      if (!itemName) return null;
      const normalized = itemName.toLowerCase().trim();
      if (mappings[normalized]) return mappings[normalized];

      const entries = Object.entries(mappings).map(([item, category]) => ({ item, category }));
      if (!entries.length) return null;
      const fuse = new Fuse(entries, {
        keys: ["item"],
        threshold: FUSE_THRESHOLD,
        includeScore: true,
        minMatchCharLength: 2,
      });
      const hit = fuse.search(normalized)[0];
      return hit && (hit.score ?? 1) < FUSE_SCORE_CUTOFF ? hit.item.category : null;
    },

    addExpense: (input) => {
      const smart = get().getSmartCategory(input.itemName);
      const category = input.category || smart || "Other";
      const now = new Date().toISOString();
      const expense: Expense = {
        id: generateId(),
        itemName: input.itemName.trim(),
        amount: Number(input.amount),
        category,
        date: input.date || now,
        notes: input.notes,
        createdAt: now,
      };

      set((s) => {
        const normalized = expense.itemName.toLowerCase().trim();
        const nextMappings =
          category !== "Other" && normalized
            ? { ...s.categoryMappings, [normalized]: category }
            : s.categoryMappings;
        const undo: UndoEntry = {
          id: `add-${expense.id}`,
          label: `Added "${expense.itemName}"`,
          expiresAt: Date.now() + 5000,
          undo: () => {
            set((st) => ({ expenses: st.expenses.filter((e) => e.id !== expense.id) }));
          },
        };
        return {
          expenses: [expense, ...s.expenses],
          categoryMappings: nextMappings,
          undoStack: [...s.undoStack, undo].slice(-5),
        };
      });
      return expense;
    },

    updateExpense: (id, patch) => {
      const prev = get().expenses.find((e) => e.id === id);
      if (!prev) return;
      set((s) => ({
        expenses: s.expenses.map((e) =>
          e.id === id ? { ...e, ...patch, updatedAt: new Date().toISOString() } : e
        ),
        undoStack: [
          ...s.undoStack,
          {
            id: `update-${id}-${Date.now()}`,
            label: "Updated expense",
            expiresAt: Date.now() + 5000,
            undo: () => set((st) => ({ expenses: st.expenses.map((e) => (e.id === id ? prev : e)) })),
          },
        ].slice(-5),
      }));
    },

    deleteExpense: (id) => {
      const prev = get().expenses.find((e) => e.id === id);
      if (!prev) return;
      set((s) => ({
        expenses: s.expenses.filter((e) => e.id !== id),
        undoStack: [
          ...s.undoStack,
          {
            id: `del-${id}-${Date.now()}`,
            label: `Deleted "${prev.itemName}"`,
            expiresAt: Date.now() + 5000,
            undo: () => set((st) => ({ expenses: [prev, ...st.expenses] })),
          },
        ].slice(-5),
      }));
    },

    deleteMany: (ids) => {
      const set_ = new Set(ids);
      const prev = get().expenses.filter((e) => set_.has(e.id));
      if (!prev.length) return;
      set((s) => ({
        expenses: s.expenses.filter((e) => !set_.has(e.id)),
        undoStack: [
          ...s.undoStack,
          {
            id: `delMany-${Date.now()}`,
            label: `Deleted ${prev.length} items`,
            expiresAt: Date.now() + 6000,
            undo: () => set((st) => ({ expenses: [...prev, ...st.expenses] })),
          },
        ].slice(-5),
      }));
    },

    addCategory: (name) => {
      const t = name.trim();
      if (!t) return;
      set((s) => (s.categories.includes(t) ? s : { categories: [...s.categories, t] }));
    },

    renameCategory: (from, to) => {
      const target = to.trim();
      if (!target || from === target) return;
      set((s) => ({
        categories: s.categories.map((c) => (c === from ? target : c)),
        expenses: s.expenses.map((e) => (e.category === from ? { ...e, category: target } : e)),
        budgets:
          s.budgets[from] !== undefined
            ? { ...Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== from)), [target]: s.budgets[from] }
            : s.budgets,
      }));
    },

    removeCategory: (name) => {
      set((s) => ({
        categories: s.categories.filter((c) => c !== name),
        expenses: s.expenses.map((e) => (e.category === name ? { ...e, category: "Other" } : e)),
        budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== name)),
      }));
    },

    setBudget: (category, amount) => {
      if (!category || amount <= 0) return;
      set((s) => ({ budgets: { ...s.budgets, [category]: amount } }));
    },

    removeBudget: (category) => {
      set((s) => ({ budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== category)) }));
    },

    importBackup: (data) => {
      set({
        expenses: data.expenses ? migrateExpenses(data.expenses) : [],
        categories: data.categories?.length ? data.categories : DEFAULT_CATEGORIES,
        categoryMappings: data.categoryMappings ?? {},
        budgets: data.budgets ?? {},
      });
    },

    exportBackup: () => {
      const s = get();
      return {
        expenses: s.expenses,
        categories: s.categories,
        categoryMappings: s.categoryMappings,
        budgets: s.budgets,
        exportDate: new Date().toISOString(),
        version: "3.0",
      };
    },

    setOffline: (v) => set({ isOffline: v }),

    consumeUndo: (id) => {
      const entry = get().undoStack.find((u) => u.id === id);
      if (!entry) return;
      entry.undo();
      set((s) => ({ undoStack: s.undoStack.filter((u) => u.id !== id) }));
    },

    clearUndo: (id) => {
      set((s) => ({ undoStack: s.undoStack.filter((u) => u.id !== id) }));
    },
  }))
);

// Persistence side-effect: write to localStorage on data changes.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

export function installPersistence() {
  if (initialized) return;
  initialized = true;

  useExpenseStore.subscribe(
    persistSelectors,
    (slice) => {
      if (!useExpenseStore.getState().hydrated) return;
      useExpenseStore.setState({ syncStatus: "saving" });
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          storage.saveAll(slice.expenses, slice.categories, slice.categoryMappings, slice.budgets);
          useExpenseStore.setState({ syncStatus: "saved", lastSavedAt: Date.now() });
        } catch {
          useExpenseStore.setState({ syncStatus: "error" });
        }
      }, 400);
    },
    { equalityFn: (a, b) => a.expenses === b.expenses && a.categories === b.categories && a.categoryMappings === b.categoryMappings && a.budgets === b.budgets }
  );

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => useExpenseStore.getState().setOffline(false));
    window.addEventListener("offline", () => useExpenseStore.getState().setOffline(true));
  }
}
