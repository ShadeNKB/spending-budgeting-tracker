// F-001: writes made while a sync cycle is on the wire must never be lost.
// Ports the auditors' race.probe, s1 (add during pull) and s6 (edit/delete during pull).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
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

function relayDeleted(): unknown {
  const payload = rowPayload(SYNC_CODE)
  return typeof payload === 'object' && payload !== null && 'deletedIds' in payload
    ? payload.deletedIds
    : undefined
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

function write(phone: Device, kinds: readonly Write[]): Expense | null {
  const store = phone.expense.useExpenseStore.getState()
  let added: Expense | null = null
  for (const kind of kinds) {
    if (kind === 'add') added = store.addExpense({ itemName: 'Grab to camp', amount: 12 })
    if (kind === 'delete') store.deleteExpense('e1')
    if (kind === 'edit') store.updateExpense('e2', { amount: 70 })
  }
  return added
}

function expectSurvived(phone: Device, kinds: readonly Write[], added: Expense | null) {
  const local = phone.expense.useExpenseStore.getState()
  const localIds = ids(local.expenses)
  if (kinds.includes('add')) {
    expect(localIds).toContain(added?.id)
    expect(relayRow(added?.id ?? '')).toBeDefined()
  }
  if (kinds.includes('delete')) {
    expect(localIds).not.toContain('e1')
    expect(local.deletedIds).toContain('e1')
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
      // The follow-up starts as soon as the cycle ends, without waiting for the 3 s push timer.
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
