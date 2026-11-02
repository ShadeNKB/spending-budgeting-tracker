// Join never creates (PR-3 track spec P3-5, P3-19, §3.7; AC-E5 to AC-E9, AC-E21): a joined code
// is not established until a cycle finds its relay copy, so a mistyped code writes nothing; the
// preview counts a merge and writes nothing anywhere; only an established device repairs or
// re-creates the relay copy; a newer writer is merged and never pushed over; a sync setup a
// newer build wrote pauses this one and is kept untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNC_CODE,
  MemoryStorage,
  advance,
  bootDevice,
  connect,
  dropRow,
  expense,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const MINUTE = 60_000
const JOINED = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every key a device's storage holds. */
const keysOf = (d: { storage: { length: number; key: (i: number) => string | null } }) =>
  Array.from({ length: d.storage.length }, (_, i) => d.storage.key(i) ?? '')

/** Writes of any kind a device sent to the relay. */
const relayWrites = () =>
  relay().requests.filter(
    (r) => r.kind === 'upsert' || r.kind === 'insert' || r.kind === 'update' || r.kind === 'rpc',
  )

function config(d: Device): unknown {
  const raw = d.storage.getItem('st5:sync')
  if (raw === null) return null
  const parsed: unknown = JSON.parse(raw)
  return parsed
}

/** The laptop: links `code` with these entries, so its relay copy is a v5 one. */
async function laptopWith(code: string, rows: Parameters<typeof expense>[0][]): Promise<Device> {
  const laptop = await bootDevice({ expenses: rows.map((id) => expense(id)) })
  await settle(laptop.sync.useSyncStore.getState().setupSync(code), 5000)
  return laptop
}

describe('previewJoin (AC-E21): exact counts, nothing written', () => {
  async function preview(d: Device, code = JOINED) {
    const engine = await d.sync.loadSyncEngine()
    return settle(engine.previewJoin(code))
  }

  it('an empty device joining three synced entries', async () => {
    const laptop = await laptopWith(JOINED, ['a1', 'a2', 'a3'])
    laptop.sync.useSyncStore.getState().disconnectSync()
    const phone = await bootDevice({ expenses: [] })
    expect(await preview(phone)).toEqual({
      kind: 'found',
      here: 0,
      synced: 3,
      after: 3,
      removed: 0,
      unreadable: 0,
    })
  })

  it('an existing relay copy with no entries is found, never "not found"', async () => {
    seedRow(JOINED, payloadOf([]))
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
    expect(await preview(phone)).toEqual({
      kind: 'found',
      here: 2,
      synced: 0,
      after: 2,
      removed: 0,
      unreadable: 0,
    })
  })

  it('overlapping data counts each entry once', async () => {
    seedRow(JOINED, payloadOf([expense('e2'), expense('e3')]))
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
    expect(await preview(phone)).toMatchObject({ here: 2, synced: 2, after: 3, removed: 0 })
  })

  it('counts the entries here that the relay copy deleted, and the relay rows it cannot read', async () => {
    seedRow(
      JOINED,
      payloadOf([expense('e3'), { id: 'bad1', itemName: 'Broken', amount: 'abc' }], {
        deletedIds: ['e1'],
      }),
    )
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
    expect(await preview(phone)).toEqual({
      kind: 'found',
      here: 2,
      synced: 1,
      after: 2,
      removed: 1,
      unreadable: 1,
    })
  })

  it('answers not-found, newer, unreadable, offline and an invalid code without reading anything else', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    expect(await preview(phone)).toEqual({ kind: 'not-found' })
    seedRow(JOINED, { ...payloadOf([]), x5: { schema: 9, minor: 0, min: 9, dig: 'x' } })
    expect(await preview(phone)).toEqual({ kind: 'newer' })
    seedRow(JOINED, { hello: 'not a SpendTrack copy' })
    expect(await preview(phone)).toEqual({ kind: 'unreadable' })
    expect(await preview(phone, 'not-a-code')).toMatchObject({
      kind: 'failed',
      result: { ok: false, error: 'invalid' },
    })
    const pulls = relay().pulls
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await preview(phone)).toMatchObject({
      kind: 'failed',
      result: { ok: false, error: 'offline' },
    })
    expect(relay().pulls).toBe(pulls)
  })

  it('writes nothing locally or remotely, subscribes nothing and saves no code', async () => {
    seedRow(JOINED, payloadOf([expense('e9')], { deletedIds: ['e1'] }))
    const storage = new MemoryStorage()
    const phone = await bootDevice({ expenses: [expense('e1')], storage })
    await advance(5000)
    const writes = storage.writes.length
    const requests = relay().requests.length
    await preview(phone)
    await advance(5000)
    expect(storage.writes.slice(writes)).toEqual([])
    expect(
      relay()
        .requests.slice(requests)
        .map((r) => r.kind),
    ).toEqual(['pull'])
    expect(relay().created).toHaveLength(0)
    expect(phone.sync.useSyncStore.getState().syncId).toBeNull()
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toEqual(['e1'])
  })
})

