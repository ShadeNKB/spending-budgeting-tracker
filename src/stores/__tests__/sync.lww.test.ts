// Whole-record last-writer-wins on the v4 wire (contract §12.3, as amended for PR-0):
// - an edit made after seeing the other device's copy always wins, whatever the clocks say
//   (forward stamps), and a stale copy on the relay never reverts it;
// - edits of different records never interfere, however they overlap;
// - two devices editing the SAME record before either has seen the other's edit keep only the
//   later record (known v4 limit: one stamp per record; v5 merges per field);
// - undo is a forward write (F-011), v5 records pass through untouched (§10.2), and a save that
//   changes nothing is no edit (AC-12 to AC-16).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format, parseISO, subDays } from 'date-fns'
import type { Expense } from '../../types'
import { contentKey } from '../../services/syncService'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  loadDevice,
  payloadOf,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  seedRow,
  setClientOffline,
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
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

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
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

const S = (d: Device) => d.expense.useExpenseStore.getState()
const rowOf = (device: Device, id: string): Expense | undefined =>
  S(device).expenses.find((e) => e.id === id)

const isRow = (r: unknown): r is Record<string, unknown> => typeof r === 'object' && r !== null

function relayRow(id: string): Record<string, unknown> | undefined {
  return relayRows().find((r): r is Record<string, unknown> => isRow(r) && r.id === id)
}

/** The writer stamp of another v0.8.5 device. */
const v085 = (rev: string) => ({ wr: { app: '0.8.5', dev: 'aaaaaa', rev, at: '' } })

const iso = (ms: number) => new Date(ms).toISOString()

/** Runs `write` as a device whose clock is `skew` ms off (its stamps carry the skew). */
function withClock(skew: number, write: () => void): void {
  const now = Date.now()
  vi.setSystemTime(now + skew)
  try {
    write()
  } finally {
    vi.setSystemTime(now)
  }
}

function expectConverged(...devices: Device[]): void {
  const key = contentKey(rowPayload(SYNC_CODE))
  for (const d of devices) expect(contentKey(S(d).exportBackup())).toBe(key)
}

async function expectQuiet(ms = 10 * MINUTE): Promise<void> {
  const upserts = relay().upserts
  await advance(ms)
  expect(relay().upserts).toBe(upserts)
}

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

interface Pair {
  phone: Device
  laptop: Device
  phoneClient: number
  laptopClient: number
}

/** Phone and laptop, both holding e1 (Lunch, 4.5) and e2 (Kopi, 1.5), in sync. */
async function pair(latency = { pull: 200, push: 200, realtime: 50 }): Promise<Pair> {
  const start = () => [
    expense('e1', { itemName: 'Lunch', amount: 4.5 }),
    expense('e2', { itemName: 'Kopi', amount: 1.5 }),
  ]
  const phone = await bootDevice({ expenses: start() })
  const laptop = await bootDevice({ expenses: start() })
  relay().latency = latency
  const phoneClient = relay().nextClient
  await connect(phone)
  const laptopClient = relay().nextClient
  await connect(laptop)
  await advance(10_000)
  return { phone, laptop, phoneClient, laptopClient }
}

