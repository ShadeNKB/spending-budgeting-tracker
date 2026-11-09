// The expense store: a thin facade in the entry chunk over the local engine (track spec §6.1, P2-1).
// It holds the views the screens read and delegates every action to the engine, which lives in its
// own lazy chunk (src/data/local/engine.ts) with the data core. main.tsx starts loading that chunk
// before React renders; the shell shows "Loading local spending data" until `hydrated`. Only types
// come from src/data here, so the core never lands in the first download.
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { DEFAULT_CATEGORIES } from '../constants'
import { importWithReload } from '../lib/chunkReload'
import { isSupportedCurrency } from '../lib/format'
import type { BackupFileV5, ExpensePatch, NewExpenseInput } from '../data/core/types'
import type * as EngineModuleNs from '../data/local/engine'
import type {
  Engine,
  EngineHost,
  ExpenseActions,
  ExpenseFields,
  ImportOutcome,
  ImportPreview,
  RecoveryApi,
  RestoreResult,
  UndoOutcome,
} from '../data/local/types'
import type { ExpenseView } from '../types'
import { readDeviceCurrency, setCurrencyWriter, useUIStore } from './useUIStore'

export type {
  Attention,
  AttentionItem,
  BootReport,
  ChangeItem,
  ImportOutcome,
  ImportPreview,
  LocalStatus,
  RecordSummary,
  RecoveryApi,
  RemoteApplied,
  RestoreResult,
  SnapshotInfo,
  SnapshotReason,
  SnapshotSkips,
  StorageFacts,
  SyncMeta,
  SyncPort,
  UndoOutcome,
} from '../data/local/types'
export type { ExpenseView } from '../types'

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true'

/**
 * The ids of a demo build's sample rows start with this (core DEMO_PREFIX, P2-22: a test keeps
 * them equal; this file imports nothing from the core at runtime). They never sync.
 */
export const SAMPLE_ID_PREFIX = 'demo-'

/** The rows that are the owner's own: on a demo build, all but the sample rows. */
export const isOwnRow = (e: { readonly id: string }): boolean =>
  !IS_DEMO || !e.id.startsWith(SAMPLE_ID_PREFIX)

export type SyncStatus = ExpenseFields['syncStatus']

export interface ExpenseState extends ExpenseFields, ExpenseActions {
  /** P2-14: re-runnable; flushes pending writes, then boots from the current storage. */
  hydrate(): Promise<void>
  setOffline(v: boolean): void
}

type EngineModule = typeof EngineModuleNs

let engine: Engine | null = null
let loading: Promise<EngineModule | null> | null = null
let markHydrated: () => void = () => undefined
const hydratedOnce = new Promise<void>((resolve) => {
  markHydrated = resolve
})

const host: EngineHost = {
  set: (patch) => {
    useExpenseStore.setState(patch)
  },
  showCurrency: (code) => {
    if (isSupportedCurrency(code) && useUIStore.getState().currency !== code) {
      useUIStore.setState({ currency: code })
    }
  },
  deviceCurrency: readDeviceCurrency,
}

/** Starts downloading the engine chunk (main.tsx calls this first). Idempotent. */
export function startEngineLoad(): void {
  loading ??= importWithReload(() => import('../data/local/engine')).then(
    (m) => m,
    () => {
      // no retry loop: the shell offers Reload and "Download my data" (lib/rescue, no engine)
      useExpenseStore.setState({ bootError: 'engine-load' })
      return null
    },
  )
}

/** Resolves once the first boot has published its views. */
export function whenHydrated(): Promise<void> {
  return hydratedOnce
}

/** What an action says when the engine chunk could not load: nothing can be changed this time. */
export const NOT_STARTED = "SpendTrack couldn't start. Reload to add entries."

/**
 * True once the data has loaded, false when it will not this session (the engine chunk failed
 * to load): what an action taken in the first moments of a cold start waits for.
 */
export function whenReady(): Promise<boolean> {
  const now = useExpenseStore.getState()
  if (now.hydrated) return Promise.resolve(true)
  if (now.bootError !== null) return Promise.resolve(false)
  return new Promise((resolve) => {
    const stop = useExpenseStore.subscribe((s) => {
      if (!s.hydrated && s.bootError === null) return
      stop()
      resolve(s.hydrated)
    })
  })
}

/** The engine, for an action. Actions need the data loaded: the shell shows nothing before. */
function ready(): Engine {
  if (engine === null || !useExpenseStore.getState().hydrated) {
    throw new Error(
      useExpenseStore.getState().bootError === null
        ? 'SpendTrack is still loading your data.'
        : NOT_STARTED,
    )
  }
  return engine
}

/** The sync bridge's access to the doc (§6.2); null until hydrated. */
export function getSyncPort(): Engine['port'] | null {
  return engine !== null && useExpenseStore.getState().hydrated ? engine.port : null
}

let persistenceRequested = false

/**
 * Lifecycle flushes and cross-tab listeners (in the engine, once it has loaded) and the network
 * flag. Idempotent.
 */
