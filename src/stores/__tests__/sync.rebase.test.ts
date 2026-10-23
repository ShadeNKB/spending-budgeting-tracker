// Concurrent field edits (contract §12.3 rows 4 and 5), undo as a forward write (F-011),
// v5 records passing through a v0.8.5 merge (§10.2), and no-op edits (AC-11 to AC-15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format, parseISO, subDays } from 'date-fns'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  loadDevice,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  stubRelayEnv,
  writeAsLegacy,
  writeAsOther,
  type Device,
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
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const rowOf = (device: Device, id: string): Expense | undefined =>
  device.expense.useExpenseStore.getState().expenses.find((e) => e.id === id)

function relayRow(id: string): Record<string, unknown> | undefined {
  return relayRows().find(
    (r): r is Record<string, unknown> =>
      typeof r === 'object' && r !== null && 'id' in r && r.id === id,
  )
}

const isRow = (r: unknown): r is Record<string, unknown> => typeof r === 'object' && r !== null

/** The relay payload right now, with `row` in place of the expense that has its id. */
function relayWith(row: Expense, over: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = rowPayload(SYNC_CODE)
  return {
    ...(isRow(payload) ? payload : {}),
    expenses: [row, ...relayRows().filter((r) => !(isRow(r) && r.id === row.id))],
    ...over,
  }
}

/** The writer stamp of another v0.8.5 device, built on the relay copies named in `seen`. */
const v085 = (rev: string, seen: string[] = []) => ({
  wr: { app: '0.8.5', dev: 'aaaaaa', rev, at: new Date().toISOString(), seen },
})

/** The rev of the push the relay holds. */
function relayRev(): string {
  const payload = rowPayload(SYNC_CODE)
  const wr = isRow(payload) ? payload.wr : undefined
  return isRow(wr) && typeof wr.rev === 'string' ? wr.rev : ''
}

const iso = (ms: number) => new Date(ms).toISOString()

const DAY = 24 * 60 * 60_000

/** What EditExpenseSheet sends on save: every field, and the shown day as local noon. */
function sheetPatch(
  e: Expense,
  change: { day?: string; notes?: string; amount?: number } = {},
): Partial<Expense> {
  const day = change.day ?? format(parseISO(e.date), 'yyyy-MM-dd')
  return {
    itemName: e.itemName.trim(),
    amount: change.amount ?? e.amount,
    category: e.category,
    date: new Date(`${day}T12:00:00`).toISOString(),
    notes: (change.notes ?? e.notes ?? '').trim() || undefined,
  }
}

/** Phone and laptop, both holding e1 (Lunch, 4.5) and in sync. */
async function pair(): Promise<{ phone: Device; laptop: Device }> {
  const start = [expense('e1', { itemName: 'Lunch', amount: 4.5 })]
  const phone = await bootDevice({ expenses: start })
  const laptop = await bootDevice({ expenses: start })
  relay().latency = { pull: 200, push: 200, realtime: 50 }
  await connect(phone)
  await connect(laptop)
  await advance(10_000)
  return { phone, laptop }
}

