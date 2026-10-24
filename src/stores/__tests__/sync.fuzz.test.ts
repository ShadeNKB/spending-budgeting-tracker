// The adversarial two-device fuzz (contract §16.4, as cut for PR-0), seeded, on virtual time,
// over one fake relay. Two v0.8.5 devices (and, in the last suite, a v0.8.4 device) take random
// adds, field edits, deletes, undos, category adds, renames and removals, item-mapping picks and
// budget changes, while the world does its worst: shared offline windows and hide/show, one
// device losing its network (and its realtime socket), Disconnect and reconnect, failed and hung
// requests, slow uploads, clocks a day off, a full localStorage, and a hostile writer that
// injects unreadable rows, far-future stamps and damaged collections into the relay copy.
//
// After the dust settles the oracle demands:
// - convergence: both devices and the relay's readable content are equal by content, and the
//   hostile writer's unreadable rows are still on the relay, untouched;
// - no lost add and no resurrection;
// - no reverted write: every write (record, item mapping, budget) is either part of the final
//   value's history, or lost to a write the OTHER device made without having seen it. That is
//   whole-record last-writer-wins: the only allowed loss is a concurrent edit of the same record
//   (or mapping, or budget), the documented v4 limit. A single device's edits, renames and
//   mapping corrections are never reverted, and nothing the hostile writer sent survives;
// - every row's category, every mapping's category and every budget's name is in the list, and
//   the list invents no name (it is a union: removed names may come back, the documented limit);
// - quiet: zero pushes in 10 idle minutes, and a bounded number of pushes per change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { isRecord, isString, listOf } from '../../lib/backup'
import { canon, canonRow } from '../../lib/canon'
import { contentKey, readRemote } from '../../services/syncService'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  failNext,
  relay,
  resetRelay,
  retireDevices,
  rowPayload,
  setClientOffline,
  stubRelayEnv,
  writeAsOther,
  type Device,
  type Failure,
} from '../../__tests__/fakeRelay'
import { LegacyPeer, type LegacyState } from '../../__tests__/legacyPeer'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 120_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const FIELDS = ['amount', 'notes', 'itemName', 'category', 'date'] as const
const NAME_POOL = ['Gym', 'Pets', 'Travel', 'Kids', 'Fees', 'Dining', 'Meals', 'Transport']
const ITEMS = ['grab', 'coffee', 'rent', 'gym pass', 'vet', 'kitchen towel']
const HOSTILE_AMOUNT = 999_999
// The hostile writer budgets a category it never lists. "__proto__" is a plain key like any
// other (read as an own key, so every device holds it alike), and an unlisted one.
const HOSTILE_BUDGET = '__proto__'

/** mulberry32: a small seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

let quotaFull = false

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  quotaFull = false
  const setItem = Storage.prototype.setItem.bind(localStorage)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
    if (quotaFull) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    setItem(key, value)
  })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  quotaFull = false
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

function setOnline(online: boolean, dropSocket: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
  if (dropSocket) dropRealtime(!online)
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

async function hideAndShow(ms: number): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  await advance(ms)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Runs `write` on a device whose clock is `skew` ms off: its stamps carry the skew. */
function withClock<T>(skew: number, write: () => T): T {
  if (skew === 0) return write()
  const now = Date.now()
  vi.setSystemTime(now + skew)
  try {
    return write()
  } finally {
    vi.setSystemTime(now)
  }
}

/** Pushes by v0.8.5 clients (they carry `wr`). */
const ourPushes = () =>
  relay().pushes.filter((p) => isRecord(p.payload) && isRecord(p.payload.wr)).length

// ---------------------------------------------------------------------------
// The oracle: every write is a version of a register with the version it replaced
// ---------------------------------------------------------------------------

type Author = 'A' | 'B' | 'L'

interface Version {
  value: string
  parent: string | null
  author: Author
  t: number
  op: string
}

interface SyncedState {
  expenses: readonly unknown[]
  categories: readonly string[]
  categoryMappings: Readonly<Record<string, string>>
  mappingUpdatedAt?: Readonly<Record<string, string>>
  budgets: Readonly<Record<string, number>>
  budgetUpdatedAt: Readonly<Record<string, string>>
  budgetDeletedAt: Readonly<Record<string, string>>
  deletedIds: readonly string[]
}

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

