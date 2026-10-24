// A v0.8.4 device for the sync suites: its sync loop and merge ported from the shipped code
// (git 809140e), on the fake relay, with no SDK and no store of its own. What it does that
// v0.8.5 must live with:
// - every realtime event, its own echo included, starts a cycle that always pushes (F-002);
//   a trigger while a cycle runs joins that cycle and is lost;
// - it merges a snapshot taken before the pull, so its own writes during a pull are lost
//   (F-001), and it keeps its own copy on equal stamps and its own item mappings;
// - edits are stamped with its raw clock, and on every sync it re-files rows by keyword
//   without a stamp (F-015: here, "towel" in Other goes to Shopping);
// - it pushes only the fields it knows: no `wr`, no `mappingUpdatedAt`, no unknown fields;
// - it keeps at most 1,000 tombstones.
import { DEFAULT_CATEGORIES } from '../constants'
import { isRecord, listOf, recordOf, isNumber, isString } from '../lib/backup'
import { generateId } from '../utils/helpers'
import type { Expense } from '../types'
import { FakeClient, relay, type FakeChannel } from './fakeRelay'

const TABLE = 'sync_buckets'
const TOMBSTONE_CAP = 1000
const PUSH_DEBOUNCE_MS = 3000

export interface LegacyState {
  expenses: Expense[]
  categories: string[]
  categoryMappings: Record<string, string>
  budgets: Record<string, number>
  budgetUpdatedAt: Record<string, string>
  budgetDeletedAt: Record<string, string>
  deletedIds: string[]
}

const ts = (value: string | undefined): number => (value ? new Date(value).getTime() : 0)

/** v0.8.4's keyword re-file, reduced to one rule (enough to tie with an unchanged stamp). */
export function legacyRefile(e: Expense): Expense {
  return e.category === 'Other' && e.itemName.toLowerCase().includes('towel')
    ? { ...e, category: 'Shopping' }
    : e
}

/** v0.8.4's `mergeBackups` (local wins ties and mapping conflicts), on readable rows. */
export function legacyMerge(local: LegacyState, remote: LegacyState): LegacyState {
  const localMap = new Map(local.expenses.map((e) => [e.id, e]))
  const remoteMap = new Map(remote.expenses.map((e) => [e.id, e]))
  const tombstones = new Set([...local.deletedIds, ...remote.deletedIds])
  const merged: Expense[] = []
  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
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
    merged.push(ts(l.updatedAt ?? l.createdAt) >= ts(r.updatedAt ?? r.createdAt) ? l : r)
  }
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const categories = [...new Set([...local.categories, ...remote.categories])]
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES)

  const budgets: Record<string, number> = {}
  const budgetUpdatedAt: Record<string, string> = {}
  const budgetDeletedAt: Record<string, string> = {}
  const keys = new Set([
    ...Object.keys(local.budgets),
    ...Object.keys(remote.budgets),
    ...Object.keys(local.budgetUpdatedAt),
    ...Object.keys(remote.budgetUpdatedAt),
    ...Object.keys(local.budgetDeletedAt),
    ...Object.keys(remote.budgetDeletedAt),
  ])
  for (const key of keys) {
    const lSet = ts(local.budgetUpdatedAt[key])
    const rSet = ts(remote.budgetUpdatedAt[key])
    const lDel = ts(local.budgetDeletedAt[key])
    const rDel = ts(remote.budgetDeletedAt[key])
    const del = Math.max(lDel, rDel)
    const setAt = Math.max(lSet, rSet)
    if (del > 0 && del >= setAt) {
      const src = lDel >= rDel ? local : remote
      const at = src.budgetDeletedAt[key]
      if (at) budgetDeletedAt[key] = at
      continue
    }
    if (setAt > 0) {
      const src = lSet >= rSet ? local : remote
      const value = src.budgets[key]
      if (value !== undefined) budgets[key] = value
      const at = src.budgetUpdatedAt[key]
      if (at) budgetUpdatedAt[key] = at
      continue
    }
    const value = local.budgets[key] ?? remote.budgets[key]
    if (value !== undefined) budgets[key] = value
  }

  return {
    expenses: merged,
    categories,
    categoryMappings: { ...remote.categoryMappings, ...local.categoryMappings },
    budgets,
    budgetUpdatedAt,
    budgetDeletedAt,
    deletedIds: [...tombstones].slice(-TOMBSTONE_CAP),
  }
}

const isExpense = (row: unknown): row is Expense =>
  isRecord(row) &&
  typeof row.id === 'string' &&
  typeof row.itemName === 'string' &&
  typeof row.amount === 'number' &&
  typeof row.category === 'string' &&
  typeof row.date === 'string'

