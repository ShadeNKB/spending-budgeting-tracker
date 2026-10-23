// What "on the relay" means to this device: `pendingLocal` (the honesty of "Synced", AC-19) is
// cleared by what a cycle proves, and the pending field edits a rebase relies on (AC-11) only by
// another device building on them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/backup'
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
  rowPayload,
  seedRow,
  setVisibility,
  settle,
  stubRelayEnv,
  writeAsOther,
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

describe('pending field edits are acknowledged once another device builds on them', () => {
  it('a landed push, and our own copy read back, acknowledge nothing; a push built on ours does', async () => {
    const phone = await syncedPhone()
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    const cycle = phone.sync.useSyncStore.getState().triggerSync()
    await advance(PULL_MS + PUSH_MS / 3) // the push carrying e1 is on the wire
    phone.expense.useExpenseStore.getState().updateExpense('e2', { notes: 'with Wei Jie' })
    expect(await settle(cycle, PUSH_MS)).toMatchObject({ ok: true, pushed: true })

    // e1 landed, but a peer's push built on an older pull could still land over it.
    let { edits } = phone.expense.pendingEditsSnapshot()
    expect(edits.has('e1')).toBe(true)
    expect(edits.has('e2')).toBe(true)

    await advance(PULL_MS + PUSH_MS + 100) // the follow-up cycle carries e2
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e2', notes: 'with Wei Jie' }))
    await advance(2500 + PULL_MS + 100) // the check pull reads our own copy back
    expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(2)

    // Another device's push built on that copy: it holds both edits now.
    const relayCopy = rowPayload(SYNC_CODE)
    const wr = isRecord(relayCopy) && isRecord(relayCopy.wr) ? relayCopy.wr : {}
    writeAsOther(SYNC_CODE, {
      ...(isRecord(relayCopy) ? relayCopy : {}),
      wr: { app: '0.8.5', dev: 'aaaaaa', rev: 'r-laptop', at: '', seen: [wr.rev] },
    })
    await advance(PULL_MS + 1000)
    ;({ edits } = phone.expense.pendingEditsSnapshot())
    expect(edits.size).toBe(0)
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

  it('survive a Disconnect, so a reconnect to the same code still rebases them', async () => {
    const phone = await syncedPhone()
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    failNext('pull', { status: 503 })
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    phone.sync.useSyncStore.getState().disconnectSync()
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)

    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 5000)
    expect(relayRows()).toContainEqual(expect.objectContaining({ id: 'e1', amount: 45 }))
  })

  it('are cleared when the code set up after a Disconnect is a different one', async () => {
    const phone = await syncedPhone()
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    failNext('pull', { status: 503 })
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    await settle(phone.sync.useSyncStore.getState().triggerSync())
    phone.sync.useSyncStore.getState().disconnectSync()
    failNext('pull', { status: 503 })
    await settle(phone.sync.useSyncStore.getState().setupSync(OTHER_CODE))
    expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(0)
  })

  it('a pending edit survives a Disconnect and reconnect while the other device edited another field', async () => {
    const start = [expense('e1', { amount: 10 })]
    const phone = await bootDevice({ expenses: start })
    const laptop = await bootDevice({ expenses: start })
    relay().latency = { pull: 500, push: 500, realtime: 100 }
    await connect(phone)
    await connect(laptop)
    await advance(20_000)

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline'))
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 71 })
    await advance(1000)
    laptop.expense.useExpenseStore.getState().updateExpense('e1', { notes: 'laptop' })
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))
    phone.sync.useSyncStore.getState().disconnectSync() // before its own cycle lands
    await advance(30_000) // the laptop's newer notes edit reaches the relay
    await settle(phone.sync.useSyncStore.getState().setupSync(SYNC_CODE), 5000)
    await advance(60_000)

    for (const device of [phone, laptop]) {
      const e1 = device.expense.useExpenseStore.getState().expenses.find((e) => e.id === 'e1')
      expect(e1).toMatchObject({ amount: 71, notes: 'laptop' })
    }
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