export function installPersistence(): void {
  if (persistenceRequested) return
  persistenceRequested = true
  engine?.install()
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => {
    useExpenseStore.getState().setOffline(false)
  })
  window.addEventListener('offline', () => {
    useExpenseStore.getState().setOffline(true)
  })
  // The store read the network state when it loaded; a change before these listeners were
  // attached would otherwise go unseen until the next one.
  if (useExpenseStore.getState().isOffline === navigator.onLine) {
    useExpenseStore.getState().setOffline(!navigator.onLine)
  }
}

/** "Undone", or how many entries kept a change made on another device (all of them: nothing undone). */
/**
 * Said when an Undo comes too late: its window closed (a toast held open by a pointer outlives
 * it) or another Undo took it first. Nothing changed, and the press must not pass in silence
 * (F-115).
 */
export const UNDO_TOO_LATE = 'Too late to undo: the change was kept.'

export function undoOutcomeMessage(o: UndoOutcome): string {
  if (o.skipped === 0) return 'Undone'
  const kept = `${o.skipped.toLocaleString()} ${o.skipped === 1 ? 'entry' : 'entries'}`
  if (o.applied === 0) return `Nothing to undo: ${kept} changed on another device`
  return `Undone, except ${kept} changed on another device`
}

const NO_ATTENTION = { quarantined: 0, copies: 0, unseen: 0, full: false } as const
const NO_FACTS = { persisted: null, lastBackupAt: null, mirror: 'on', nearlyFull: false } as const

export const useExpenseStore = create<ExpenseState>()(
  subscribeWithSelector((set) => ({
    hydrated: false,
    bootError: null,
    expenses: [],
    categories: DEFAULT_CATEGORIES,
    categoryMappings: {},
    budgets: {},
    syncStatus: 'idle',
    lastSavedAt: null,
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    local: 'saved',
    undoStack: [],
    attention: NO_ATTENTION,
    facts: NO_FACTS,
    report: null,
    demo: 'none',

    hydrate: async () => {
      startEngineLoad()
      const mod = await loading
      if (mod === null) return
      engine ??= mod.createEngine(host)
      await engine.boot()
      if (persistenceRequested) engine.install()
      markHydrated()
    },

    addExpense: (input: NewExpenseInput): ExpenseView => ready().addExpense(input),
    saveNow: () => ready().saveNow(),
    updateExpense: (id: string, patch: ExpensePatch) => {
      ready().updateExpense(id, patch)
    },
    deleteExpense: (id: string) => {
      ready().deleteExpense(id)
    },
    deleteAllEverywhere: () => {
      ready().deleteAllEverywhere()
    },
    removeDataFromThisDevice: () => ready().removeDataFromThisDevice(),
    unsyncedChanges: () => ready().unsyncedChanges(),
    clearSampleData: () => {
      ready().clearSampleData()
    },
    addCategory: (name: string) => {
      ready().addCategory(name)
    },
    renameCategory: (from: string, to: string) => {
      ready().renameCategory(from, to)
    },
    removeCategory: (name: string) => {
      ready().removeCategory(name)
    },
    setBudget: (category: string, amount: number) => {
      ready().setBudget(category, amount)
    },
    removeBudget: (category: string) => {
      ready().removeBudget(category)
    },
    setCurrency: (code: string) => {
      ready().setCurrency(code)
    },
    getSmartCategory: (itemName: string) => engine?.getSmartCategory(itemName) ?? null,
    previewImport: (file: Blob): Promise<ImportPreview> => ready().previewImport(file),
    applyImport: (preview: ImportPreview, mode: 'restore' | 'replace'): ImportOutcome =>
      ready().applyImport(preview, mode),
    exportBackup: (): BackupFileV5 => ready().exportBackup(),
    markBackedUp: () => {
      ready().markBackedUp()
    },
    quarantineFile: () => ready().quarantineFile(),
    markAttentionSeen: () => {
      ready().markAttentionSeen()
    },
    restoreJournal: (entryId: string): Promise<RestoreResult> => ready().restoreJournal(entryId),
    recovery: (): Promise<RecoveryApi> => ready().recovery(),
    refreshStorageFacts: () => {
      engine?.refreshStorageFacts()
    },
    dismissReport: () => {
      set({ report: null })
    },
    setOffline: (v: boolean) => {
      set({ isOffline: v })
    },
    consumeUndo: (id: string): UndoOutcome | null => engine?.consumeUndo(id) ?? null,
    clearUndo: (id: string) => {
      engine?.clearUndo(id)
    },
  })),
)

// A toast's Undo goes with the undo entry it answers (P2-12): used up by Ctrl+Z or by another
// toast, or pushed out of the stack, it would otherwise stay on screen with an Undo that does
// nothing.
useExpenseStore.subscribe(
  (s) => s.undoStack,
  (stack, prev) => {
    const live = new Set(stack.map((u) => u.id))
    const gone = new Set(prev.filter((u) => !live.has(u.id)).map((u) => u.id))
    if (gone.size === 0) return
    const ui = useUIStore.getState()
    for (const t of ui.toasts) {
      if (t.undoId !== undefined && gone.has(t.undoId)) ui.dismissToast(t.id)
    }
  },
)

// P2-11: a currency picked in Settings is the synced register once the engine runs.
setCurrencyWriter((code) => {
  if (engine === null || !useExpenseStore.getState().hydrated) return false
  engine.setCurrency(code)
  return true
})
