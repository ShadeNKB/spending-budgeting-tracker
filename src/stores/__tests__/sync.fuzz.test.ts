// The adversarial two-device fuzz (contract §16.4), seeded, on virtual time, over one fake relay,
// with the real stores and the real sync engine on the v5 core. Two 0.10.0 devices (and, in the
// last suite, a v0.8.4 device) take random adds, field edits, deletes, undos, category adds,
// renames and removals, item-mapping picks and budget changes, while the world does its worst:
// shared offline windows and hide/show, one device losing its network (and its realtime socket),
// Disconnect and reconnect, failed and hung requests, slow uploads, clocks a day off, a full
// localStorage, and a hostile writer that injects unreadable rows, far-future stamps and damaged
// collections into the relay copy.
//
// After the dust settles the oracle demands:
// - convergence: both devices show the same entries, categories, item picks and budgets, and the
//   relay holds exactly those entries; the hostile writer's unreadable rows are merged nowhere;
// - no lost add and no resurrection, and every deletion is a tombstone on the relay;
// - no reverted write, PER FIELD (v5 merges each field on its own): every write of an entry's
//   name, amount, notes or day is either part of the final value's history, or lost to a write
//   the OTHER device (or the hostile writer) made without having seen it. A single device's edits
//   and undos are never reverted. (Categories are resolved through the rename table, so their
//   final value is checked by convergence and the display-list rule instead.)
// - every row's category is in the display list, and the list invents no name;
// - quiet: zero pushes in 10 idle minutes, and a bounded number of pushes per change.
//
// v5 change from PR-0's fuzz: unreadable relay rows are quarantined (Needs attention), no longer
// passed through, and a hostile copy at an untouched record's own stamp may win that tie (it is a
// stamped write like any other; the relay is not authenticated until private sync, F-006).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format, parseISO } from 'date-fns'
import type { ExpensePatch } from '../../data/core/types'
import { isRecord } from '../../lib/backup'
import {
  MemoryStorage,
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  failNext,
  relay,
  relayDeleted,
  relayRows,
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
const FIELDS = ['amount', 'notes', 'itemName', 'category', 'day'] as const
const NAME_POOL = ['Gym', 'Pets', 'Travel', 'Kids', 'Fees', 'Dining', 'Meals', 'Transport']
const ITEMS = ['grab', 'coffee', 'rent', 'gym pass', 'vet', 'kitchen towel']
const HOSTILE_AMOUNT = 999_999

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

/**
 * Makes a seed's run reproducible: the engines' ids and push revs (crypto) and v0.8.4's ids
 * (Math.random) come from the seed too, so the same seed always picks the same entries.
 */
function seedRandomness(seed: number): void {
  const bytes = rng(seed ^ 0x5eed5eed)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array !== null) {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
        for (let i = 0; i < view.length; i++) view[i] = Math.floor(bytes() * 256)
      }
      return array
    },
  )
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x0ddba11))
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
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

/** Pushes by 0.10.0 clients (they carry `x5`). */
const ourPushes = () =>
  relay().pushes.filter((p) => isRecord(p.payload) && isRecord(p.payload.x5)).length

// ---------------------------------------------------------------------------
// The oracle: every write is a version of a register with the version it replaced
// ---------------------------------------------------------------------------

type Author = 'A' | 'B' | 'L' | 'H'

interface Version {
  value: string
  /** The version its author held when it wrote this one (null: new, or the initial value). */
  parent: Version | null
  author: Author
  t: number
  op: string
}

/** What a device shows (or a legacy peer holds): the oracle's view of a replica. */
interface Shown {
  rows: readonly {
    id: string
    itemName: string
    amount: number
    category: string
    notes?: string
    day: string
  }[]
  categories: readonly string[]
}

const viewOf = (d: Device): Shown => {
  const s = d.expense.useExpenseStore.getState()
  return { rows: s.expenses, categories: s.categories }
}

