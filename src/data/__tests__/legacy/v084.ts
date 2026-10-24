// FROZEN: never edit. Model of the shipped v0.8.4 client.
//
// Verbatim logic from the files at 809140e (code identical to v0.8.4 623a76a):
//   src/types.ts:1-71                     Expense, BackupData, …
//   src/constants.ts:3-21, 24-143, 148-149 DEFAULT_CATEGORIES, CATEGORY_MIGRATIONS, ITEM_CATEGORY_PATTERNS, FUSE_*
//   src/utils/helpers.ts:5-7, 41-61       generateId, migrateExpenseCategory, migrateExpenses
//   src/lib/backup.ts:1-100                parseBackup and its guards
//   src/services/syncService.ts:19, 57-223 TOMBSTONE_CAP, ts, mergeBackups, PayloadTooLargeError, push/pull
//   src/services/storage.ts:1-216          getters/setters, trailing-comma repair, removeItem on failure, safeSet
//   src/stores/useExpenseStore.ts:17-490   store reducers, undo closures, persistence (400 ms debounce)
//   src/stores/useSyncStore.ts:27-189      triggerSync (F-001 shape), 3 s push debounce, retry backoff
//   src/app/AppShell.tsx:40-58             data change → scheduleSyncPush unless syncApplying
// Permitted deviations, each marked FROZEN-DEVIATION: injected clock (Date.now / new Date() and
// the setTimeout/clearTimeout it drives), injected rng (Math.random in generateId), injected storage
// (localStorage), plus the relay port that replaces the Supabase client. The demo branch of hydrate
// is statically dead on the owner's (non-demo) build and is not modelled. Casts that exist in the
// shipped code are kept and marked FROZEN-VERBATIM.
import Fuse from 'fuse.js'
import { isValid, parseISO } from 'date-fns'

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
export type CategoryMappings = Record<string, string>
export type CategoryBudgets = Record<string, number>
export type CategoryBudgetTimestamps = Record<string, string>
export interface BackupData {
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  budgets?: CategoryBudgets
  budgetUpdatedAt?: CategoryBudgetTimestamps
  budgetDeletedAt?: CategoryBudgetTimestamps
  deletedIds?: string[]
  exportDate: string
  version: string
}
export interface ItemCategoryPattern {
  category: string
  fromCategories: string[]
  keywords: string[]
}

// ── injected ports (FROZEN-DEVIATION) ───────────────────────────────────────────────────────
/** The clock and the timers it drives (virtual time in the simulation). */
export interface ClockPort {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
}
/** localStorage. */
export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
/** The Supabase relay row (upsert / select / postgres_changes), replacing the SDK client. */
export interface RelayPort {
  pull(syncId: string): Promise<{ payload: unknown } | null>
  push(syncId: string, payload: unknown): Promise<void>
  subscribe(syncId: string, onUpdate: () => void): () => void
}

// ── src/constants.ts ────────────────────────────────────────────────────────────────────────
export const DEFAULT_CATEGORIES: string[] = [
  'Food & Dining',
  'Gaming',
  'Social & Leisure',
  'Transportation',
  'Shopping',
  'Healthcare',
  'Grooming',
  'Subscriptions',
  'Investment',
  'Travel',
  'Other',
]
export const CATEGORY_MIGRATIONS: Record<string, string> = {
  'Bills & Utilities': 'Travel',
  Education: 'Subscriptions',
}
export const ITEM_CATEGORY_PATTERNS: ItemCategoryPattern[] = [
  {
    category: 'Gaming',
    fromCategories: ['Entertainment', 'Social & Leisure'],
    keywords: [
      'valorant',
      'call of duty',
      'cod',
      'fortnite',
      'fnfn',
      'nintendo',
      'ps4',
      'ps5',
      'ps3',
      'playstation',
      'xbox',
      'steam',
      'csgo',
      'warzone',
      'game',
      'gaming',
      'minecraft',
      'roblox',
      'league of legends',
      'lol',
      'overwatch',
      'apex',
      'battlefield',
      'fifa',
      'ea fc',
    ],
  },
  {
    category: 'Subscriptions',
    fromCategories: ['Entertainment', 'Education', 'Other', 'Investment'],
    keywords: [
      'disney+',
      'disney plus',
      'netflix',
      'spotify',
      'youtube premium',
      'apple tv',
      'hbo',
      'prime video',
      'chatgpt',
      'claude',
      'deepstash',
      'tradezella',
      'kimi ai',
      'kimi',
      'google storage',
      'google one',
      'icloud',
      'apple storage',
      'notion',
      'github',
      'figma',
      'canva',
    ],
  },
  {
    category: 'Grooming',
    fromCategories: ['Other', 'Healthcare'],
    keywords: [
      'haircut',
      'hair cut',
      'barber',
      'hairdresser',
      'hair salon',
      'trim',
      'shave',
      'wax',
      'nails',
      'nail salon',
      'manicure',
      'pedicure',
    ],
  },
  {
    category: 'Social & Leisure',
    fromCategories: ['Entertainment', 'Other'],
    keywords: [
      'pool',
      'billiard',
      'bowling',
      'club',
      'clubbing',
      'bar ',
      'alcohol',
      'gambling',
      'casino',
      'nights out',
      'night out',
      'pub',
      'drinks',
      'beer',
      'wine',
      'cocktail',
      'nightclub',
    ],
  },
  {
    category: 'Shopping',
    fromCategories: ['Other'],
    keywords: ['jersey', 'uniform', 'kit', 'gear'],
  },
  {
    category: 'Travel',
    fromCategories: ['Bills & Utilities', 'Other', 'Travel'],
    keywords: [
      'euro exchange',
      'exchange rate',
      'currency exchange',
      'youtrip',
      'esim',
      'e-sim',
      'travel card',
    ],
  },
]
export const FUSE_THRESHOLD = 0.3
export const FUSE_SCORE_CUTOFF = 0.4