describe('concurrent edits of different fields both survive (AC-11)', () => {
  it('row 4: the laptop edits notes later; the phone keeps its pending amount edit', async () => {
    const { phone, laptop } = await pair()
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 }) // T1, pending
    await advance(10)
    laptop.expense.useExpenseStore.getState().updateExpense('e1', { notes: 'with Wei Jie' }) // T2
    void laptop.sync.useSyncStore.getState().triggerSync() // the laptop pushes first
    await advance(20_000)

    for (const device of [phone, laptop]) {
      expect(rowOf(device, 'e1')).toMatchObject({ amount: 45, notes: 'with Wei Jie' })
    }
    expect(relayRow('e1')).toMatchObject({ amount: 45, notes: 'with Wei Jie' })
  })

  it("row 5: the phone's edit is newer but was made before it saw the laptop's notes", async () => {
    const { phone, laptop } = await pair()
    laptop.expense.useExpenseStore.getState().updateExpense('e1', { notes: 'with Wei Jie' }) // T2
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(150) // the laptop's push is on the wire; the phone has not pulled it
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 }) // T3 > T2
    await advance(20_000)

    for (const device of [phone, laptop]) {
      expect(rowOf(device, 'e1')).toMatchObject({ amount: 45, notes: 'with Wei Jie' })
    }
    expect(relayRow('e1')).toMatchObject({ amount: 45, notes: 'with Wei Jie' })
  })

  it('acknowledges pending edits only when the other device builds on the landed push', async () => {
    const { phone, laptop } = await pair()
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 })
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)
    relay().latency.push = 5000
    void phone.sync.useSyncStore.getState().triggerSync()
    await advance(1000) // pulled, merged, push in flight
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)
    await advance(5000) // landed: still pending, a stale peer push could land over it
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)
    await advance(20_000) // the laptop adopted it, the check pulled: still nothing proves it
    expect(rowOf(laptop, 'e1')?.amount).toBe(45)
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(true)

    relay().latency.push = 200
    laptop.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(20_000) // the laptop's push names the phone's
    expect(phone.expense.pendingEditsSnapshot().edits.has('e1')).toBe(false)
    expect(rowOf(phone, 'e1')?.amount).toBe(45)
  })

  it("the edit sheet's full patch on a quick-add row keeps the other device's date change", async () => {
    // A quick add stores the moment of the add as its date, not local noon; the sheet always
    // sends the shown day as local noon. That is no date edit, so it must not override one.
    const quick = expense('q', { date: '2026-10-18T01:13:00.000Z' })
    const phone = await bootDevice({ expenses: [quick] })
    const laptop = await bootDevice({ expenses: [quick] })
    relay().latency = { pull: 200, push: 200, realtime: 50 }
    await connect(phone)
    await connect(laptop)
    await advance(10_000)
    const dayBefore = format(subDays(parseISO(quick.date), 1), 'yyyy-MM-dd')

    // The laptop moves the expense a day back and pushes; the phone has not pulled it yet.
    laptop.expense.useExpenseStore
      .getState()
      .updateExpense('q', sheetPatch(quick, { day: dayBefore }))
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(150)
    // The phone adds a note through the sheet; its date field still shows the old day.
    phone.expense.useExpenseStore
      .getState()
      .updateExpense('q', sheetPatch(quick, { notes: 'with Wei Jie' }))
    await advance(20_000)

    for (const row of [rowOf(phone, 'q'), rowOf(laptop, 'q'), relayRow('q')]) {
      expect(row).toMatchObject({ notes: 'with Wei Jie' })
      expect(format(parseISO(String(row?.date)), 'yyyy-MM-dd')).toBe(dayBefore)
    }
  })

  it("stamps the rebased record after the other device's copy when this clock is a day behind", async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 }) // pending, ~NOW
    // The laptop's clock runs a day ahead: its notes edit is stamped tomorrow.
    const laptopStamp = iso(Date.now() + DAY)
    writeAsOther(
      SYNC_CODE,
      relayWith(expense('x', { notes: 'N1', amount: 1, updatedAt: laptopStamp }), v085('r-lap')),
    )
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ amount: 2, notes: 'N1' })
    const onRelay = relayRow('x')
    expect(onRelay).toMatchObject({ amount: 2, notes: 'N1' })
    // The laptop adopts the relay copy only if it is strictly newer than its own.
    expect(Date.parse(String(onRelay?.updatedAt))).toBeGreaterThan(Date.parse(laptopStamp))
  })

  it('keeps an edit made while the saved code reconnects at start-up pending', async () => {
    const x = expense('x', { notes: 'N0', amount: 1 })
    // The laptop's notes edit reached the relay a minute ago.
    seedRow(
      SYNC_CODE,
      payloadOf([{ ...x, notes: 'N1', updatedAt: iso(NOW - 60_000) }], v085('r-laptop')),
    )
    const phone = await loadDevice()
    phone.expense.useExpenseStore.setState({ hydrated: true, expenses: [x] })
    localStorage.setItem('syncId', SYNC_CODE)
    // The owner edits the amount before sync starts with the saved code (the engine loads).
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 })
    phone.sync.installSync()
    await advance(10_000)

    expect(rowOf(phone, 'x')).toMatchObject({ amount: 2, notes: 'N1' })
    expect(relayRow('x')).toMatchObject({ amount: 2, notes: 'N1' })
  })
})