describe('edits of different records never interfere', () => {
  it.each([0, 100, 250, 400, 700, 1500, 3000, 6000])(
    'the phone edits e1 and the laptop edits e2 %i ms later: both survive everywhere',
    async (gap) => {
      const { phone, laptop } = await pair()
      S(phone).updateExpense('e1', { amount: 45 })
      await advance(gap)
      S(laptop).updateExpense('e2', { notes: 'with Wei Jie' })
      await advance(MINUTE)

      for (const d of [phone, laptop]) {
        expect(rowOf(d, 'e1')).toMatchObject({ amount: 45 })
        expect(rowOf(d, 'e2')).toMatchObject({ notes: 'with Wei Jie' })
      }
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )

  it('both devices edit offline and come back online at the same moment', async () => {
    const p = await pair()
    setClientOffline(p.phoneClient, true)
    setClientOffline(p.laptopClient, true)
    S(p.phone).updateExpense('e1', { amount: 45 })
    S(p.laptop).updateExpense('e2', { amount: 2 })
    const added = S(p.laptop).addExpense({ itemName: 'Teh', amount: 1.2 })
    await advance(30_000)
    setClientOffline(p.phoneClient, false)
    setClientOffline(p.laptopClient, false)
    await advance(2 * MINUTE)

    for (const d of [p.phone, p.laptop]) {
      expect(rowOf(d, 'e1')?.amount).toBe(45)
      expect(rowOf(d, 'e2')?.amount).toBe(2)
      expect(rowOf(d, added.id)).toBeDefined()
    }
    expectConverged(p.phone, p.laptop)
    await expectQuiet()
  })

  it.each([6000, 10_000, 14_000])(
    'a stale push from the other device that lands %i ms after ours reverts nothing',
    async (slow) => {
      const p = await pair()
      // The laptop pulls, then edits e2; its upload is slow and lands after the phone's push.
      relay().pushLatencyFor = (client) => (client === p.laptopClient ? 2 * slow : undefined)
      S(p.laptop).updateExpense('e2', { notes: 'laptop' })
      void p.laptop.sync.useSyncStore.getState().triggerSync()
      await advance(300) // the laptop has pulled; its push is on the wire
      S(p.phone).updateExpense('e1', { amount: 45 })
      void p.phone.sync.useSyncStore.getState().triggerSync()
      await advance(2000)
      expect(relayRow('e1')).toMatchObject({ amount: 45 })
      relay().pushLatencyFor = null
      await advance(slow + MINUTE)

      for (const d of [p.phone, p.laptop]) {
        expect(rowOf(d, 'e1')).toMatchObject({ amount: 45 })
        expect(rowOf(d, 'e2')).toMatchObject({ notes: 'laptop' })
      }
      expect(relayRow('e1')).toMatchObject({ amount: 45 })
      expectConverged(p.phone, p.laptop)
      await expectQuiet()
    },
  )
})

describe('an edit made after seeing the other copy always wins', () => {
  it('ABA: the phone sets 20, the laptop sees it and sets 10 back; 10 stays everywhere', async () => {
    const { phone, laptop } = await pair()
    S(phone).updateExpense('e1', { amount: 20 })
    await advance(MINUTE)
    expect(rowOf(laptop, 'e1')?.amount).toBe(20)
    S(laptop).updateExpense('e1', { amount: 10 })
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(rowOf(d, 'e1')?.amount).toBe(10)
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each([
    ['a day behind', -DAY],
    ['a day ahead', DAY],
  ])('on a device whose clock runs %s', async (_label, skew) => {
    const { phone, laptop } = await pair()
    withClock(-skew, () => S(laptop).updateExpense('e1', { notes: 'laptop' }))
    await advance(MINUTE)
    expect(rowOf(phone, 'e1')?.notes).toBe('laptop')
    withClock(skew, () => S(phone).updateExpense('e1', { amount: 45 }))
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(rowOf(d, 'e1')).toMatchObject({ amount: 45, notes: 'laptop' })
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('a v0.8.5 peer pushing a stale merge cannot revert it', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    const stale = rowPayload(SYNC_CODE)
    S(phone).updateExpense('x', { notes: 'N1' })
    await advance(15_000)
    expect(relayRow('x')).toMatchObject({ notes: 'N1' })

    writeAsOther(SYNC_CODE, { ...(isRow(stale) ? stale : {}), ...v085('r-stale') })
    await advance(MINUTE)

    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1' })
    expect(relayRow('x')).toMatchObject({ notes: 'N1' })
  })

  it('a v0.8.4 device pushing a stale copy cannot revert it', async () => {
    const phone = await bootDevice({ expenses: [expense('x', { notes: 'N0', amount: 1 })] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    const stale = rowPayload(SYNC_CODE)
    S(phone).updateExpense('x', { notes: 'N1' })
    await advance(5000)
    writeAsLegacy(SYNC_CODE, isRow(stale) ? stale : {})
    await advance(MINUTE)

    expect(rowOf(phone, 'x')).toMatchObject({ notes: 'N1' })
    expect(relayRow('x')).toMatchObject({ notes: 'N1' })
  })

  it('an edit made while the saved code reconnects at start-up reaches the relay', async () => {
    const x = expense('x', { notes: 'N0', amount: 1 })
    // The laptop's notes edit reached the relay a minute ago; this device has not seen it.
    seedRow(SYNC_CODE, payloadOf([{ ...x, notes: 'N1', updatedAt: iso(NOW - MINUTE) }]))
    const phone = await loadDevice()
    phone.expense.useExpenseStore.setState({ hydrated: true, expenses: [x] })
    localStorage.setItem('syncId', SYNC_CODE)
    // The owner edits before sync starts with the saved code (the engine loads).
    S(phone).updateExpense('x', { amount: 2 })
    phone.sync.installSync()
    await advance(10_000)

    // Its record is the later one: it wins whole (the laptop's notes were concurrent).
    expect(rowOf(phone, 'x')).toMatchObject({ amount: 2, notes: 'N0' })
    expect(relayRow('x')).toMatchObject({ amount: 2, notes: 'N0' })
  })
})

describe('concurrent edits of the same record keep the later record (known v4 limit)', () => {
  it('different fields: the later record wins whole, on both devices, then quiet', async () => {
    const { phone, laptop } = await pair()
    S(phone).updateExpense('e1', { amount: 45 })
    await advance(10) // before either has pulled the other's edit
    S(laptop).updateExpense('e1', { notes: 'with Wei Jie' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(rowOf(d, 'e1')).toMatchObject({ amount: 4.5, notes: 'with Wei Jie' })
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('the same field: the later value wins on both devices', async () => {
    const { phone, laptop } = await pair()
    S(phone).updateExpense('e1', { amount: 45 })
    await advance(1000)
    S(laptop).updateExpense('e1', { amount: 46 })
    void laptop.sync.useSyncStore.getState().triggerSync() // the laptop pushes first
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(rowOf(d, 'e1')?.amount).toBe(46)
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('a tie on equal stamps goes to the same copy on both devices', async () => {
    const { phone, laptop } = await pair()
    S(phone).updateExpense('e1', { amount: 45 })
    S(laptop).updateExpense('e1', { amount: 46 }) // the same millisecond
    expect(rowOf(phone, 'e1')?.updatedAt).toBe(rowOf(laptop, 'e1')?.updatedAt)
    await advance(MINUTE)

    expect(rowOf(phone, 'e1')).toEqual(rowOf(laptop, 'e1'))
    expectConverged(phone, laptop)
    await expectQuiet()
  })
})

/**
 * Date.parse as measured on WebKit (iOS Safari): ISO-shaped text only, upper-case T and Z, a
 * real calendar day. Chromium (and Node) also read "2026-10-19t08:00:00z" and "2026-11-31".
 */
function webkitDateParse(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text)
  if (!m) return Number.NaN
  const month = Number(m[2])
  const day = Number(m[3])
  const days = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > days) return Number.NaN
  return new Date(text).getTime()
}

describe('a laptop (Chromium) and a phone (WebKit) order every stamp alike', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/stamps')
  })

  /** The laptop runs as is; the phone's whole module graph reads stamps under WebKit's Date.parse. */
  async function laptopAndPhone() {
    const start = () => [
      expense('x1', { amount: 5, updatedAt: '2026-10-10T00:00:00.000Z' }),
      expense('x2'),
    ]
    relay().latency = { pull: 200, push: 300, realtime: 100 }
    const laptop = await bootDevice({ expenses: start() })
    await connect(laptop)
    vi.doMock('../../lib/stamps', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../lib/stamps')>()
      return {
        ...real,
        stampMs: (value: unknown) => {
          const parse = vi.spyOn(Date, 'parse').mockImplementation(webkitDateParse)
          try {
            return real.stampMs(value)
          } finally {
            parse.mockRestore()
          }
        },
      }
    })
    const phoneClient = relay().nextClient
    const phone = await bootDevice({ expenses: start() })
    await connect(phone)
    await advance(30_000)
    return { laptop, phone, phoneClient }
  }

  it.each(['2026-10-19t08:00:00z', '2026-11-31T08:00:00.000Z', '2026-10-19T08:00:00.000z'])(
    'a relay copy stamped %s keeps one copy on both devices, then quiet',
    async (stamp) => {
      const { laptop, phone, phoneClient } = await laptopAndPhone()
      await expectQuiet(MINUTE)
      // The phone is in a lift; another writer puts such a copy of x1 on the relay, and the
      // laptop reads it first.
      setClientOffline(phoneClient, true)
      const relayed = rowPayload(SYNC_CODE)
      if (!isRow(relayed) || !Array.isArray(relayed.expenses)) throw new Error('no relay row')
      const rows: readonly unknown[] = relayed.expenses
      writeAsOther(SYNC_CODE, {
        ...relayed,
        ...v085('other'),
        expenses: rows.map((r) =>
          isRow(r) && r.id === 'x1' ? { ...r, amount: 6, updatedAt: stamp } : r,
        ),
      })
      await advance(5000)
      setClientOffline(phoneClient, false)
      window.dispatchEvent(new Event('online'))
      await advance(2 * MINUTE)

      // An unreadable stamp loses to a real one on both: x1 stays the stamped copy.
      expect(rowOf(laptop, 'x1')?.amount).toBe(5)
      expect(rowOf(phone, 'x1')?.amount).toBe(5)
      expectConverged(laptop, phone)
      await expectQuiet()
    },
  )
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

    S(phone).addExpense({ itemName: 'Kopi', amount: 1.5 })
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
    S(phone).deleteExpense('e1')
    await advance(4500) // the delete syncs to the laptop, inside the 5 s undo window
    expect(rowOf(laptop, 'e1')).toBeUndefined()

    const entry = S(phone).undoStack.find((u) => u.id.startsWith('del-e1'))
    S(phone).consumeUndo(entry?.id ?? '')
    await advance(10_000)

    for (const device of [phone, laptop]) {
      const revived = S(device).expenses.filter((e) => e.itemName === 'Lunch')
      expect(revived).toHaveLength(1)
      expect(revived[0]?.id).not.toBe('e1')
      expect(revived[0]?.createdAt).toBe(original?.createdAt)
      expect(S(device).deletedIds).toContain('e1')
    }
  })

  it('edit 4.5 -> 45, sync, undo, sync: 4.5 on both devices with a later stamp', async () => {
    const { phone, laptop } = await pair()
    S(phone).updateExpense('e1', { amount: 45 })
    await advance(4500) // synced to the laptop, inside the 5 s undo window
    expect(rowOf(laptop, 'e1')?.amount).toBe(45)
    const editStamp = rowOf(phone, 'e1')?.updatedAt ?? ''

    const entry = S(phone).undoStack.find((u) => u.id.startsWith('update-e1'))
    S(phone).consumeUndo(entry?.id ?? '')
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
    S(phone).updateExpense('e1', {
      itemName: 'Lunch',
      amount: 4.5,
      category: 'Other',
      notes: undefined,
    })
    await advance(10_000)
    expect(rowOf(phone, 'e1')).toBe(e1)
    expect(S(phone).undoStack).toEqual([])
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
  })

  it('saving a quick-add row from the edit sheet with nothing changed is a no-op', async () => {
    // The sheet sends the shown day as local noon; the row holds the moment it was added.
    const quick = expense('q', { date: '2026-10-19T01:13:00.000Z' })
    const phone = await bootDevice({ expenses: [quick] })
    await connect(phone)
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    S(phone).updateExpense('q', sheetPatch(quick))
    await advance(10_000)
    expect(rowOf(phone, 'q')).toBe(quick)
    expect(S(phone).undoStack).toEqual([])
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before)
  })

  it('a date moved to another day through the sheet is an edit, stored as local noon', async () => {
    const quick = expense('q', { date: '2026-10-19T01:13:00.000Z' })
    const phone = await bootDevice({ expenses: [quick] })
    const dayBefore = format(subDays(parseISO(quick.date), 1), 'yyyy-MM-dd')
    S(phone).updateExpense('q', sheetPatch(quick, { day: dayBefore }))
    expect(rowOf(phone, 'q')).toMatchObject({
      date: new Date(`${dayBefore}T12:00:00`).toISOString(),
      updatedAt: iso(NOW),
    })
  })

  it('stamps an edit strictly after a copy whose stamp is ahead of this clock', async () => {
    const ahead = '2026-10-20T08:00:00.000Z' // a day ahead of this device
    const phone = await bootDevice({ expenses: [expense('e1', { updatedAt: ahead })] })
    S(phone).updateExpense('e1', { amount: 9 })
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