/** A pulled payload as v0.8.4 would hold it (it did no validation; here unreadable rows drop). */
function readPayload(raw: unknown): LegacyState | null {
  if (!isRecord(raw) || !Array.isArray(raw.expenses)) return null
  const rows: readonly unknown[] = raw.expenses
  return {
    expenses: rows.filter(isExpense),
    categories: listOf(raw.categories, isString),
    categoryMappings: recordOf(raw.categoryMappings, isString),
    budgets: recordOf(raw.budgets, isNumber),
    budgetUpdatedAt: recordOf(raw.budgetUpdatedAt, isString),
    budgetDeletedAt: recordOf(raw.budgetDeletedAt, isString),
    deletedIds: listOf(raw.deletedIds, isString),
  }
}

export class LegacyPeer {
  state: LegacyState
  readonly client = new FakeClient()
  private code: string | null = null
  private channel: FakeChannel | null = null
  private inFlight: Promise<void> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  /** Called after every write this device makes to its own state (for the test's history). */
  onWrite: ((before: LegacyState, after: LegacyState, op: string) => void) | null = null

  constructor(expenses: Expense[], categories = ['Other', 'Meals']) {
    this.state = {
      expenses,
      categories,
      categoryMappings: {},
      budgets: {},
      budgetUpdatedAt: {},
      budgetDeletedAt: {},
      deletedIds: [],
    }
  }

  connect(code: string): void {
    this.code = code
    void this.triggerSync().then(() => {
      if (this.code !== code) return
      const channel = this.client.channel(`sync:${code}`)
      channel.on('postgres_changes', { filter: `sync_id=eq.${code}` }, () => {
        void this.triggerSync()
      })
      channel.subscribe()
      this.channel = channel
    })
  }

  disconnect(): void {
    this.code = null
    if (this.channel) void this.client.removeChannel(this.channel)
    this.channel = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pushTimer = null
    this.retryTimer = null
  }

  private write(next: LegacyState, op: string): void {
    const before = this.state
    this.state = next
    this.onWrite?.(before, next, op)
    this.scheduleSyncPush()
  }

  add(itemName: string, amount: number, category?: string): Expense {
    const now = new Date().toISOString()
    const picked = category ?? this.state.categoryMappings[itemName.toLowerCase().trim()] ?? 'Other'
    const e: Expense = {
      id: generateId(),
      itemName,
      amount,
      category: picked,
      date: now,
      createdAt: now,
    }
    const key = itemName.toLowerCase().trim()
    this.write(
      {
        ...this.state,
        expenses: [e, ...this.state.expenses],
        categoryMappings:
          picked !== 'Other' && key
            ? { ...this.state.categoryMappings, [key]: picked }
            : this.state.categoryMappings,
      },
      `add ${itemName}`,
    )
    return e
  }

  edit(id: string, patch: Partial<Expense>): void {
    this.write(
      {
        ...this.state,
        expenses: this.state.expenses.map((e) =>
          e.id === id ? { ...e, ...patch, updatedAt: new Date().toISOString() } : e,
        ),
      },
      `edit ${id}`,
    )
  }

  remove(id: string): void {
    this.write(
      {
        ...this.state,
        expenses: this.state.expenses.filter((e) => e.id !== id),
        deletedIds: [...new Set([...this.state.deletedIds, id])].slice(-TOMBSTONE_CAP),
      },
      `delete ${id}`,
    )
  }

  private scheduleSyncPush(): void {
    if (this.code === null) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.triggerSync()
    }, PUSH_DEBOUNCE_MS)
  }

  triggerSync(): Promise<void> {
    const code = this.code
    if (code === null) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const run = async () => {
      try {
        const local = this.state
        const pulled = await this.client
          .from(TABLE)
          .select('payload')
          .eq('sync_id', code)
          .maybeSingle()
        if (pulled.error) throw new Error(pulled.error.message)
        const row: unknown = pulled.data
        const remote = isRecord(row) ? readPayload(row.payload) : null
        const merged = remote ? legacyMerge(local, remote) : local
        const before = this.state
        this.state = merged // F-001: writes made during the pull are gone
        this.onWrite?.(before, merged, 'merge')
        // applySync re-files by keyword on every apply (F-015), without a stamp.
        const refiled = { ...merged, expenses: merged.expenses.map(legacyRefile) }
        this.state = refiled
        this.onWrite?.(merged, refiled, 'refile')
        const pushed = await this.client.from(TABLE).upsert({
          sync_id: code,
          payload: { ...refiled, exportDate: new Date().toISOString(), version: '4.0' },
          updated_at: new Date().toISOString(),
        })
        if (pushed.error) throw new Error(pushed.error.message)
        this.retryAttempt = 0
      } catch {
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryAttempt = Math.min(this.retryAttempt + 1, 8)
        this.retryTimer = setTimeout(
          () => {
            this.retryTimer = null
            void this.triggerSync()
          },
          Math.min(120_000, 1500 * 2 ** this.retryAttempt),
        )
      } finally {
        this.inFlight = null
      }
    }
    this.inFlight = run()
    return this.inFlight
  }

  /** How many pushes this device has landed on the relay. */
  pushes(): number {
    return relay().pushes.filter((p) => p.client === this.client.id).length
  }
}
