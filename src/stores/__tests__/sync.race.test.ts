// F-001: writes made while a sync cycle is on the wire must never be lost.
// Ports the auditors' race.probe, s1 (add during pull) and s6 (edit/delete during pull).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExpenseView } from '../../types'
import {
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  relayDeleted,
  relayRows,
  resetRelay,
  retireDevices,
  settle,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

// The first test of a file pays for transforming the store modules.
vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const PULL_MS = 800
const PUSH_MS = 300

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const ids = (rows: readonly unknown[]) =>
  rows.map((r) => (typeof r === 'object' && r !== null && 'id' in r ? r.id : null))

function relayRow(id: string): Record<string, unknown> | undefined {
  return relayRows().find(
    (r): r is Record<string, unknown> =>
      typeof r === 'object' && r !== null && 'id' in r && r.id === id,
  )
}

/** A phone with e1 (Taxi) and e2 (Lunch, 7) already on the relay; the relay is slow from now on. */
async function syncedPhone(): Promise<Device> {
  const phone = await bootDevice({
    expenses: [
      expense('e1', { itemName: 'Taxi', amount: 25 }),
      expense('e2', { itemName: 'Lunch', amount: 7 }),
    ],
  })
  await connect(phone)
  expect(ids(relayRows()).sort()).toEqual(['e1', 'e2'])
  relay().latency = { pull: PULL_MS, push: PUSH_MS, realtime: 50 }
  return phone
}

type Write = 'add' | 'delete' | 'edit'

function write(phone: Device, kinds: readonly Write[]): ExpenseView | null {
  const store = phone.expense.useExpenseStore.getState()
  let added: ExpenseView | null = null
  for (const kind of kinds) {
    if (kind === 'add') added = store.addExpense({ itemName: 'Grab to camp', amount: 12 })
    if (kind === 'delete') store.deleteExpense('e1')
    if (kind === 'edit') store.updateExpense('e2', { amount: 70 })
  }
  return added
}

function expectSurvived(phone: Device, kinds: readonly Write[], added: ExpenseView | null) {
  const local = phone.expense.useExpenseStore.getState()
  const localIds = ids(local.expenses)
  if (kinds.includes('add')) {
    expect(localIds).toContain(added?.id)
    expect(relayRow(added?.id ?? '')).toBeDefined()
  }
  if (kinds.includes('delete')) {
    expect(localIds).not.toContain('e1')
    expect(relayRow('e1')).toBeUndefined()
    expect(relayDeleted()).toContain('e1')
  }
  if (kinds.includes('edit')) {
    expect(local.expenses.find((e) => e.id === 'e2')?.amount).toBe(70)
    expect(relayRow('e2')?.amount).toBe(70)
  }
}

const CASES: [string, Write[]][] = [
  ['an add, a delete and an edit', ['add', 'delete', 'edit']],
  ['an add alone', ['add']],
  ['a delete alone', ['delete']],
  ['an edit alone', ['edit']],
]

describe('F-001: writes during a pull (T-001-1)', () => {
  it.each(CASES)('keeps %s made while the pull is on the wire', async (_label, kinds) => {
    const phone = await syncedPhone()
    // A cycle starts, as on app open or a realtime event from the laptop.
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(15) // s1: 15 ms into an 800 ms pull
    const added = write(phone, kinds)
    await settle(cycle, PULL_MS + PUSH_MS)
    await advance(10_000) // and anything that follows
    expectSurvived(phone, kinds, added)
  })

  it('keeps writes made 200 ms into a 300 ms pull (s6 timing)', async () => {
    const phone = await syncedPhone()
    relay().latency.pull = 300
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(200)
    const added = write(phone, ['add', 'delete', 'edit'])
    await settle(cycle, 1000)
    await advance(10_000)
    expectSurvived(phone, ['add', 'delete', 'edit'], added)
  })
})

describe('F-001: writes during a push', () => {
  it.each(CASES)(
    'sends %s made while the push is on the wire on the follow-up cycle',
    async (_label, kinds) => {
      const phone = await syncedPhone()
      // Something to push, so the cycle has a push phase.
      phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
      const start = relay().upserts
      const cycle = phone.sync.useSyncStore.getState().triggerSync()
      await advance(PULL_MS + PUSH_MS / 3) // the pull is done and the upsert is in flight
      expect(relay().upserts).toBe(start + 1)
      const before = relay().upserts
      const added = write(phone, kinds)
      await settle(cycle, PUSH_MS)
      // The follow-up starts as soon as the cycle ends, without waiting for the push timer.
      await advance(PULL_MS + PUSH_MS + 100)
      expectSurvived(phone, kinds, added)
      await advance(10_000)
      // Exactly one more cycle carried them (AC-2).
      expect(relay().upserts - before).toBe(1)
    },
  )
})

describe('single flight (T-001-3)', () => {
  it('resolves a trigger made during a cycle only after the next cycle, never with the stale result', async () => {
    const phone = await syncedPhone()
    const store = phone.sync.useSyncStore.getState()
    const order: string[] = []
    const first = store.triggerSync().then(() => order.push('first'))
    await advance(100)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const second = store.triggerSync().then(() => order.push('second'))

    await advance(PULL_MS + PUSH_MS) // the first cycle completes
    expect(order).toEqual(['first'])
    // The add made during the first cycle's pull is already on the relay after that cycle.
    expect(relayRows()).toHaveLength(3)

    await advance(PULL_MS + PUSH_MS) // the second cycle completes
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('runs exactly two cycles for one write during the push', async () => {
    const phone = await syncedPhone()
    const pulls = relay().pulls
    const upserts = relay().upserts
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(PULL_MS + PUSH_MS / 3)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Teh', amount: 1.2 })
    await settle(cycle, PUSH_MS)
    await advance(60_000)
    expect(relay().upserts - upserts).toBe(2)
    expect(relay().pulls - pulls).toBe(2)
    expect(relayRows()).toHaveLength(4)
  })
})

describe('disconnect mid-cycle discards the cycle', () => {
  it('during the pull: no store change, no push, status off', async () => {
    const phone = await syncedPhone()
    const before = phone.expense.useExpenseStore.getState().expenses
    const upserts = relay().upserts
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(100)
    phone.sync.useSyncStore.getState().disconnectSync()
    await settle(cycle, PULL_MS + PUSH_MS)
    await advance(10_000)
    expect(phone.expense.useExpenseStore.getState().expenses).toBe(before)
    expect(relay().upserts).toBe(upserts)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('off')
  })

  it('during the push: no follow-up push and the status stays off', async () => {
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(PULL_MS + PUSH_MS / 3)
    const upserts = relay().upserts
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Teh', amount: 1.2 })
    phone.sync.useSyncStore.getState().disconnectSync()
    await settle(cycle, PUSH_MS)
    await advance(10_000)
    expect(relay().upserts).toBe(upserts)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('off')
  })
})

// ---------------------------------------------------------------------------
// One cycle at a time across this device's tabs (P2-18)
// ---------------------------------------------------------------------------

interface Locks {
  /** Holders at this moment, the most ever at once, and grants so far. */
  readonly stats: { held: number; most: number; granted: number }
  /** Another tab takes the lock and is frozen before it lets go. */
  freeze(): void
}

/**
 * navigator.locks as browsers have it, for one lock name: exclusive, granted in order, and a
 * request whose signal aborts while it waits rejects with AbortError and is never granted.
 * `refuse`: a page that may not use locks (every request rejects at once).
 */
function installLocks(refuse = false): Locks {
  const stats = { held: 0, most: 0, granted: 0 }
  let tail: Promise<void> = Promise.resolve()
  const request = (
    _name: string,
    opts: { signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (refuse) return Promise.reject(new DOMException('Locks are not allowed', 'SecurityError'))
    const before = tail
    let release: () => void = () => undefined
    tail = new Promise((resolve) => {
      release = resolve
    })
    return new Promise((resolve, reject) => {
      let aborted = false
      const onAbort = () => {
        aborted = true
        reject(new DOMException('The lock request is aborted', 'AbortError'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      void before.then(async () => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (aborted) {
          release()
          return
        }
        stats.held++
        stats.granted++
        stats.most = Math.max(stats.most, stats.held)
        try {
          resolve(await callback())
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        } finally {
          stats.held--
          release()
        }
      })
    })
  }
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
  return {
    stats,
    freeze: () => {
      void request('st5:sync', {}, () => new Promise(() => undefined))
    },
  }
}

describe("navigator.locks: one cycle at a time across this device's tabs (P2-18)", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks')
  })

  it('two tabs syncing at once take turns, and both sync', async () => {
    const { stats } = installLocks()
    const tabA = await bootDevice({ expenses: [expense('e1')] })
    const tabB = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = { pull: PULL_MS, push: PUSH_MS, realtime: 50 }
    await connect(tabA, 10_000)
    await connect(tabB, 10_000)
    tabA.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    tabB.expense.useExpenseStore.getState().addExpense({ itemName: 'Teh', amount: 1.2 })
    const granted = stats.granted
    const both = Promise.all([
      tabA.sync.useSyncStore.getState().triggerSync(),
      tabB.sync.useSyncStore.getState().triggerSync(),
    ])
    expect(await settle(both, 2 * (PULL_MS + PUSH_MS) + 100)).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ])
    expect(stats.granted - granted).toBeGreaterThanOrEqual(2)
    expect(stats.most).toBe(1)
    await advance(60_000)
    expect(relayRows()).toHaveLength(3)
  })

  it('a tab frozen while it holds the lock delays this one by 35 s at most', async () => {
    const locks = installLocks()
    const phone = await syncedPhone()
    locks.freeze()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(30_000)
    expect(relayRows()).toHaveLength(2)
    expect(await settle(cycle, 5000 + PULL_MS + PUSH_MS + 100)).toMatchObject({ ok: true })
    expect(relayRows()).toHaveLength(3)
  })

  it('a page that may not use locks syncs without one', async () => {
    installLocks(true)
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    expect(await settle(cycle, PULL_MS + PUSH_MS + 100)).toMatchObject({ ok: true })
    expect(relayRows()).toHaveLength(3)
  })
})
