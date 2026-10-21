// What "on the relay" means to this device: `pendingLocal` (the honesty of "Synced", AC-19) and
// the pending field edits a rebase relies on (AC-11) are cleared only by what a cycle proves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  seedRow,
  setVisibility,
  settle,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const PULL_MS = 800
const PUSH_MS = 300
const OTHER_CODE = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** A phone with e1 and e2 on the relay, in sync; the relay is slow from now on. */
async function syncedPhone(): Promise<Device> {
  const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
  await connect(phone)
  relay().latency = { pull: PULL_MS, push: PUSH_MS, realtime: 50 }
  return phone
}

const relayIds = () =>
  relayRows().map((r) => (typeof r === 'object' && r !== null && 'id' in r ? r.id : r))

describe('pendingLocal follows what the relay holds', () => {
  it('stays true when a cycle ends with a write it did not carry, until the follow-up lands', async () => {
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    let pendingAtResult: boolean | null = null
    const cycle = phone.sync.useSyncStore
      .getState()
      .triggerSync()
      .then((result) => {
        pendingAtResult = phone.sync.useSyncStore.getState().pendingLocal
        return result
      })
    await advance(PULL_MS + PUSH_MS / 3) // pulled and merged; the push is on the wire
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Teh', amount: 1.2 })
    expect(await settle(cycle, PUSH_MS)).toMatchObject({ ok: true, pushed: true })

    expect(pendingAtResult).toBe(true) // the Teh add is not on the relay yet
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(true)
    await advance(PULL_MS + PUSH_MS + 100) // the follow-up cycle carries it
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false)
    expect(relayRows()).toHaveLength(4)
  })

  it('clears on a cycle that finds the relay already equal (a change undone before sync)', async () => {
    const phone = await syncedPhone()
    const upserts = relay().upserts
    phone.expense.useExpenseStore.getState().addCategory('Groceries')
    phone.expense.useExpenseStore.getState().removeCategory('Groceries')
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(true)

    await advance(5000) // the push timer runs a cycle: nothing to send
    expect(relay().upserts).toBe(upserts)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      pendingLocal: false,
    })
  })

  it('a hide after a failed cycle sends the unsent change at once, without waiting for the retry', async () => {
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    failNext('push', { status: 503 })
    const result = await settle(
      phone.sync.useSyncStore.getState().triggerSync(),
      PULL_MS + PUSH_MS + 10,
    )
    expect(result).toMatchObject({ ok: false, error: 'server' }) // the 2 s retry is armed
    const pulls = relay().pulls

    setVisibility('hidden') // the owner switches apps; no push timer is armed
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1)
    await advance(PULL_MS + PUSH_MS)
    expect(relayRows()).toHaveLength(3)
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false)
  })
})

describe('pending field edits are acknowledged by exactly what landed', () => {
  it('keeps an edit made while the push is on the wire, and drops the one the push carried', async () => {
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(PULL_MS + PUSH_MS / 3) // the push carrying e1 is on the wire
    phone.expense.useExpenseStore.getState().updateExpense('e2', { notes: 'with Wei Jie' })
    await settle(cycle, PUSH_MS)

    const { edits } = phone.expense.pendingEditsSnapshot()
    expect(edits.has('e1')).toBe(false)
    expect(edits.has('e2')).toBe(true)
  })

  it('are cleared by connecting to another code, and kept when reconnecting to the same one', async () => {
    const phone = await syncedPhone()
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    failNext('pull', { status: 503 }) // the edit stays pending
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)

    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE))
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)

    // They were relative to the old relay copy, which the new code's relay does not hold.
    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().setupSync(OTHER_CODE))
    expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(0)
  })
})

describe('unreadable relay rows', () => {
  it('a deleted one is not put back on the relay', async () => {
    // A row v0.8 cannot read (a later version wrote it) that another device has since deleted.
    const unreadable = { ...expense('v5row'), date: 'last tuesday' }
    seedRow(SYNC_CODE, payloadOf([unreadable, expense('g1')], { deletedIds: ['v5row'] }))
    const phone = await bootDevice({ expenses: [expense('e1')] })
    expect(await connect(phone)).toMatchObject({ ok: true, pushed: true })

    expect(relayIds()).not.toContain('v5row')
    expect(relayIds().sort()).toEqual(['e1', 'g1'])
  })
})