describe('AC-E5/E6: a join never creates the relay copy', () => {
  it('joining a code with no relay copy writes nothing, pauses not-found, keeps the code unestablished', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    const result = await settle(
      phone.sync.useSyncStore.getState().setupSync(JOINED, { join: true }),
      5000,
    )
    expect(result).toMatchObject({ ok: false, error: 'not-found' })
    expect(relayWrites()).toEqual([])
    expect(relay().rows.has(JOINED)).toBe(false)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      syncId: JOINED,
      cloudStatus: 'paused',
      lastError: { kind: 'not-found' },
    })
    expect(config(phone)).toMatchObject({ kind: 'plain', code: JOINED, established: false })

    // Polling keeps looking (and still writes nothing) …
    await advance(10 * MINUTE)
    expect(relayWrites()).toEqual([])
    // … and merges the copy once the other device creates it; this device is then established.
    seedRow(JOINED, payloadOf([expense('lap1', { itemName: 'From the laptop' })]))
    await advance(5 * MINUTE + 1000)
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('lap1')
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(config(phone)).toMatchObject({ established: true })
    expect(relayRows(JOINED).map((r) => (isObject(r) ? r.id : null))).toContain('e1')
  })

  it('a row that vanished after the preview: the joined device pauses, an established one re-creates', async () => {
    const laptop = await laptopWith(JOINED, ['a1'])
    const phone = await bootDevice({ expenses: [expense('e1')] })
    dropRow(JOINED) // pruned between the preview and Join
    const before = relayWrites().length
    expect(
      await settle(phone.sync.useSyncStore.getState().setupSync(JOINED, { join: true }), 5000),
    ).toMatchObject({ ok: false, error: 'not-found' })
    expect(relayWrites().length).toBe(before)
    // The laptop generated the code: it is established and puts its full copy back.
    expect(await settle(laptop.sync.useSyncStore.getState().triggerSync(), 5000)).toMatchObject({
      ok: true,
      pushed: true,
    })
    expect(relayRows(JOINED).map((r) => (isObject(r) ? r.id : null))).toContain('a1')
    // The joined device hears the copy appear, merges it, and only then writes (established).
    await advance(5000)
    expect(
      relayRows(JOINED)
        .map((r) => (isObject(r) ? r.id : null))
        .sort(),
    ).toEqual(['a1', 'e1'])
    expect(config(phone)).toMatchObject({ established: true })
  })

  it('a restart keeps a joined code unestablished, and still never creates its copy', async () => {
    const storage = new MemoryStorage()
    const phone = await bootDevice({ expenses: [expense('e1')], storage })
    await settle(phone.sync.useSyncStore.getState().setupSync(JOINED, { join: true }), 5000)
    // The app closes (what it saved stays: retiring the test device disconnects it, so the two
    // keys are put back as they were) and opens again: initSync sets the code up from storage.
    const saved = { cfg: storage.getItem('st5:sync') ?? '', code: storage.getItem('syncId') ?? '' }
    retireDevices()
    storage.setItem('st5:sync', saved.cfg)
    storage.setItem('syncId', saved.code)
    const again = await bootDevice({ storage, expenses: [expense('e1')] })
    await advance(5000)
    expect(again.sync.useSyncStore.getState()).toMatchObject({
      syncId: JOINED,
      cloudStatus: 'paused',
      lastError: { kind: 'not-found' },
    })
    expect(relayWrites()).toEqual([])
  })

  it('Generate is established from the start: its first cycle creates the copy', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    await connect(phone)
    expect(config(phone)).toMatchObject({ code: SYNC_CODE, established: true })
    expect(relayRows()).toHaveLength(1)
  })
})