/**
 * What v0.8.4 shows: the day of a stored date in this device's zone (its quick add stores the
 * instant, which in Honolulu is often the previous UTC date), as 0.10.0 reads it too (P2-2).
 */
function legacyShown(s: LegacyState): Shown {
  return {
    rows: s.expenses.map((e) => ({ ...e, day: format(parseISO(e.date), 'yyyy-MM-dd') })),
    categories: s.categories,
  }
}

/** Per-field registers of every entry (the fields v5 merges on their own). */
function registers(s: Shown): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of s.rows) {
    out.set(`n:${row.id}`, JSON.stringify(row.itemName))
    out.set(`a:${row.id}`, JSON.stringify(row.amount))
    out.set(`o:${row.id}`, JSON.stringify(row.notes ?? null))
    out.set(`d:${row.id}`, JSON.stringify(row.day))
  }
  return out
}

const rowIds = (s: Shown): Set<string> => new Set(s.rows.map((row) => row.id))

class History {
  /** Every write of every register, in order. The same value may be written twice (an undo). */
  private readonly versions = new Map<string, Version[]>()
  /** Row ids added (an add, or an undone delete), with the device that added each. */
  readonly added = new Map<string, Author>()
  /** Row ids deleted (a delete, or an undone add), with the device that deleted each. */
  readonly deleted = new Map<string, Author>()
  readonly everListed = new Set<string>()
  changes = 0
  /** When each device first held each register value (`reg` + newline + value). */
  private readonly seenAt = new Map<Author, Map<string, number>>()

  /** Notes every value `author` holds now (sampled between steps and around every write). */
  observe(author: Author, state: Shown): void {
    const seen = this.seenAt.get(author) ?? new Map<string, number>()
    for (const [reg, value] of registers(state)) {
      const key = `${reg}\n${value}`
      if (!seen.has(key)) seen.set(key, Date.now())
    }
    this.seenAt.set(author, seen)
    for (const name of state.categories) this.everListed.add(name)
  }