/** Rows, item mappings and budgets as registers (name → canonical value). */
function registers(s: SyncedState): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of s.expenses) {
    if (isRecord(row) && typeof row.id === 'string') out.set(`row:${row.id}`, canonRow(row))
  }
  for (const [key, value] of Object.entries(s.categoryMappings)) {
    out.set(`map:${key}`, canon({ v: value, t: own(s.mappingUpdatedAt, key) ?? null }))
  }
  const budgetKeys = new Set([
    ...Object.keys(s.budgets),
    ...Object.keys(s.budgetUpdatedAt),
    ...Object.keys(s.budgetDeletedAt),
  ])
  for (const key of budgetKeys) {
    out.set(
      `budget:${key}`,
      canon({
        v: own(s.budgets, key) ?? null,
        s: own(s.budgetUpdatedAt, key) ?? null,
        d: own(s.budgetDeletedAt, key) ?? null,
      }),
    )
  }
  return out
}

const rowIds = (s: SyncedState): Set<string> =>
  new Set(
    s.expenses.flatMap((row) => (isRecord(row) && typeof row.id === 'string' ? [row.id] : [])),
  )

class History {
  private readonly versions = new Map<string, Map<string, Version>>()
  /** Row ids added (an add, or an undone delete), with the device that added each. */
  readonly added = new Map<string, Author>()
  /** Row ids deleted (a delete, or an undone add), with the device that deleted each. */
  readonly deleted = new Map<string, Author>()
  readonly everListed = new Set<string>()
  changes = 0
  /** When each device first held each register value (`reg` + newline + value). */
  private readonly seenAt = new Map<Author, Map<string, number>>()

  /** Notes every value `author` holds now (sampled between steps and around every write). */
  observe(author: Author, state: SyncedState): void {
    const seen = this.seenAt.get(author) ?? new Map<string, number>()
    for (const [reg, value] of registers(state)) {
      const key = `${reg}\n${value}`
      if (!seen.has(key)) seen.set(key, Date.now())
    }
    this.seenAt.set(author, seen)
  }

  /** Records what one write of `author` changed, from `before` to `after`. */
  write(author: Author, before: SyncedState, after: SyncedState, op: string): void {
    this.observe(author, before)
    this.observe(author, after)
    const a = registers(before)
    const b = registers(after)
    let changed = false
    for (const [reg, value] of b) {
      const prev = a.get(reg) ?? null
      if (prev === value) continue
      changed = true
      const list = this.versions.get(reg) ?? new Map<string, Version>()
      if (!list.has(value)) list.set(value, { value, parent: prev, author, t: Date.now(), op })
      this.versions.set(reg, list)
    }
    const beforeIds = rowIds(before)
    const afterIds = rowIds(after)
    for (const id of afterIds) if (!beforeIds.has(id)) this.added.set(id, author)
    for (const id of beforeIds) {
      if (!afterIds.has(id)) {
        this.deleted.set(id, author)
        changed = true
      }
    }
    for (const name of after.categories) this.everListed.add(name)
    if (changed || canon([...before.categories].sort()) !== canon([...after.categories].sort())) {
      this.changes++
    }
  }