describe('AC-E7: an unreadable relay copy', () => {
  const GARBAGE = { expenses: 'not a list', categories: 5 }

  it('is never pushed over by a joined device that has not synced with it', async () => {
    seedRow(JOINED, GARBAGE)
    const phone = await bootDevice({ expenses: [expense('e1')] })
    const result = await settle(
      phone.sync.useSyncStore.getState().setupSync(JOINED, { join: true }),
      5000,
    )
    expect(result).toMatchObject({ ok: false, error: 'invalid' })
    await advance(30 * MINUTE)
    expect(relayWrites()).toEqual([])
    expect(rowPayload(JOINED)).toEqual(GARBAGE)
  })

  it('is pushed over by an established device once its raw copy is kept, at most every 10 minutes', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    await connect(phone)
    writeAsOther(SYNC_CODE, GARBAGE)
    await advance(5000)
    expect(relayRows()).toHaveLength(1) // repaired from this device
    const kept = keysOf(phone).filter((k) => k.startsWith('st5:q:relay:'))
    expect(kept.length).toBeGreaterThan(0)
    const pushes = relay().pushes.length
    writeAsOther(SYNC_CODE, GARBAGE)
    await advance(5 * MINUTE)
    expect(relay().pushes.length).toBe(pushes) // not again within 10 minutes
  })
})

describe('AC-E8: a newer writer', () => {
  it('is merged and never pushed over: paused update-required', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    await connect(phone)
    const pushes = relay().pushes.length
    writeAsOther(SYNC_CODE, {
      ...payloadOf([expense('e1'), expense('n1', { itemName: 'From a newer SpendTrack' })]),
      x5: { schema: 6, minor: 0, min: 4, dig: 'x', dts: {}, ren: {}, mts: {}, pref: {} },
    })
    await advance(5000)
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('n1')
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'paused',
      lastError: { kind: 'update-required' },
    })
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10 * MINUTE)
    expect(relay().pushes.length).toBe(pushes)
  })
})

describe('AC-E9: a sync setup a newer SpendTrack wrote', () => {
  const NEWER = JSON.stringify({
    kind: 'e2e',
    code: 'ST5-INVENTED-0000000-0000000-0000000',
    rowId: 'invented-row',
    joinedAt: NOW - 1000,
    established: true,
  })

  it('pauses update-required, makes no request, leaves st5:sync as it is and keeps local data', async () => {
    const storage = new MemoryStorage()
    storage.setItem('st5:sync', NEWER)
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')], storage })
    await advance(10 * MINUTE)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      syncId: null,
      cloudStatus: 'paused',
      lastError: { kind: 'update-required' },
    })
    expect(phone.sync.useSyncStore.getState().lastError?.message).toContain('newer SpendTrack')
    expect(relay().requests).toEqual([])
    expect(relay().created).toEqual([])
    expect(storage.getItem('st5:sync')).toBe(NEWER)
    expect(storage.removes).not.toContain('st5:sync')
    expect(keysOf(phone).some((k) => k.startsWith('st5:q:st5:sync'))).toBe(false)
    expect(phone.expense.useExpenseStore.getState().expenses).toHaveLength(2)
    // a change made meanwhile is saved here and writes no outbox for a sync this build cannot run
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    expect(phone.expense.useExpenseStore.getState().unsyncedChanges()).toBe(0)
  })

  it('is removed only by an explicit Disconnect', async () => {
    const storage = new MemoryStorage()
    storage.setItem('st5:sync', NEWER)
    const phone = await bootDevice({ expenses: [expense('e1')], storage })
    await advance(1000)
    phone.sync.useSyncStore.getState().disconnectSync()
    expect(storage.getItem('st5:sync')).toBeNull()
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'off',
      lastError: null,
    })
  })
})