// ── src/utils/helpers.ts ────────────────────────────────────────────────────────────────────
export const makeGenerateId = (clock: ClockPort, rng: () => number) => (): string => {
  // FROZEN-DEVIATION: Date.now() and Math.random() are injected.
  return clock.now().toString(36) + rng().toString(36).slice(2)
}

export const migrateExpenseCategory = (expense: Expense): Expense => {
  const flatMigrated = CATEGORY_MIGRATIONS[expense.category] ?? expense.category
  const nameLower = (expense.itemName || '').toLowerCase()

  for (const rule of ITEM_CATEGORY_PATTERNS) {
    if (
      !rule.fromCategories.includes(flatMigrated) &&
      !rule.fromCategories.includes(expense.category)
    ) {
      continue
    }
    if (rule.keywords.some((kw) => nameLower.includes(kw))) {
      return { ...expense, category: rule.category }
    }
  }

  return flatMigrated !== expense.category ? { ...expense, category: flatMigrated } : expense
}

export const migrateExpenses = (expenses: Expense[]): Expense[] =>
  expenses.map(migrateExpenseCategory)

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
  const out: Record<string, T> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isEntry(entry)) out[key] = entry
  }
  return out
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
    budgets: recordOf(raw.budgets, isNumber),
    budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
    budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
    deletedIds: listOf(raw.deletedIds, isString),
    // FROZEN-DEVIATION: new Date() is injected.
    exportDate:
      typeof raw.exportDate === 'string' ? raw.exportDate : new Date(clock.now()).toISOString(),
    version: typeof raw.version === 'string' ? raw.version : '4.0',
  }
}

// ── src/services/syncService.ts ─────────────────────────────────────────────────────────────
const PAYLOAD_WARN_BYTES = 800 * 1024
export const TOMBSTONE_CAP = 1000

function ts(value: string | undefined): number {
  return value ? new Date(value).getTime() : 0
}

export function mergeBackups(local: BackupData, remote: BackupData, clock: ClockPort): BackupData {
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
    merged.push(lTime >= rTime ? l : r)
  }

  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const categories = [...new Set([...local.categories, ...remote.categories])]
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES)

  const categoryMappings = { ...remote.categoryMappings, ...local.categoryMappings }

  const allBudgetKeys = new Set<string>([
    ...Object.keys(local.budgets ?? {}),
    ...Object.keys(remote.budgets ?? {}),
    ...Object.keys(local.budgetUpdatedAt ?? {}),
    ...Object.keys(remote.budgetUpdatedAt ?? {}),
    ...Object.keys(local.budgetDeletedAt ?? {}),
    ...Object.keys(remote.budgetDeletedAt ?? {}),
  ])

  const mergedBudgets: Record<string, number> = {}
  const mergedBudgetUpdatedAt: Record<string, string> = {}
  const mergedBudgetDeletedAt: Record<string, string> = {}

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

    if (local.budgets?.[key] !== undefined) {
      mergedBudgets[key] = local.budgets[key]
    } else if (remote.budgets?.[key] !== undefined) {
      mergedBudgets[key] = remote.budgets[key]
    }
  }

  const cappedTombstones = [...tombstones].slice(-TOMBSTONE_CAP)

  return {
    expenses: merged,
    categories,
    categoryMappings,
    budgets: mergedBudgets,
    budgetUpdatedAt: mergedBudgetUpdatedAt,
    budgetDeletedAt: mergedBudgetDeletedAt,
    deletedIds: cappedTombstones,
    // FROZEN-DEVIATION: new Date() is injected.
    exportDate: new Date(clock.now()).toISOString(),
    version: '4.0',
  }
}

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`Sync payload is ${(bytes / 1024).toFixed(0)} KB — too large to safely sync.`)
  }
}