  private chain(reg: string, value: string | null): Version[] {
    const out: Version[] = []
    const seen = new Set<string>()
    let cur = value
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur)
      const v = this.versions.get(reg)?.get(cur)
      if (!v) break
      out.push(v)
      cur = v.parent
    }
    return out
  }

  /** Whether `author` had held `w` or a later version built on it before time `t`. */
  private sawBefore(author: Author, reg: string, w: Version, t: number): boolean {
    const seen = this.seenAt.get(author)
    const list = this.versions.get(reg)
    if (!seen || !list) return false
    for (const v of list.values()) {
      const at = seen.get(`${reg}\n${v.value}`)
      if (at === undefined || at >= t) continue
      if (v === w || this.chain(reg, v.value).some((x) => x.value === w.value)) return true
    }
    return false
  }

  /**
   * Checks the final registers against every recorded write. A write that is not in the final
   * value's history is allowed to be lost only to a rival: a write on that history by another
   * device, made before that device had held the lost write (a concurrent edit of the same
   * record, mapping or budget). `checked` limits which authors' writes must survive (a v0.8.4
   * device loses its own writes by itself, F-001).
   */
  check(final: SyncedState, initial: Map<string, string>, checked: ReadonlySet<Author>) {
    const issues: string[] = []
    let concurrentLosses = 0
    const regs = registers(final)
    const finalIds = rowIds(final)
    for (const [reg, list] of this.versions) {
      const id = reg.startsWith('row:') ? reg.slice(4) : null
      if (id !== null && (this.deleted.has(id) || !finalIds.has(id))) continue
      const value = regs.get(reg)
      if (value === undefined) {
        // A register only a v0.8.4 device wrote may be gone with its F-001 losses.
        if ([...list.values()].some((v) => checked.has(v.author))) issues.push(`MISSING ${reg}`)
        continue
      }
      if (!list.has(value) && initial.get(reg) !== value) issues.push(`UNKNOWN ${reg}: ${value}`)
      const finalChain = this.chain(reg, value)
      const inFinal = new Set(finalChain.map((v) => v.value))
      for (const w of list.values()) {
        if (inFinal.has(w.value) || !checked.has(w.author)) continue
        const ancestors = new Set(this.chain(reg, w.value).map((v) => v.value))
        const rival = finalChain.find(
          (v) =>
            v.author !== w.author &&
            !ancestors.has(v.value) &&
            !this.sawBefore(v.author, reg, w, v.t),
        )
        if (rival) {
          concurrentLosses++
          continue
        }
        issues.push(
          `REVERTED ${reg}: ${w.author}@${String(w.t - NOW)} [${w.op}] ${w.value} -> final ${value}`,
        )
      }
    }
    return { issues, concurrentLosses }
  }
}

function listIssues(s: SyncedState, everListed: ReadonlySet<string>): string[] {
  const issues: string[] = []
  const listed = new Set(s.categories)
  const need = new Set<string>()
  for (const row of s.expenses)
    if (isRecord(row) && typeof row.category === 'string') need.add(row.category)
  for (const value of Object.values(s.categoryMappings)) need.add(value)
  for (const key of Object.keys(s.budgets)) if (key !== HOSTILE_BUDGET) need.add(key)
  for (const name of need) if (!listed.has(name)) issues.push(`UNLISTED ${name}`)
  for (const name of listed) if (!everListed.has(name)) issues.push(`INVENTED ${name}`)
  return issues
}

// ---------------------------------------------------------------------------
// Two v0.8.5 devices
// ---------------------------------------------------------------------------

interface Profile {
  name: string
  seeds: number
  from: number
  ops: number
  maxGap: number
  /** A quarter of the pushes take 3–9 s (a slow upload) instead of 0.1–1 s. */
  slowPushes: boolean
  /** Device B's clock runs up to a day off. */
  skew: boolean
  /** Going offline also drops the realtime socket. */
  dropSocket: boolean
}

const PROFILES: Profile[] = [
  {
    name: 'default',
    seeds: 48,
    from: 1,
    ops: 70,
    maxGap: 6000,
    slowPushes: false,
    skew: false,
    dropSocket: false,
  },
  {
    name: 'slow uploads, a skewed clock, sockets that drop',
    seeds: 24,
    from: 1001,
    ops: 60,
    maxGap: 8000,
    slowPushes: true,
    skew: true,
    dropSocket: true,
  },
]

const stateOf = (d: Device): SyncedState => d.expense.useExpenseStore.getState()

/**
 * Rows this version cannot read go back to the relay exactly as they were: every push of a
 * v0.8.5 device carries each such row of the copy its cycle pulled (unless it is tombstoned),
 * byte for byte, and whatever the relay holds of them at the end is unchanged. (A push built on
 * a pull from before such a row arrived can still land over it: its writer re-sends it.)
 */
function passthroughIssues(hostile: ReadonlySet<string>, onRelay: readonly string[]): string[] {
  const issues: string[] = []
  const r = relay()
  for (const push of r.pushes) {
    if (!isRecord(push.payload) || !isRecord(push.payload.wr)) continue
    const pulled = r.pullLog
      .filter((p) => p.client === push.client && p.at <= push.requestedAt)
      .at(-1)
    if (!pulled || !isRecord(pulled.payload) || !Array.isArray(pulled.payload.expenses)) continue
    const dead = new Set(listOf(push.payload.deletedIds, isString))
    const sentRows: readonly unknown[] = Array.isArray(push.payload.expenses)
      ? push.payload.expenses
      : []
    const sent = new Set(sentRows.map(canon))
    const pulledRows: readonly unknown[] = pulled.payload.expenses
    for (const row of pulledRows) {
      const text = canon(row)
      if (!hostile.has(text)) continue
      const id = isRecord(row) && typeof row.id === 'string' ? row.id : null
      if (id !== null && dead.has(id)) continue
      if (!sent.has(text))
        issues.push(`UNREADABLE ROW DROPPED ${text} by client ${String(push.client)}`)
    }
  }
  for (const text of onRelay) {
    if (text.includes('"evil-') && !hostile.has(text)) issues.push(`UNREADABLE ROW CHANGED ${text}`)
  }
  return issues
}

