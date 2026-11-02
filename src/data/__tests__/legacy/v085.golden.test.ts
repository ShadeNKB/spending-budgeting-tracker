// @vitest-environment node
// Golden vectors of the frozen v0.8.5 model (app 0.9.2, P2-5): the digests below are the SHIPPED
// 0.9.2 code's outputs on the deterministic inputs of v085.golden.ts, generated once against
// `git archive v0.9.2 src` (U1 scratch, where the model gave the same digests in every zone
// listed). 0.9.2's merge sorts by date, so a zone-less date orders differently per zone, and its
// store reads days in the device zone: those digests are kept per zone (the three CI zones, New
// York and UTC). A failure here means the model no longer describes the phone's code.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemStorage } from '../sim/oldDevices'
import { makeRng } from '../support/rng'
import {
  GOLDEN_T0,
  pureDigests,
  storeDigest,
  storeView,
  type PureImpl,
  type StoreHarness,
} from './v085.golden'
import {
  V085Client,
  canon,
  canonRow,
  contentKey,
  fnv1a,
  isNumber,
  isString,
  isSyncableExpense,
  keepLocalRefiles,
  listOf,
  mergeBackups,
  nestsWithin,
  nextStampIso,
  parseBackup,
  readRemote,
  recordOf,
  stampMs,
  type BackupData,
  type Expense,
} from './v085'
import type { ClockPort } from './v084'

/** Digests every zone agrees on (no date ordering or local day involved). */
const UNIVERSAL = {
  stamps: '42b36074792bc732',
  canon: '5c5a4224320e846a',
  backup: '1b441e0e37b2f0bc',
  readRemote: 'a2afde2663fbfe60',
} as const

interface ZoneDigests {
  readonly mergeBackups: string
  readonly keepLocalRefiles: string
  readonly store: string
}
const BY_ZONE: Readonly<Record<string, ZoneDigests>> = {
  'Asia/Singapore': {
    mergeBackups: '7c2e4c27fb5d666d',
    keepLocalRefiles: '2e1fc4231bd13a4d',
    store: '070cccba894ab55c',
  },
  'Pacific/Honolulu': {
    mergeBackups: '029bf5bbab8cd949',
    keepLocalRefiles: 'ff08d7fb608c987d',
    store: '06ee2a88b7c290ee',
  },
  'Pacific/Kiritimati': {
    mergeBackups: 'a7156a63afc16e21',
    keepLocalRefiles: '48eed3e36078a84d',
    store: '455315d586a6a9b3',
  },
  'America/New_York': {
    mergeBackups: '029bf5bbab8cd949',
    keepLocalRefiles: 'ff08d7fb608c987d',
    store: 'e7f5731116307b9f',
  },
  UTC: {
    mergeBackups: 'e54911eb4d7ce3c9',
    keepLocalRefiles: 'f3f583594a8dde6b',
    store: 'e7f5731116307b9f',
  },
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zoned = Object.hasOwn(BY_ZONE, zone) ? BY_ZONE[zone] : undefined

const fixedClock: ClockPort = {
  now: () => GOLDEN_T0 + 123,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
}

const okData = (p: unknown): BackupData | null => {
  const r = readRemote(p)
  return r.kind === 'ok' ? r.data : null
}

const model: PureImpl<BackupData, Expense> = {
  stampMs: (v) => stampMs(v),
  nextStampIso: (now, bases) => nextStampIso(now, ...bases),
  canon: (v) => canon(v),
  canonRow: (v) => canonRow(v),
  nestsWithin: (v, max) => nestsWithin(v, max),
  fnv1a: (s) => fnv1a(s),
  parseBackup: (raw) => parseBackup(raw, fixedClock),
  recordOfStrings: (v) => recordOf(v, isString),
  listOfNumbers: (v) => listOf(v, isNumber),
  isSyncableExpense: (v) => isSyncableExpense(v),
  readRemote: (p) => readRemote(p),
  readOk: okData,
  contentKey: (p, opts) => contentKey(p, opts),
  mergeBackups: (a, b) => mergeBackups(a, b, fixedClock),
  expensesOf: (d) => d.expenses,
  withExpenses: (d, expenses) => ({ ...d, expenses: [...expenses] }),
  categoryOf: (e) => e.category,
  refile: (e, category) => ({ ...e, category }),
  keepLocalRefiles: (merged, local, remote) => keepLocalRefiles(merged, local, remote),
}

/** The store's timers on vitest's fake clock (the 400 ms save debounce, undo expiry). */
function timerPort(): ClockPort {
  const handles = new Map<number, ReturnType<typeof setTimeout>>()
  let next = 1
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const id = next++
      handles.set(
        id,
        setTimeout(() => {
          handles.delete(id)
          fn()
        }, ms),
      )
      return id
    },
    clearTimeout: (id) => {
      const h = handles.get(id)
      if (h !== undefined) clearTimeout(h)
      handles.delete(id)
    },
  }
}