export async function pushSync(relay: RelayPort, syncId: string, data: BackupData): Promise<void> {
  const serialized = JSON.stringify(data)
  if (serialized.length > PAYLOAD_WARN_BYTES) {
    if (serialized.length > 1024 * 1024) throw new PayloadTooLargeError(serialized.length)
  }
  await relay.push(syncId, data)
}

export async function pullSync(relay: RelayPort, syncId: string): Promise<BackupData | null> {
  const data = await relay.pull(syncId)
  // FROZEN-VERBATIM: the shipped pull trusts the payload (F-005, F-006).
  return data ? (data.payload as BackupData) : null
}

// ── src/services/storage.ts ─────────────────────────────────────────────────────────────────
const KEY_EXPENSES = 'expenses'
const KEY_CATEGORIES = 'categories'
const KEY_MAPPINGS = 'categoryMappings'
const KEY_BUDGETS = 'categoryBudgets'
const KEY_BUDGET_UPDATED_AT = 'categoryBudgetUpdatedAt'
const KEY_BUDGET_DELETED_AT = 'categoryBudgetDeletedAt'
const KEY_DELETED_IDS = 'deletedExpenseIds'
const KEY_SYNC_ID = 'syncId'

export class StorageQuotaError extends Error {
  constructor(
    public key: string,
    public bytes: number,
  ) {
    super(`localStorage quota exceeded while writing "${key}" (${bytes} bytes).`)
    this.name = 'StorageQuotaError'
  }
}