const seedRows = () =>
  ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) =>
    expense(id, { amount: 10, category: i % 2 === 0 ? 'Meals' : 'Other' }),
  )

/** What the relay holds that this version can read, as a device would hold it. */
function relayContent(): { key: string; passthrough: string[] } {
  const read = readRemote(rowPayload(SYNC_CODE))
  if (read.kind !== 'ok') return { key: `relay is ${read.kind}`, passthrough: [] }
  return { key: contentKey(read.data), passthrough: read.passthrough.map(canon).sort() }
}

async function runSeed(profile: Profile, seed: number): Promise<string> {
  const r = rng(seed * 7919 + 13)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
  const devs: Record<'A' | 'B', Device> = {
    A: await bootDevice({ persist: true, storedRows: seedRows() }),
    B: await bootDevice({ persist: true, storedRows: seedRows() }),
  }
  for (const d of Object.values(devs)) {
    d.expense.useExpenseStore.setState({ categories: ['Other', 'Meals'] })
  }
  const skew: Record<'A' | 'B', number> = {
    A: 0,
    B: profile.skew ? (pick([-DAY, DAY, -5 * MINUTE, 5 * MINUTE]) ?? 0) : 0,
  }
  relay().latency = {
    pull: 150 + Math.floor(r() * 300),
    push: 150 + Math.floor(r() * 300),
    realtime: 50 + Math.floor(r() * 150),
  }
  const client = { A: relay().nextClient, B: relay().nextClient + 1 }
  await connect(devs.A)
  await connect(devs.B)
  await advance(20_000)
  relay().pushLatencyFor = profile.slowPushes
    ? () => (r() < 0.25 ? 3000 + Math.floor(r() * 6000) : 100 + Math.floor(r() * 900))
    : () => 100 + Math.floor(r() * 900)

  const history = new History()
  const initial = registers(stateOf(devs.A))
  for (const name of stateOf(devs.A).categories) history.everListed.add(name)
  // Every disturbance lasts a window: mostly seconds, sometimes minutes, then it ends.
  const windowMs = () =>
    r() < 0.2 ? 60_000 + Math.floor(r() * 120_000) : 1000 + Math.floor(r() * 20_000)
  let offlineUntil: number | null = null
  let quotaUntil: number | null = null
  const outageUntil: Record<'A' | 'B', number | null> = { A: null, B: null }
  const disconnectedUntil: Record<'A' | 'B', number | null> = { A: null, B: null }
  const restore = (all: boolean) => {
    const due = (until: number | null) => until !== null && (all || Date.now() >= until)
    if (due(offlineUntil)) {
      offlineUntil = null
      setOnline(true, profile.dropSocket)
    }
    if (due(quotaUntil)) {
      quotaUntil = null
      quotaFull = false
    }
    for (const n of ['A', 'B'] as const) {
      if (due(outageUntil[n])) {
        outageUntil[n] = null
        setClientOffline(client[n], false)
      }
      if (due(disconnectedUntil[n])) {
        disconnectedUntil[n] = null
        void devs[n].sync.useSyncStore.getState().setupSync(SYNC_CODE)
      }
    }
  }
  let events = 0
  const hostileRows = new Set<string>()
  const pushesAtStart = ourPushes()

  for (let i = 0; i < profile.ops; i++) {
    await advance(1 + Math.floor(r() * profile.maxGap))
    restore(false)
    history.observe('A', stateOf(devs.A))
    history.observe('B', stateOf(devs.B))
    const name = r() < 0.5 ? 'A' : 'B'
    const d = devs[name]
    const store = d.expense.useExpenseStore
    const s = store.getState()
    const roll = r()
    const write = (op: string, change: () => void) => {
      const before = stateOf(d)
      withClock(skew[name], change)
      history.write(name, before, stateOf(d), op)
    }
    if (roll < 0.16) {
      const item = r() < 0.6 ? (pick(ITEMS) ?? 'grab') : `n${String(seed)}-${String(i)}`
      const category = r() < 0.6 ? pick(s.categories) : undefined
      const amount = 1 + Math.floor(r() * 50)
      write(`add ${item}`, () => {
        s.addExpense({ itemName: item, amount, ...(category ? { category } : {}) })
      })
    } else if (roll < 0.4) {
      const id = pick(s.expenses.map((e) => e.id))
      const field = pick(FIELDS) ?? 'amount'
      if (id === undefined) continue
      const patch: Partial<Expense> =
        field === 'amount'
          ? { amount: 100 + i }
          : field === 'notes'
            ? { notes: `note ${name}${String(i)}` }
            : field === 'itemName'
              ? { itemName: `item ${name}${String(i)}` }
              : field === 'date'
                ? { date: `2026-10-${String(1 + Math.floor(r() * 18)).padStart(2, '0')}T12:00:00` }
                : { category: pick(s.categories) ?? 'Other' }
      write(`edit ${id}.${field}`, () => {
        s.updateExpense(id, patch)
      })
    } else if (roll < 0.48) {
      const id = pick(s.expenses.map((e) => e.id))
      if (id !== undefined)
        write(`delete ${id}`, () => {
          s.deleteExpense(id)
        })
    } else if (roll < 0.54) {
      const entry = s.undoStack.at(-1)
      if (entry)
        write(`undo ${entry.id}`, () => {
          store.getState().consumeUndo(entry.id)
        })
    } else if (roll < 0.58) {
      const category = pick(NAME_POOL) ?? 'Gym'
      write(`addCategory ${category}`, () => {
        s.addCategory(category)
      })
    } else if (roll < 0.62) {
      const from = pick(s.categories.filter((c) => c !== 'Other'))
      const to = pick(NAME_POOL) ?? 'Gym'
      if (from !== undefined && from !== to)
        write(`rename ${from}->${to}`, () => {
          s.renameCategory(from, to)
        })
    } else if (roll < 0.65) {
      const category = pick(s.categories.filter((c) => c !== 'Other'))
      if (category !== undefined)
        write(`remove ${category}`, () => {
          s.removeCategory(category)
        })
    } else if (roll < 0.7) {
      const category = pick(s.categories) ?? 'Other'
      if (r() < 0.7) {
        const amount = 50 * (1 + Math.floor(r() * 10))
        write(`budget ${category}=${String(amount)}`, () => {
          s.setBudget(category, amount)
        })
      } else {
        write(`unbudget ${category}`, () => {
          s.removeBudget(category)
        })
      }
    } else if (roll < 0.74) {
      if (offlineUntil !== null) continue
      events++
      await advance(1)
      offlineUntil = Date.now() + windowMs()
      setOnline(false, profile.dropSocket)
    } else if (roll < 0.78) {
      events++
      await advance(1)
      await hideAndShow(Math.floor(r() * 3000))
    } else if (roll < 0.82) {
      if (disconnectedUntil[name] !== null) continue
      events++
      disconnectedUntil[name] = Date.now() + windowMs()
      d.sync.useSyncStore.getState().disconnectSync()
    } else if (roll < 0.86) {
      if (outageUntil[name] !== null) continue
      events++
      outageUntil[name] = Date.now() + windowMs()
      setClientOffline(client[name], true)
    } else if (roll < 0.89) {
      events++
      const failures: Failure[] = [
        { status: 503 },
        { status: 429 },
        { status: 500 },
        { hang: true },
      ]
      const failure = pick(failures)
      if (failure) failNext(r() < 0.5 ? 'pull' : 'push', failure)
    } else if (roll < 0.91) {
      events++
      const payload = rowPayload(SYNC_CODE)
      if (!isRecord(payload) || !Array.isArray(payload.expenses)) continue
      const rows: unknown[] = [...(payload.expenses as readonly unknown[])]
      const victim = pick(rows.filter((row) => isRecord(row) && typeof row.amount === 'number'))
      const hostile = { id: `evil-${String(seed)}-${String(i)}`, amount: 'lots', date: 'never' }
      hostileRows.add(canon(hostile))
      writeAsOther(SYNC_CODE, {
        ...payload,
        expenses: [
          ...rows.map((row) =>
            row === victim && isRecord(row)
              ? { ...row, amount: HOSTILE_AMOUNT, updatedAt: '9999-12-31T23:59:59.999Z' }
              : row,
          ),
          hostile,
        ],
        categories: 5,
        budgets: { [HOSTILE_BUDGET]: 1, constructor: 'x' },
        mappingUpdatedAt: Object.fromEntries(
          Object.keys(isRecord(payload.categoryMappings) ? payload.categoryMappings : {}).map(
            (key) => [key, '9999-01-01T00:00:00.000Z'],
          ),
        ),
        wr: { app: 'evil', rev: 42 },
      })
    } else if (roll < 0.93) {
      if (quotaUntil !== null) continue
      events++
      quotaUntil = Date.now() + windowMs()
      quotaFull = true
    }
  }

  // Everything comes back: network, sockets, codes, storage. Then the dust settles.
  await advance(1)
  relay().failures = { pull: [], push: [] }
  relay().pushLatencyFor = null
  dropRealtime(false)
  restore(true)
  await advance(5 * MINUTE)

  const issues: string[] = []
  const a = stateOf(devs.A)
  const b = stateOf(devs.B)
  const relayNow = relayContent()
  if (contentKey(devs.A.expense.useExpenseStore.getState().exportBackup()) !== relayNow.key)
    issues.push('A != relay')
  if (
    contentKey(devs.A.expense.useExpenseStore.getState().exportBackup()) !==
    contentKey(devs.B.expense.useExpenseStore.getState().exportBackup())
  )
    issues.push('A != B')
  issues.push(...passthroughIssues(hostileRows, relayNow.passthrough))
  for (const [n, s] of [
    ['A', a],
    ['B', b],
  ] as const) {
    for (const id of rowIds(s))
      if (id.startsWith('evil-')) issues.push(`HOSTILE ROW MERGED ${id} on ${n}`)
  }
  for (const [n, s] of [
    ['A', a],
    ['B', b],
  ] as const) {
    const ids = rowIds(s)
    for (const id of history.added.keys()) {
      if (!history.deleted.has(id) && !ids.has(id)) issues.push(`LOST ADD ${id} on ${n}`)
    }
    for (const row of s.expenses) {
      if (isRecord(row) && row.amount === HOSTILE_AMOUNT)
        issues.push(`HOSTILE COPY KEPT ${String(row.id)} on ${n}`)
    }
    for (const id of history.deleted.keys()) {
      if (ids.has(id)) issues.push(`RESURRECTED ${id} on ${n}`)
      if (!s.deletedIds.includes(id)) issues.push(`NO TOMBSTONE ${id} on ${n}`)
    }
  }
  const { issues: reverted, concurrentLosses } = history.check(a, initial, new Set(['A', 'B']))
  issues.push(...reverted, ...listIssues(a, history.everListed))

  const pushes = ourPushes() - pushesAtStart
  const bound = history.changes + 2 * events + 6
  if (pushes > bound) issues.push(`TOO MANY PUSHES ${String(pushes)} > ${String(bound)}`)
  const before = relay().upserts
  await advance(10 * MINUTE)
  if (relay().upserts !== before) {
    issues.push(`NOT QUIET: ${String(relay().upserts - before)} upserts in 10 idle minutes`)
  }

  const line = `${profile.name} seed ${String(seed)}: changes ${String(history.changes)} events ${String(events)} pushes ${String(pushes)} concurrent-losses ${String(concurrentLosses)}`
  expect(issues, line).toEqual([])
  return line
}

