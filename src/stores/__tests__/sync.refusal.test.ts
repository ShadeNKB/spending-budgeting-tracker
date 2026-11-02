// A remote mass removal this device cannot make restorable first (no room for the guard snapshot
// nor for the journal entry holding the removed records, §11.9, P2-20): the engine refuses the
// merge, the cycle says so in the engine's own words and pushes nothing, and the realtime payload
// that carried the removal is kept for the next cycle. That matters beside an old device, whose
// crossing push can take the removal off the relay before this device ever pulls it (P2-10): the
// event is then the only copy of it here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/backup'
import { REMOTE_SAFETY_COPY_ERROR } from '../../data/local/refusal'
import {
  MemoryStorage,
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  liveIds,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  stubRelayEnv,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const relayIds = (): string[] =>
  relayRows().flatMap((r) => (isRecord(r) && typeof r.id === 'string' ? [r.id] : []))

describe('a remote mass removal with no room for its safety copy', () => {
  it('is refused with nothing pushed, and its news is merged once there is room', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const storage = new MemoryStorage()
    const laptop = await bootDevice({ expenses: ids.map((id) => expense(id)), storage })
    await connect(laptop)
    const phone = await bootDevice({})
    await connect(phone)
    await advance(20_000)
    expect(liveIds(phone)).toEqual(ids)
    const before = relay().rows.get(SYNC_CODE)
    if (before === undefined) throw new Error('no relay row')

    // The laptop's storage cannot take the guard snapshot nor the journal entry.
    storage.refuse.add('st5:snap:*')
    storage.refuse.add('st5:journal')
    for (const id of ids) phone.expense.useExpenseStore.getState().deleteExpense(id)
    await advance(10_000)
    expect(relayIds()).toEqual([])
    expect(liveIds(laptop)).toEqual(ids)
    expect(laptop.sync.useSyncStore.getState().lastError?.message).toBe(REMOTE_SAFETY_COPY_ERROR)
    const upserts = relay().upserts

    // The phone goes into a pocket, and a crossing push puts the old copy back on the relay.
    phone.sync.useSyncStore.getState().disconnectSync()
    relay().rows.set(SYNC_CODE, { ...before, updated_at: new Date().toISOString() })
    await advance(60_000)
    expect(relay().upserts).toBe(upserts)
    expect(liveIds(laptop)).toEqual(ids)

    // Room again: the next cycle merges the payload the event carried and pushes the removal.
    storage.refuse.clear()
    await advance(120_000)
    expect(liveIds(laptop)).toEqual([])
    expect(relayIds()).toEqual([])
    expect(laptop.sync.useSyncStore.getState().lastError).toBeNull()
    // and the removal is restorable here: the toast's Undo has its journal entry
    const undo = laptop.ui.useUIStore
      .getState()
      .toasts.find((t) => t.message.includes('removed') && t.action !== undefined)
    expect(undo).toBeDefined()
  })
})