const modelStore: StoreHarness<BackupData> = {
  start: (keys, wall, seq) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(wall)
    const mem = new MemStorage()
    for (const [k, v] of keys) mem.setItem(k, v)
    const m = new V085Client(timerPort(), makeRng(seq).next, mem, {
      pull: () => Promise.resolve(null),
      push: () => Promise.resolve(),
      subscribe: () => () => undefined,
    })
    m.hydrate()
    return Promise.resolve({
      snapshot: () => ({
        ids: m.s.expenses.map((e) => e.id),
        categories: m.s.categories,
        budgets: m.s.budgets,
        undoIds: m.s.undoStack.map((u) => u.id),
      }),
      view: () => storeView(m.exportBackup(), m.s.undoStack, m.s.syncStatus, m.s.lastSavedAt),
      addExpense: (input) => m.addExpense(input),
      updateExpense: (id, patch) => {
        m.updateExpense(id, patch)
      },
      deleteExpense: (id) => {
        m.deleteExpense(id)
      },
      consumeUndo: (id) => {
        m.consumeUndo(id)
      },
      renameCategory: (from, to) => {
        m.renameCategory(from, to)
      },
      removeCategory: (name) => {
        m.removeCategory(name)
      },
      setBudget: (category, amount) => {
        m.setBudget(category, amount)
      },
      removeBudget: (category) => {
        m.removeBudget(category)
      },
      addCategory: (name) => {
        m.addCategory(name)
      },
      importBackup: (data) => {
        m.importBackup(data)
      },
      exportBackup: () => m.exportBackup(),
      clearAllExpenses: () => {
        m.clearAllExpenses()
      },
      clearUndo: (id) => {
        m.clearUndo(id)
      },
      flushPendingSave: () => {
        m.flushPendingSave()
      },
      savedKeys: () => [...mem.map].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    })
  },
  advance: async (ms) => {
    await vi.advanceTimersByTimeAsync(ms)
  },
  readOk: okData,
  stop: () => {
    vi.useRealTimers()
  },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('v0.8.5 model = the shipped 0.9.2 code (golden digests, P2-5)', () => {
  it('lib/stamps, lib/canon, lib/backup and readRemote/contentKey: every zone', () => {
    const got = pureDigests(model)
    expect({
      stamps: got.stamps,
      canon: got.canon,
      backup: got.backup,
      readRemote: got.readRemote,
    }).toEqual(UNIVERSAL)
  })

  it.runIf(zoned !== undefined)(`mergeBackups and keepLocalRefiles in ${zone}`, () => {
    const got = pureDigests(model)
    expect({ mergeBackups: got.mergeBackups, keepLocalRefiles: got.keepLocalRefiles }).toEqual({
      mergeBackups: zoned?.mergeBackups,
      keepLocalRefiles: zoned?.keepLocalRefiles,
    })
  })

  it.runIf(zoned !== undefined)(
    `the store: random 30-action sequences, every view and saved key, in ${zone}`,
    async () => {
      expect(await storeDigest(modelStore)).toBe(zoned?.store)
    },
    60_000,
  )
})