describe.each(PROFILES)('two v0.8.5 devices, fuzzed ($name)', (profile) => {
  it.each(Array.from({ length: profile.seeds }, (_, i) => profile.from + i))(
    'seed %i',
    async (seed) => {
      await runSeed(profile, seed)
    },
  )
})

// ---------------------------------------------------------------------------
// A v0.8.5 device next to a v0.8.4 device
// ---------------------------------------------------------------------------

const LEGACY_SEEDS = 12

function legacySynced(s: LegacyState): SyncedState {
  return { ...s, mappingUpdatedAt: {} }
}

describe('a v0.8.5 device next to a v0.8.4 device, fuzzed', () => {
  it.each(Array.from({ length: LEGACY_SEEDS }, (_, i) => 2001 + i))('seed %i', async (seed) => {
    const r = rng(seed * 7919 + 13)
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
    // Shopping is a default category, where the old device re-files by keyword.
    const LIST = ['Other', 'Meals', 'Shopping']
    const n = await bootDevice({ expenses: seedRows() })
    n.expense.useExpenseStore.setState({ categories: LIST })
    relay().latency = {
      pull: 150 + Math.floor(r() * 300),
      push: 150 + Math.floor(r() * 300),
      realtime: 50 + Math.floor(r() * 150),
    }
    await connect(n)
    const old = new LegacyPeer(seedRows(), LIST)
    const history = new History()
    const initial = registers(stateOf(n))
    for (const name of LIST) history.everListed.add(name)
    old.onWrite = (before, after, op) => {
      history.observe('L', legacySynced(after))
      if (op === 'merge') return
      history.write('L', legacySynced(before), legacySynced(after), op)
    }
    old.connect(SYNC_CODE)
    await advance(20_000)

    for (let i = 0; i < 50; i++) {
      await advance(1 + Math.floor(r() * 6000))
      history.observe('A', stateOf(n))
      history.observe('L', legacySynced(old.state))
      const roll = r()
      if (r() < 0.6) {
        const s = n.expense.useExpenseStore.getState()
        const before = stateOf(n)
        if (roll < 0.3) {
          const category = r() < 0.6 ? pick(s.categories) : undefined
          s.addExpense({
            itemName: pick(ITEMS) ?? 'grab',
            amount: 1 + Math.floor(r() * 50),
            ...(category ? { category } : {}),
          })
        } else if (roll < 0.7) {
          const id = pick(s.expenses.map((e) => e.id))
          if (id !== undefined) s.updateExpense(id, { amount: 100 + i })
        } else if (roll < 0.8) {
          const id = pick(s.expenses.map((e) => e.id))
          if (id !== undefined) s.deleteExpense(id)
        } else if (roll < 0.9) {
          const entry = s.undoStack.at(-1)
          if (entry) s.consumeUndo(entry.id)
        } else {
          const from = pick(s.categories.filter((c) => c !== 'Other'))
          const to = pick(NAME_POOL) ?? 'Gym'
          if (from !== undefined && from !== to) s.renameCategory(from, to)
        }
        history.write('A', before, stateOf(n), `op ${String(i)}`)
      } else if (roll < 0.4) {
        old.add(pick(ITEMS) ?? 'grab', 1 + Math.floor(r() * 50), pick(old.state.categories))
      } else if (roll < 0.8) {
        const id = pick(old.state.expenses.map((e) => e.id))
        if (id !== undefined) old.edit(id, { notes: `old ${String(i)}` })
      } else {
        const id = pick(old.state.expenses.map((e) => e.id))
        if (id !== undefined) old.remove(id)
      }
    }
    await advance(5 * MINUTE)

    const issues: string[] = []
    const s = stateOf(n)
    const ids = rowIds(s)
    for (const [id, author] of history.added) {
      // Only an add the v0.8.4 device lost by itself (F-001) may be missing here.
      const lostByOld = author === 'L' && !rowIds(old.state).has(id)
      if (!history.deleted.has(id) && !ids.has(id) && !lostByOld) issues.push(`LOST ADD ${id}`)
    }
    for (const [id, author] of history.deleted) {
      // A delete the v0.8.4 device lost by itself (F-001: no tombstone there) may come back.
      const lostByOld = author === 'L' && !old.state.deletedIds.includes(id)
      if (ids.has(id) && !lostByOld) issues.push(`RESURRECTED ${id}`)
    }
    issues.push(...history.check(s, initial, new Set(['A'])).issues)
    issues.push(...listIssues(s, history.everListed))
    // It keeps chattering (F-002); this device pushes at most once per pair it already pushed.
    const ours = ourPushes()
    await advance(10 * MINUTE)
    if (ourPushes() - ours > 2) issues.push(`NOT QUIET: ${String(ourPushes() - ours)} pushes`)
    expect(n.sync.useSyncStore.getState().legacyWriterAt).not.toBeNull()
    old.disconnect()
    expect(issues, `legacy seed ${String(seed)}`).toEqual([])
  })
})