  /** The newest write of `value` on `reg` (what a device holding that value built on). */
  private latest(reg: string, value: string | null): Version | null {
    if (value === null) return null
    const list = this.versions.get(reg) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i]
      if (v?.value === value) return v
    }
    return null
  }

  /**
   * Records what one write of `author` changed, from `before` to `after`. `wholeRows`: a v0.8
   * writer stamps its whole record, so every field of a row it changed is written again (§5.3).
   */
  write(author: Author, before: Shown, after: Shown, op: string, wholeRows = false): void {
    this.observe(author, before)
    this.observe(author, after)
    const a = registers(before)
    const b = registers(after)
    const touched = new Set<string>()
    for (const [reg, value] of b) if ((a.get(reg) ?? null) !== value) touched.add(reg.slice(2))
    let changed = false
    for (const [reg, value] of b) {
      const prev = a.get(reg) ?? null
      if (prev === value && !(wholeRows && touched.has(reg.slice(2)))) continue
      changed ||= prev !== value
      const list = this.versions.get(reg) ?? []
      list.push({ value, parent: this.latest(reg, prev), author, t: Date.now(), op })
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
    const listed = (s: Shown) => JSON.stringify([...s.categories].sort())
    if (changed || listed(before) !== listed(after)) this.changes++
  }

  private chain(v: Version | null): Version[] {
    const out: Version[] = []
    const seen = new Set<Version>()
    for (let cur = v; cur !== null && !seen.has(cur); cur = cur.parent) {
      seen.add(cur)
      out.push(cur)
    }
    return out
  }

  /** Whether `author` had held `w` or a later version built on it before time `t`. */
  private sawBefore(author: Author, reg: string, w: Version, t: number): boolean {
    const seen = this.seenAt.get(author)
    if (!seen) return false
    for (const v of this.versions.get(reg) ?? []) {
      const at = seen.get(`${reg}\n${v.value}`)
      if (at === undefined || at >= t) continue
      if (this.chain(v).includes(w)) return true
    }
    return false
  }

  /**
   * Checks the final registers against every recorded write. A write that is not in the final
   * value's history is allowed to be lost only to a rival: a write on that history by another
   * author, made before that author had held the lost write (a concurrent edit of the same
   * field). `checked` limits which authors' writes must survive (a v0.8.4 device loses its own
   * writes by itself, F-001).
   */
  check(final: Shown, initial: Map<string, string>, checked: ReadonlySet<Author>) {
    const issues: string[] = []
    let concurrentLosses = 0
    const regs = registers(final)
    const finalIds = rowIds(final)
    for (const [reg, list] of this.versions) {
      const id = reg.slice(2)
      if (this.deleted.has(id) || !finalIds.has(id)) continue
      const value = regs.get(reg)
      if (value === undefined) continue
      const finals = list.filter((v) => v.value === value)
      if (finals.length === 0 && initial.get(reg) !== value) {
        issues.push(`UNKNOWN ${reg}: ${value}`)
      }
      const history = new Set(finals.flatMap((v) => this.chain(v)))
      for (const w of list) {
        if (history.has(w) || w.value === value || !checked.has(w.author)) continue
        const ancestors = new Set(this.chain(w))
        const rival = [...history].find(
          (v) =>
            v.author !== w.author && !ancestors.has(v) && !this.sawBefore(v.author, reg, w, v.t),
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

function listIssues(s: Shown, everListed: ReadonlySet<string>): string[] {
  const issues: string[] = []
  const listed = new Set(s.categories)
  for (const row of s.rows) if (!listed.has(row.category)) issues.push(`UNLISTED ${row.category}`)
  for (const name of listed) if (!everListed.has(name)) issues.push(`INVENTED ${name}`)
  return issues
}

/** What the owner sees of an entry, and what the relay holds of it. */
const shown = (r: unknown) =>
  isRecord(r) ? JSON.stringify([r.id, r.itemName, r.amount, r.category, r.notes ?? null]) : 'bad'

/** Everything both devices show, for comparison. */
function picture(d: Device): string {
  const s = d.expense.useExpenseStore.getState()
  return JSON.stringify({
    rows: s.expenses.map((e) => [shown(e), e.day]).sort(),
    categories: [...s.categories].sort(),
    mappings: Object.entries(s.categoryMappings).sort(),
    budgets: Object.entries(s.budgets).sort(),
  })
}

/** Runs one owner action; a readable refusal (P2-13) is a fact of the run, not a crash. */
function attempt(issues: string[], op: string, change: () => void): void {
  try {
    change()
  } catch (err) {
    issues.push(`THREW ${op}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Two 0.10.0 devices
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

const seedRows = () =>
  ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) =>
    expense(id, { amount: 10, category: i % 2 === 0 ? 'Meals' : 'Other' }),
  )

async function runSeed(profile: Profile, seed: number): Promise<string> {
  seedRandomness(seed)
  const r = rng(seed * 7919 + 13)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
  const storage = { A: new MemoryStorage(), B: new MemoryStorage() }
  const devs: Record<'A' | 'B', Device> = {
    A: await bootDevice({ persist: true, storedRows: seedRows(), storage: storage.A }),
    B: await bootDevice({ persist: true, storedRows: seedRows(), storage: storage.B }),
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
  const issues: string[] = []
  const initial = registers(viewOf(devs.A))
  history.observe('A', viewOf(devs.A))
  history.observe('B', viewOf(devs.B))
  // Every disturbance lasts a window: mostly seconds, sometimes minutes, then it ends.
  const windowMs = () =>
    r() < 0.2 ? 60_000 + Math.floor(r() * 120_000) : 1000 + Math.floor(r() * 20_000)
  let offlineUntil: number | null = null
  let quotaUntil: number | null = null
  const outageUntil: Record<'A' | 'B', number | null> = { A: null, B: null }
  const disconnectedUntil: Record<'A' | 'B', number | null> = { A: null, B: null }
  const setQuota = (full: boolean) => {
    for (const area of Object.values(storage)) {
      if (full) area.refuse.add('*')
      else area.refuse.delete('*')
    }
  }
  const restore = (all: boolean) => {
    const due = (until: number | null) => until !== null && (all || Date.now() >= until)
    if (due(offlineUntil)) {
      offlineUntil = null
      setOnline(true, profile.dropSocket)
    }
    if (due(quotaUntil)) {
      quotaUntil = null
      setQuota(false)
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
  const pushesAtStart = ourPushes()

  for (let i = 0; i < profile.ops; i++) {
    await advance(1 + Math.floor(r() * profile.maxGap))
    restore(false)
    history.observe('A', viewOf(devs.A))
    history.observe('B', viewOf(devs.B))
    const name = r() < 0.5 ? 'A' : 'B'
    const d = devs[name]
    const store = d.expense.useExpenseStore
    const s = store.getState()
    const roll = r()
    const write = (op: string, change: () => void) => {
      const before = viewOf(d)
      withClock(skew[name], () => {
        attempt(issues, op, change)
      })
      history.write(name, before, viewOf(d), op)
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
      const patch: ExpensePatch =
        field === 'amount'
          ? { amount: 100 + i }
          : field === 'notes'
            ? { notes: `note ${name}${String(i)}` }
            : field === 'itemName'
              ? { itemName: `item ${name}${String(i)}` }
              : field === 'day'
                ? { day: `2026-10-${String(1 + Math.floor(r() * 18)).padStart(2, '0')}` }
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
      const rows: readonly unknown[] = payload.expenses
      const victim = pick(rows.filter((row) => isRecord(row) && typeof row.amount === 'number'))
      // The hostile copy of the victim: recorded as the hostile writer's own version, which may
      // win a tie on a record nobody has edited (see the header).
      // The hostile copy of the victim: recorded as the hostile writer's own amount, which may
      // win a tie on a record nobody has edited (see the header).
      const held = isRecord(victim)
        ? viewOf(devs.A).rows.find((e) => e.id === victim.id)
        : undefined
      if (held !== undefined) {
        history.write(
          'H',
          { rows: [held], categories: [] },
          { rows: [{ ...held, amount: HOSTILE_AMOUNT }], categories: [] },
          'hostile',
        )
      }
      const { x5: _x5, ...v4 } = payload
      writeAsOther(SYNC_CODE, {
        ...v4,
        expenses: [
          ...rows.map((row) =>
            row === victim && isRecord(row)
              ? { ...row, amount: HOSTILE_AMOUNT, updatedAt: '9999-12-31T23:59:59.999Z' }
              : row,
          ),
          { id: `evil-${String(seed)}-${String(i)}`, amount: 'lots', date: 'never' },
        ],
        categories: 5,
        budgets: { __proto__: 1, constructor: 'x' },
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
      setQuota(true)
    }
  }

  // Everything comes back: network, sockets, codes, storage. Then the dust settles.
  await advance(1)
  relay().failures = { head: [], pull: [], push: [] }
  relay().pushLatencyFor = null
  dropRealtime(false)
  restore(true)
  await advance(5 * MINUTE)

  const a = viewOf(devs.A)
  const b = viewOf(devs.B)
  if (picture(devs.A) !== picture(devs.B)) issues.push('A != B')
  const relayed = relayRows().map(shown).sort()
  if (JSON.stringify(a.rows.map(shown).sort()) !== JSON.stringify(relayed))
    issues.push('A != relay')
  const dead = new Set(relayDeleted().filter((id): id is string => typeof id === 'string'))
  for (const [n, s] of [
    ['A', a],
    ['B', b],
  ] as const) {
    const ids = rowIds(s)
    for (const id of ids)
      if (id.startsWith('evil-')) issues.push(`HOSTILE ROW MERGED ${id} on ${n}`)
    for (const id of history.added.keys()) {
      if (!history.deleted.has(id) && !ids.has(id)) issues.push(`LOST ADD ${id} on ${n}`)
    }
    for (const id of history.deleted.keys()) {
      if (ids.has(id)) issues.push(`RESURRECTED ${id} on ${n}`)
      if (!dead.has(id)) issues.push(`NO TOMBSTONE ${id} on the relay`)
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

describe.each(PROFILES)('two 0.10.0 devices, fuzzed ($name)', (profile) => {
  it.each(Array.from({ length: profile.seeds }, (_, i) => profile.from + i))(
    'seed %i',
    async (seed) => {
      await runSeed(profile, seed)
    },
  )
})

// ---------------------------------------------------------------------------
// A 0.10.0 device next to a v0.8.4 device
// ---------------------------------------------------------------------------

const LEGACY_SEEDS = 12

describe('a 0.10.0 device next to a v0.8.4 device, fuzzed', () => {
  it.each(Array.from({ length: LEGACY_SEEDS }, (_, i) => 2001 + i))('seed %i', async (seed) => {
    seedRandomness(seed)
    const r = rng(seed * 7919 + 13)
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
    // Shopping is a default category, where the old device re-files by keyword.
    const LIST = ['Other', 'Meals', 'Shopping']
    const n = await bootDevice({ expenses: seedRows(), v4: { categories: LIST } })
    relay().latency = {
      pull: 150 + Math.floor(r() * 300),
      push: 150 + Math.floor(r() * 300),
      realtime: 50 + Math.floor(r() * 150),
    }
    await connect(n)
    const old = new LegacyPeer(seedRows(), LIST)
    const history = new History()
    const issues: string[] = []
    const initial = registers(viewOf(n))
    for (const name of LIST) history.everListed.add(name)
    old.onWrite = (before, after, op) => {
      history.observe('L', legacyShown(after))
      if (op === 'merge') return
      history.write('L', legacyShown(before), legacyShown(after), op, true)
    }
    old.connect(SYNC_CODE)
    await advance(20_000)

    for (let i = 0; i < 50; i++) {
      await advance(1 + Math.floor(r() * 6000))
      history.observe('A', viewOf(n))
      history.observe('L', legacyShown(old.state))
      const roll = r()
      if (r() < 0.6) {
        const s = n.expense.useExpenseStore.getState()
        const before = viewOf(n)
        attempt(issues, `op ${String(i)}`, () => {
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
        })
        history.write('A', before, viewOf(n), `op ${String(i)}`)
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

    const s = viewOf(n)
    const ids = rowIds(s)
    for (const [id, author] of history.added) {
      // Only an add the v0.8.4 device lost by itself (F-001) may be missing here.
      const lostByOld = author === 'L' && !old.state.expenses.some((e) => e.id === id)
      if (!history.deleted.has(id) && !ids.has(id) && !lostByOld) issues.push(`LOST ADD ${id}`)
    }
    for (const [id, author] of history.deleted) {
      // A delete the v0.8.4 device lost by itself (F-001: no tombstone there) may come back.
      const lostByOld = author === 'L' && !old.state.deletedIds.includes(id)
      if (ids.has(id) && !lostByOld) issues.push(`RESURRECTED ${id}`)
    }
    issues.push(...history.check(s, initial, new Set(['A'])).issues)
    issues.push(...listIssues(s, history.everListed))
    // It keeps chattering (F-002); this device pushes at most once per 10 minutes over it.
    const ours = ourPushes()
    await advance(10 * MINUTE)
    if (ourPushes() - ours > 2) issues.push(`NOT QUIET: ${String(ourPushes() - ours)} pushes`)
    expect(n.sync.useSyncStore.getState().legacyWriterAt).not.toBeNull()
    old.disconnect()
    expect(issues, `legacy seed ${String(seed)}`).toEqual([])
  })
})
