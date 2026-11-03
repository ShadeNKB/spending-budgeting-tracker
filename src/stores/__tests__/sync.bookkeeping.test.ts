// What "on the relay" means to this device: `pendingLocal` (the honesty of "Synced", AC-19) is
// cleared by what a cycle proves, and local changes reach the relay whatever happened to the
// connection in between.
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
  MemoryStorage,
  retireDevices,
  seedRow,
  setVisibility,
  settle,
  stubRelayEnv,
  type Device,
  steadyRandom,
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
  steadyRandom() // retries at exactly 2, 4, 8 … s (the jitter is asserted in sync.status)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

  // v5: every write is a stamped fact (an add then a remove of a category leaves the removal for
  // other devices to learn), so "undone before sync" no longer exists. What clears the outbox
  // without a push is a relay that already holds it: here our own push, whose answer was lost.
  it('clears on a cycle that finds the relay already equal (a push whose answer was lost)', async () => {
    const phone = await syncedPhone()
    failNext('push', { ghost: 100 }) // it lands, and the answer never comes back
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(1500 + PULL_MS + 15_000) // the push timer, the pull, the 15 s deadline
    expect(phone.sync.useSyncStore.getState()).toMatchObject({ pendingLocal: true })
    expect(relay().ghostsLanded).toBe(1)
    const upserts = relay().upserts

    await advance(2000 + PULL_MS + 100) // the 2 s retry pulls our own landed push
    expect(relay().upserts).toBe(upserts)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      pendingLocal: false,
      lastError: null,
    })
  })

  it('a change still in the outbox when the app closes syncs at the next start (AC-20)', async () => {
    const storage = new MemoryStorage()
    const phone = await bootDevice({ expenses: [expense('e1')], storage, savedCode: SYNC_CODE })
    await advance(5000)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    const added = phone.expense.useExpenseStore
      .getState()
      .addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)
    expect(relayIds()).not.toContain(added.id)
    retireDevices() // the app is closed

    // The next start, online again: the durable outbox drives a boot cycle.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const again = await bootDevice({ storage, savedCode: SYNC_CODE })
    expect(again.sync.useSyncStore.getState().pendingLocal).toBe(true)
    await advance(5000)
    expect(relayIds()).toContain(added.id)
    expect(again.sync.useSyncStore.getState()).toMatchObject({
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

describe('Disconnect, reconnect and another code', () => {
  it('a change made while disconnected reaches the relay on reconnect', async () => {
    const phone = await syncedPhone()
    phone.sync.useSyncStore.getState().disconnectSync()
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false) // nothing to promise
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    await advance(10_000)
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1', amount: 1 }))

    expect(
      await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 5000),
    ).toMatchObject({ ok: true, pushed: true })
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1', amount: 45 }))
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false)
  })

  it('connecting to another code merges this device into that relay copy', async () => {
    const phone = await syncedPhone()
    seedRow(OTHER_CODE, payloadOf([expense('o1')]))
    await settle(phone.sync.useSyncStore.getState().setupSync(OTHER_CODE), 5000)
    const ids = phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)
    expect(ids.sort()).toEqual(['e1', 'e2', 'o1'])
  })

  it('a pull that fails keeps the change pending, and the retry carries it', async () => {
    const phone = await syncedPhone()
    failNext('pull', { status: 503 })
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    expect(
      await settle(phone.sync.useSyncStore.getState().triggerSync(), PULL_MS + 10),
    ).toMatchObject({ ok: false, error: 'server' })
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(true)
    await advance(2000 + PULL_MS + PUSH_MS + 100) // the 2 s retry
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1', amount: 45 }))
    expect(phone.sync.useSyncStore.getState().pendingLocal).toBe(false)
  })
})

describe('unreadable relay rows', () => {
  it('a deleted one is not put back on the relay', async () => {
    // A row this version cannot read that another device has since deleted.
    const unreadable = { ...expense('v5row'), date: 'last tuesday' }
    seedRow(SYNC_CODE, payloadOf([unreadable, expense('g1')], { deletedIds: ['v5row'] }))
    const phone = await bootDevice({ expenses: [expense('e1')] })
    expect(await connect(phone)).toMatchObject({ ok: true, pushed: true })

    expect(relayIds()).not.toContain('v5row')
    expect(relayIds().sort()).toEqual(['e1', 'g1'])
  })
})