export function makeStorage(localStorage: StoragePort) {
  function safeSet(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch (err) {
      const isQuota =
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      if (isQuota) {
        throw new StorageQuotaError(key, value.length)
      }
      throw err
    }
  }

  return {
    getExpenses(): Expense[] {
      try {
        const raw = localStorage.getItem(KEY_EXPENSES)
        if (!raw) return []
        const parsed: unknown = JSON.parse(raw)
        // FROZEN-VERBATIM: rows are trusted as Expense[] (F-005, F-014).
        if (Array.isArray(parsed)) return parsed as Expense[]
      } catch {
        try {
          const raw = localStorage.getItem(KEY_EXPENSES)
          if (raw) {
            const repaired = raw.replace(/,(\s*[}\]])/g, '$1')
            const parsed: unknown = JSON.parse(repaired)
            // FROZEN-VERBATIM
            if (Array.isArray(parsed)) return parsed as Expense[]
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
        const parsed: unknown = JSON.parse(raw)
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
    ): void {
      this.saveExpenses(expenses)
      this.saveCategories(categories)
      this.saveCategoryMappings(mappings)
      if (budgets !== undefined) this.saveBudgets(budgets)
      if (budgetUpdatedAt !== undefined) this.saveBudgetUpdatedAt(budgetUpdatedAt)
      if (budgetDeletedAt !== undefined) this.saveBudgetDeletedAt(budgetDeletedAt)
      if (deletedIds !== undefined) this.saveDeletedIds(deletedIds)
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
export type V084Storage = ReturnType<typeof makeStorage>

// ── src/stores/useExpenseStore.ts + useSyncStore.ts + AppShell wiring ───────────────────────
const LEGACY_BUDGET_UPDATED_AT = '1970-01-01T00:00:00.000Z'

interface UndoEntry {
  id: string
  label: string
  expiresAt: number
  undo: () => void
}

export interface V084State {
  expenses: Expense[]
  categories: string[]
  categoryMappings: CategoryMappings
  budgets: CategoryBudgets
  budgetUpdatedAt: CategoryBudgetTimestamps
  budgetDeletedAt: CategoryBudgetTimestamps
  deletedIds: string[]
  hydrated: boolean
  undoStack: UndoEntry[]
}

function completeBudgetUpdatedAt(
  budgets: CategoryBudgets,
  existing: CategoryBudgetTimestamps | undefined,
  fallback: string,
): CategoryBudgetTimestamps {
  return Object.fromEntries(
    Object.keys(budgets).map((category) => [category, existing?.[category] ?? fallback]),
  )
}

const PUSH_DEBOUNCE_MS = 3000
const MAX_RETRY_DELAY_MS = 2 * 60 * 1000
const PERSIST_DEBOUNCE_MS = 400

export class V084Client {
  s: V084State = {
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
  syncId: string | null = null
  cloudStatus: 'idle' | 'syncing' | 'synced' | 'error' = 'idle'
  syncApplying = false
  pushes = 0
  private inFlight: Promise<void> | null = null
  private pushTimer: number | null = null
  private retryTimer: number | null = null
  private retryAttempt = 0
  private saveTimer: number | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    readonly clock: ClockPort,
    rng: () => number,
    localStorage: StoragePort,
    readonly relay: RelayPort,
  ) {
    this.storage = makeStorage(localStorage)
    this.generateId = makeGenerateId(clock, rng)
  }

  /** zustand `set` plus the two subscribers: persistence (400 ms) and AppShell → push. */
  private set(update: Partial<V084State> | ((s: V084State) => Partial<V084State>)): void {
    const prev = this.s
    const partial = typeof update === 'function' ? update(prev) : update
    const next = { ...prev, ...partial }
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
  }

  /** pagehide / beforeunload flush. */
  flushPendingSave(): void {
    if (this.saveTimer === null || !this.s.hydrated) return
    this.clock.clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.persistCurrentState()
  }

  hydrate(): void {
    try {
      const expenses = migrateExpenses(this.storage.getExpenses())
      const categories = this.storage.getCategories() ?? DEFAULT_CATEGORIES
      const categoryMappings = this.storage.getCategoryMappings()
      const budgets = this.storage.getBudgets()
      const budgetUpdatedAt = completeBudgetUpdatedAt(
        budgets,
        this.storage.getBudgetUpdatedAt(),
        LEGACY_BUDGET_UPDATED_AT,
      )
      const budgetDeletedAt = this.storage.getBudgetDeletedAt()
      const deletedIds = this.storage.getDeletedIds()
      this.set({
        expenses,
        categories,
        categoryMappings,
        budgets,
        budgetUpdatedAt,
        budgetDeletedAt,
        deletedIds,
        hydrated: true,
      })
    } catch {
      this.set({ hydrated: true })
    }
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

  addExpense(input: Partial<Expense> & { itemName: string; amount: number }): Expense {
    const amount = input.amount
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a finite number greater than 0.')
    }
    const itemName = input.itemName.trim()
    if (!itemName) throw new Error('Item name is required.')
    const smart = this.getSmartCategory(itemName)
    const category = input.category || smart || 'Other'
    // FROZEN-DEVIATION: new Date() is injected.
    const now = new Date(this.clock.now()).toISOString()
    const expense: Expense = {
      id: this.generateId(),
      itemName,
      amount,
      category,
      date: input.date || now,
      notes: input.notes,
      createdAt: now,
    }
    this.set((s) => {
      const normalized = expense.itemName.toLowerCase().trim()
      const nextMappings =
        category !== 'Other' && normalized
          ? { ...s.categoryMappings, [normalized]: category }
          : s.categoryMappings
      const undo: UndoEntry = {
        id: `add-${expense.id}`,
        label: `Added "${expense.itemName}"`,
        expiresAt: this.clock.now() + 5000,
        undo: () => {
          this.set((st) => ({
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
  }

  updateExpense(id: string, patch: Partial<Expense>): void {
    const prev = this.s.expenses.find((e) => e.id === id)
    if (!prev) return
    this.set((s) => ({
      expenses: s.expenses.map((e) =>
        e.id === id ? { ...e, ...patch, updatedAt: new Date(this.clock.now()).toISOString() } : e,
      ),
      undoStack: [
        ...s.undoStack,
        {
          id: `update-${id}-${this.clock.now()}`,
          label: 'Updated expense',
          expiresAt: this.clock.now() + 5000,
          undo: () => {
            this.set((st) => ({ expenses: st.expenses.map((e) => (e.id === id ? prev : e)) }))
          },
        },
      ].slice(-5),
    }))
  }

  deleteExpense(id: string): void {
    const prev = this.s.expenses.find((e) => e.id === id)
    if (!prev) return
    this.set((s) => ({
      expenses: s.expenses.filter((e) => e.id !== id),
      deletedIds: [...new Set([...s.deletedIds, id])],
      undoStack: [
        ...s.undoStack,
        {
          id: `del-${id}-${this.clock.now()}`,
          label: `Deleted "${prev.itemName}"`,
          expiresAt: this.clock.now() + 5000,
          undo: () => {
            this.set((st) => ({
              expenses: [prev, ...st.expenses],
              deletedIds: st.deletedIds.filter((d) => d !== id),
            }))
          },
        },
      ].slice(-5),
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

  renameCategory(from: string, to: string): void {
    const target = to.trim()
    if (!target || from === target) return
    const existing = this.s.categories
    const targetExists = existing.includes(target)
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
              [target]:
                s.budgetUpdatedAt[target] ??
                s.budgetUpdatedAt[from] ??
                new Date(this.clock.now()).toISOString(),
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
    const now = new Date(this.clock.now()).toISOString()
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
    this.set((s) => ({
      budgets: { ...s.budgets, [category]: amount },
      budgetUpdatedAt: {
        ...s.budgetUpdatedAt,
        [category]: new Date(this.clock.now()).toISOString(),
      },
      budgetDeletedAt: Object.fromEntries(
        Object.entries(s.budgetDeletedAt).filter(([k]) => k !== category),
      ),
    }))
  }

  removeBudget(category: string): void {
    this.set((s) => ({
      budgets: Object.fromEntries(Object.entries(s.budgets).filter(([k]) => k !== category)),
      budgetUpdatedAt: Object.fromEntries(
        Object.entries(s.budgetUpdatedAt).filter(([k]) => k !== category),
      ),
      budgetDeletedAt: {
        ...s.budgetDeletedAt,
        [category]: new Date(this.clock.now()).toISOString(),
      },
    }))
  }

  importBackup(data: BackupData): void {
    this.set({
      expenses: migrateExpenses(data.expenses),
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
      exportDate: new Date(this.clock.now()).toISOString(),
      version: '4.0',
    }
  }

  applySync(data: BackupData): void {
    this.set({
      expenses: migrateExpenses(data.expenses),
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

  consumeUndo(id: string): void {
    const now = this.clock.now()
    const entry = this.s.undoStack.find((u) => u.id === id)
    if (!entry || entry.expiresAt < now) {
      this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
      return
    }
    entry.undo()
    this.set((s) => ({ undoStack: s.undoStack.filter((u) => u.expiresAt >= now && u.id !== id) }))
  }

  // ── useSyncStore ──────────────────────────────────────────────────────────────────────────

  setupSync(syncId: string): Promise<void> {
    this.storage.saveSyncId(syncId)
    this.syncId = syncId
    if (this.unsubscribe) this.unsubscribe()
    return this.triggerSync().then(() => {
      this.unsubscribe = this.relay.subscribe(syncId, () => {
        this.triggerSync().catch(() => undefined)
      })
    })
  }

  triggerSync(): Promise<void> {
    const syncId = this.syncId
    if (!syncId) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.cloudStatus = 'syncing'
    this.inFlight = (async () => {
      try {
        const local = this.exportBackup()
        const remote = await pullSync(this.relay, syncId)
        const merged = remote ? mergeBackups(local, remote, this.clock) : local
        this.syncApplying = true
        try {
          this.applySync(merged)
        } finally {
          this.syncApplying = false
        }
        await pushSync(this.relay, syncId, merged)
        this.pushes++
        this.cloudStatus = 'synced'
        this.retryAttempt = 0
      } catch {
        this.syncApplying = false
        this.cloudStatus = 'error'
        this.scheduleRetry()
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  scheduleSyncPush(): void {
    if (!this.syncId) return
    if (this.pushTimer !== null) this.clock.clearTimeout(this.pushTimer)
    this.pushTimer = this.clock.setTimeout(() => {
      this.pushTimer = null
      this.triggerSync().catch(() => undefined)
    }, PUSH_DEBOUNCE_MS)
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryAttempt = Math.min(this.retryAttempt + 1, 8)
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1500 * Math.pow(2, this.retryAttempt))
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null
      this.triggerSync().catch(() => undefined)
    }, delay)
  }

  /** Stops every timer and the realtime subscription (the tab closes). */
  close(): void {
    for (const h of [this.pushTimer, this.retryTimer, this.saveTimer]) {
      if (h !== null) this.clock.clearTimeout(h)
    }
    this.pushTimer = null
    this.retryTimer = null
    this.saveTimer = null
    if (this.unsubscribe) this.unsubscribe()
    this.unsubscribe = null
  }
}