// There is no compare-and-set on the v4 wire, so the relay can hold a copy older than the one
// a pending edit was made on. Rebasing onto it would revert data plain last-writer-wins keeps.
describe('the rebase adds only news: a relay copy no newer than the edit base changes nothing', () => {
  it('a v0.8.5 peer pushing a stale merge cannot revert an acknowledged edit', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    const stale = rowPayload(SYNC_CODE)
    phone.expense.useExpenseStore.getState().updateExpense('x', { notes: 'N1' })
    await advance(15_000)
    expect(relayRow('x')).toMatchObject({ notes: 'N1' })
    // Another device built on the phone's push: the edit is acknowledged.
    const landed = rowPayload(SYNC_CODE)
    writeAsOther(SYNC_CODE, { ...(isRow(landed) ? landed : {}), ...v085('r-built', [relayRev()]) })
    await advance(5000)
    expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(0)

    // A peer's merge of a pull that predates the phone's push lands over it.
    writeAsOther(SYNC_CODE, { ...(isRow(stale) ? stale : {}), ...v085('r-other') })
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 }) // pending
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1', amount: 2 })
    expect(relayRow('x')).toMatchObject({ notes: 'N1', amount: 2 })
  })

  it('a v0.8.4 device pushing a stale copy cannot revert an acknowledged edit', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    const stale = rowPayload(SYNC_CODE)
    phone.expense.useExpenseStore.getState().updateExpense('x', { notes: 'N1' })
    await advance(5000)
    writeAsLegacy(SYNC_CODE, isRow(stale) ? stale : {})
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 }) // pending
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1', amount: 2 })
    expect(relayRow('x')).toMatchObject({ notes: 'N1', amount: 2 })
  })

  it("an old device's re-file at the same stamp is not adopted over a pending edit (§12.3 row 23)", async () => {
    const T = '2026-10-10T00:00:00.000Z'
    const mine = expense('x', { itemName: 'Kitchen towel', category: 'Other', updatedAt: T })
    const phone = await bootDevice({ expenses: [mine] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 9 }) // pending
    // v0.8.4 re-files by keyword without a stamp and pushes before the phone's next cycle.
    writeAsLegacy(SYNC_CODE, relayWith({ ...mine, category: 'Shopping' }))
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ amount: 9, category: 'Other' })
    expect(relayRow('x')).toMatchObject({ amount: 9, category: 'Other' })
  })

  it('the later edit of the same field wins on both devices (last writer wins)', async () => {
    const { phone, laptop } = await pair()
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 45 }) // T1, pending
    await advance(1000)
    laptop.expense.useExpenseStore.getState().updateExpense('e1', { amount: 46 }) // T2 > T1
    void laptop.sync.useSyncStore.getState().triggerSync() // the laptop pushes first
    await advance(20_000)

    expect(relayRow('e1')).toMatchObject({ amount: 46 })
    expect(rowOf(phone, 'e1')).toMatchObject({ amount: 46 })
    expect(rowOf(laptop, 'e1')).toMatchObject({ amount: 46 })
  })

  it('a copy older than one already merged here adds nothing, even before the push lands', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 }) // pending
    // The laptop's notes edit arrives and is merged here, but the phone's push fails.
    const laptopEdit = expense('x', { notes: 'N1', amount: 1, updatedAt: iso(Date.now() + 60_000) })
    writeAsOther(SYNC_CODE, relayWith(laptopEdit, v085('r-laptop')))
    failNext('push', { status: 503 })
    await advance(1000)
    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1', amount: 2 })
    expect(relayRow('x')).toMatchObject({ notes: 'N1', amount: 1 })

    // A third writer lands a copy older than the laptop's but newer than the phone's base.
    const older = expense('x', { notes: 'Nx', amount: 1, updatedAt: iso(Date.now() - 60_000) })
    writeAsOther(SYNC_CODE, relayWith(older, v085('r-stale')))
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1', amount: 2 })
    expect(relayRow('x')).toMatchObject({ notes: 'N1', amount: 2 })
  })

  it('keeps the edit stamp when the relay copy adds nothing to it (no needless re-stamp)', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 })
    const stamp = rowOf(phone, 'x')?.updatedAt
    // Another device touched the record without changing it (an edit and its undo).
    const touched = expense('x', { amount: 1, updatedAt: iso(Date.now() - 60_000) })
    writeAsOther(SYNC_CODE, relayWith(touched, v085('r-touch')))
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ amount: 2, updatedAt: stamp })
    expect(relayRow('x')).toMatchObject({ amount: 2, updatedAt: stamp })
  })

  it("keeps the other device's notes when both devices set the same amount", async () => {
    const phone = await bootDevice({ expenses: [expense('x', { amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    phone.expense.useExpenseStore.getState().updateExpense('x', { amount: 2 }) // newer, pending
    const theirs = expense('x', { amount: 2, notes: 'N1', updatedAt: iso(Date.now() - 60_000) })
    writeAsOther(SYNC_CODE, relayWith(theirs, v085('r-same')))
    await advance(20_000)

    expect(rowOf(phone, 'x')).toMatchObject({ amount: 2, notes: 'N1' })
    expect(relayRow('x')).toMatchObject({ amount: 2, notes: 'N1' })
    expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(0)
  })
})

describe('v5 records keep their fields through a v0.8.5 merge and push (AC-12)', () => {
  it('round-trips day, fs, h and unknown fields, and never emits x5', async () => {
    const v5row = {
      ...expense('v1', { itemName: 'Chicken rice', amount: 4.5 }),
      day: '2026-10-01',
      fs: [1792345600000, 0, 0],
      h: 'k3f9x2',
      kind: 'future-field',
    }
    seedRow(
      SYNC_CODE,
      payloadOf([v5row], { x5: { schema: 5, minor: 0, min: 4, dev: 'k3f9x2', rev: 'abc' } }),
    )
    const phone = await bootDevice()
    await connect(phone)
    expect(rowOf(phone, 'v1')).toMatchObject({
      day: '2026-10-01',
      fs: [1792345600000, 0, 0],
      h: 'k3f9x2',
      kind: 'future-field',
    })

    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(5000)
    expect(relayRows()).toHaveLength(2)
    expect(relayRow('v1')).toEqual(v5row)
    expect(rowPayload(SYNC_CODE)).not.toHaveProperty('x5')
  })
})

describe('undo is a forward write and sticks (AC-13, AC-14)', () => {
  it('delete, sync, undo, sync: live on both devices under a new id; the old id stays dead', async () => {
    const { phone, laptop } = await pair()
    const original = rowOf(phone, 'e1')
    const store = phone.expense.useExpenseStore
    store.getState().deleteExpense('e1')
    await advance(4500) // the delete syncs to the laptop, inside the 5 s undo window
    expect(rowOf(laptop, 'e1')).toBeUndefined()

    const entry = store.getState().undoStack.find((u) => u.id.startsWith('del-e1'))
    store.getState().consumeUndo(entry?.id ?? '')
    await advance(10_000)

    for (const device of [phone, laptop]) {
      const state = device.expense.useExpenseStore.getState()
      const revived = state.expenses.filter((e) => e.itemName === 'Lunch')
      expect(revived).toHaveLength(1)
      expect(revived[0]?.id).not.toBe('e1')
      expect(revived[0]?.createdAt).toBe(original?.createdAt)
      expect(state.deletedIds).toContain('e1')
    }
  })

  it('edit 4.5 -> 45, sync, undo, sync: 4.5 on both devices with a later stamp', async () => {
    const { phone, laptop } = await pair()
    const store = phone.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    await advance(4500) // synced to the laptop, inside the 5 s undo window
    expect(rowOf(laptop, 'e1')?.amount).toBe(45)
    const editStamp = rowOf(phone, 'e1')?.updatedAt ?? ''

    const entry = store.getState().undoStack.find((u) => u.id.startsWith('update-e1'))
    store.getState().consumeUndo(entry?.id ?? '')
    await advance(10_000)

    for (const device of [phone, laptop]) {
      const e1 = rowOf(device, 'e1')
      expect(e1?.amount).toBe(4.5)
      expect(Date.parse(e1?.updatedAt ?? '')).toBeGreaterThan(Date.parse(editStamp))
    }
  })
})

describe('edits stamp forward (AC-15)', () => {
  it('saving with no changed field writes no stamp, no undo entry and no sync', async () => {
    const { phone } = await pair()
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    const e1 = rowOf(phone, 'e1')
    phone.expense.useExpenseStore
      .getState()
      .updateExpense('e1', { itemName: 'Lunch', amount: 4.5, category: 'Other', notes: undefined })
    await advance(10_000)
    expect(rowOf(phone, 'e1')).toBe(e1)
    expect(phone.expense.useExpenseStore.getState().undoStack).toEqual([])
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
  })

  it('saving a quick-add row from the edit sheet with nothing changed is a no-op', async () => {
    // The sheet sends the shown day as local noon; the row holds the moment it was added.
    const quick = expense('q', { date: '2026-10-19T01:13:00.000Z' })
    const phone = await bootDevice({ expenses: [quick] })
    await connect(phone)
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    phone.expense.useExpenseStore.getState().updateExpense('q', sheetPatch(quick))
    await advance(10_000)
    expect(rowOf(phone, 'q')).toBe(quick)
    expect(phone.expense.useExpenseStore.getState().undoStack).toEqual([])
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
  })

  it('a date moved to another day through the sheet is an edit, stored as local noon', async () => {
    const quick = expense('q', { date: '2026-10-19T01:13:00.000Z' })
    const phone = await bootDevice({ expenses: [quick] })
    const dayBefore = format(subDays(parseISO(quick.date), 1), 'yyyy-MM-dd')
    phone.expense.useExpenseStore
      .getState()
      .updateExpense('q', sheetPatch(quick, { day: dayBefore }))
    expect(rowOf(phone, 'q')?.date).toBe(new Date(`${dayBefore}T12:00:00`).toISOString())
    expect(phone.expense.pendingEditsSnapshot().edits.get('q')?.fields).toEqual(new Set(['date']))
  })

  it('stamps an edit strictly after a copy whose stamp is ahead of this clock', async () => {
    const ahead = '2026-10-20T08:00:00.000Z' // a day ahead of this device
    const phone = await bootDevice({ expenses: [expense('e1', { updatedAt: ahead })] })
    phone.expense.useExpenseStore.getState().updateExpense('e1', { amount: 9 })
    expect(Date.parse(rowOf(phone, 'e1')?.updatedAt ?? '')).toBeGreaterThan(Date.parse(ahead))
  })
})

describe('user categories survive a sync (F-015, AC-16)', () => {
  it('keeps every category exactly as filed, on both devices and on the relay', async () => {
    // v0.8.4 re-filed these by keyword on every sync (kit -> Shopping, github -> Subscriptions,
    // Education -> Subscriptions, Bills & Utilities -> Travel).
    const filed = [
      expense('k', { itemName: 'Kitchen towel', category: 'Other' }),
      expense('g', { itemName: 'GitHub shares', category: 'Investment' }),
      expense('s', { itemName: 'SQL course', category: 'Education' }),
      expense('p', { itemName: 'SP Group electricity', category: 'Bills & Utilities' }),
    ]
    const phone = await bootDevice({ expenses: filed })
    const laptop = await bootDevice()
    await connect(phone)
    await connect(laptop)
    await advance(10_000)

    for (const { id, category } of filed) {
      expect(rowOf(phone, id)?.category).toBe(category)
      expect(rowOf(laptop, id)?.category).toBe(category)
      expect(relayRow(id)?.category).toBe(category)
    }
  })
})
