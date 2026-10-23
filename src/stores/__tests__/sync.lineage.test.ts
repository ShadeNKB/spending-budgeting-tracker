// Pending changes (field edits, category names, item mappings) are acknowledged only when
// another device builds on the push that carried them: its push names ours in `wr.seen`, or
// holds exactly this device's state. A landed push, or our own copy read back, proves nothing:
// there is no compare-and-set on the v4 wire, so a push built on a pull taken before ours landed
// can still land over it, and whole-record last-writer-wins would then drop an edit everywhere.
// Scenarios ported from the round-3 data-safety review (overlap, earlyack, onlinetogether,
// abaoffline, pingpong60, slowpush, stalelists); each one lost data before this rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { isRecord } from '../../lib/backup'
import { SEEN_MAX, contentKey } from '../../services/syncService'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  stubRelayEnv,
  writeAsOther,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const LATENCY = { pull: 200, push: 200, realtime: 100 }

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

/** A real outage: the realtime socket drops with the network and re-subscribes after it. */
function outage(down: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: !down, configurable: true })
  dropRealtime(down)
  window.dispatchEvent(new Event(down ? 'offline' : 'online'))
}

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

const store = (d: Device) => d.expense.useExpenseStore
const S = (d: Device) => store(d).getState()
const rowOf = (d: Device, id: string): Expense | undefined => S(d).expenses.find((e) => e.id === id)
const liveIds = (d: Device): string[] => S(d).expenses.map((e) => e.id)
const pendingOf = (d: Device) => d.expense.pendingEditsSnapshot()

/** The relay copy's writer stamp. */
function relayWr(): { rev: string; seen: unknown[] } {
  const payload = rowPayload(SYNC_CODE)
  const wr = isRecord(payload) ? payload.wr : undefined
  if (!isRecord(wr) || typeof wr.rev !== 'string' || !Array.isArray(wr.seen)) {
    throw new Error('the relay copy has no v0.8.5 writer stamp')
  }
  return { rev: wr.rev, seen: wr.seen }
}

/** Both devices and the relay hold the same content. */
function expectConverged(a: Device, b: Device): void {
  const key = contentKey(S(a).exportBackup())
  expect(contentKey(S(b).exportBackup())).toBe(key)
  expect(contentKey(rowPayload(SYNC_CODE))).toBe(key)
}

async function expectQuiet(ms = 10 * MINUTE): Promise<void> {
  const upserts = relay().upserts
  await advance(ms)
  expect(relay().upserts).toBe(upserts)
}

interface Pair {
  laptop: Device
  phone: Device
  laptopClient: number
  phoneClient: number
}

/** Laptop and phone holding the same rows, connected and settled; each one's relay client id. */
async function pair(
  rows: () => Expense[],
  latency = LATENCY,
  lists?: { categories: string[]; categoryMappings: Record<string, string> },
): Promise<Pair> {
  const laptop = await bootDevice({ expenses: rows() })
  const phone = await bootDevice({ expenses: rows() })
  if (lists) for (const d of [laptop, phone]) store(d).setState(lists)
  relay().latency = latency
  const laptopClient = relay().nextClient
  await connect(laptop)
  const phoneClient = relay().nextClient
  await connect(phone)
  await advance(20_000)
  return { laptop, phone, laptopClient, phoneClient }
}

const oneRow = () => [expense('e1', { amount: 10 })]

/** The amount the laptop wrote and the notes the phone wrote, on both devices and the relay. */
function expectBothEdits(p: Pair): void {
  for (const d of [p.laptop, p.phone]) {
    expect(rowOf(d, 'e1')).toMatchObject({ amount: 20, notes: 'phone' })
  }
  expectConverged(p.laptop, p.phone)
}

describe('two devices edit different fields of one record, any overlap', () => {
  it.each([0, 100, 250, 400, 550, 700, 900, 1200, 1500, 2000, 3000])(
    'the laptop edits notes %i ms after the phone edits the amount: both survive everywhere',
    async (offset) => {
      const p = await pair(oneRow, { pull: 300, push: 300, realtime: 150 })
      S(p.phone).updateExpense('e1', { amount: 55 })
      await advance(offset)
      S(p.laptop).updateExpense('e1', { notes: 'laptop' })
      await advance(MINUTE)

      for (const device of [p.phone, p.laptop]) {
        expect(rowOf(device, 'e1')).toMatchObject({ amount: 55, notes: 'laptop' })
      }
      expectConverged(p.phone, p.laptop)
      await expectQuiet()

      // The relay copy's writer built on the other device's push, so the other device has
      // acknowledged its edit; the writer keeps its own until the other device builds on it.
      const writer = relay().pushes.at(-1)?.client === p.phoneClient ? p.phone : p.laptop
      const other = writer === p.phone ? p.laptop : p.phone
      expect(pendingOf(other).edits.size).toBe(0)
      S(other).addExpense({ itemName: 'Kopi', amount: 1.5 })
      await advance(MINUTE)
      expect(pendingOf(writer).edits.size).toBe(0)
      expect(rowOf(writer, 'e1')).toMatchObject({ amount: 55, notes: 'laptop' })
      expectConverged(p.phone, p.laptop)
    },
  )
})

describe('offline edits on both devices', () => {
  const five = () => ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => expense(id, { amount: 10 }))
  const slow = { pull: 500, push: 500, realtime: 100 }

  it('both come back online at the same moment: every edit survives', async () => {
    const { laptop, phone } = await pair(five, slow)
    setOnline(false)
    const before = { pulls: relay().pulls, upserts: relay().upserts }
    S(phone).updateExpense('e1', { amount: 55 })
    const phoneAdd = S(phone).addExpense({ itemName: 'phone offline add', amount: 4 })
    S(phone).deleteExpense('e2')
    await advance(5000)
    S(laptop).updateExpense('e1', { notes: 'laptop offline note' })
    const laptopAdd = S(laptop).addExpense({ itemName: 'laptop offline add', amount: 6 })
    S(laptop).deleteExpense('e3')
    S(laptop).updateExpense('e4', { amount: 44 })
    S(phone).deleteExpense('e4')
    await advance(20_000)
    expect({ pulls: relay().pulls, upserts: relay().upserts }).toEqual(before) // nothing offline

    setOnline(true)
    await advance(MINUTE)

    for (const device of [laptop, phone]) {
      expect(liveIds(device)).toEqual(expect.arrayContaining([phoneAdd.id, laptopAdd.id]))
      for (const gone of ['e2', 'e3', 'e4']) expect(liveIds(device)).not.toContain(gone)
      expect(rowOf(device, 'e1')).toMatchObject({ amount: 55, notes: 'laptop offline note' })
    }
    expectConverged(laptop, phone)
    await expectQuiet()
  })

  it('a device that edited offline keeps its edit when the other one landed first', async () => {
    const { laptop, phone } = await pair(five, slow)
    setOnline(false)
    S(phone).updateExpense('e1', { amount: 55 })
    S(laptop).updateExpense('e1', { notes: 'laptop offline note' })
    await advance(5000)
    setOnline(true)
    await advance(MINUTE)

    for (const device of [laptop, phone]) {
      expect(rowOf(device, 'e1')).toMatchObject({ amount: 55, notes: 'laptop offline note' })
    }
    expectConverged(laptop, phone)
    await expectQuiet()
  })
})

describe('an early cycle never acknowledges: a slower stale push from the other device lands after it', () => {
  // The laptop edits the amount, the phone the notes 50 ms later, and the phone's push takes
  // `ms`. A cycle on the laptop right after its own push landed (a realtime SUBSCRIBED catch-up,
  // an 'online', a Sync now) finds the relay equal to its state; the phone's push, built on a
  // pull from before the laptop's landed, lands after it. A 1 s push lost the amount everywhere.
  const LATENCIES = [400, 1000, 2000]

  it.each(LATENCIES)(
    'both Disconnected, edit, then Connect at the same moment; phone push %i ms',
    async (ms) => {
      const p = await pair(oneRow)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? ms : undefined)
      p.laptop.sync.useSyncStore.getState().disconnectSync()
      p.phone.sync.useSyncStore.getState().disconnectSync()
      await advance(1000)
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(1000)
      void p.laptop.sync.useSyncStore.getState().setupSync(SYNC_CODE)
      void p.phone.sync.useSyncStore.getState().setupSync(SYNC_CODE)
      await advance(MINUTE)
      expectBothEdits(p)
    },
  )

  it.each(LATENCIES)(
    'both offline, edit, both online together, the laptop taps Sync now; phone push %i ms',
    async (ms) => {
      const p = await pair(oneRow)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? ms : undefined)
      setOnline(false)
      await advance(1000)
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(5000)
      setOnline(true)
      await advance(50)
      void p.laptop.sync.useSyncStore.getState().triggerSync()
      await advance(MINUTE)
      expectBothEdits(p)
    },
  )

  it.each(LATENCIES)(
    'online, the laptop taps Sync now while its push is in flight; phone push %i ms',
    async (ms) => {
      const p = await pair(oneRow)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? ms : undefined)
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(3000 - 50 + 250) // the laptop's cycle started at 3 s; its push is in flight
      void p.laptop.sync.useSyncStore.getState().triggerSync()
      await advance(MINUTE)
      expectBothEdits(p)
    },
  )

  it.each(Array.from({ length: 20 }, (_, i) => i * 100))(
    'a real outage on both, back together: the re-subscribe lands %i ms into its re-arm (1 s phone push)',
    async (phase) => {
      const p = await pair(oneRow)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? 1000 : undefined)
      outage(true)
      await advance(1000)
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(10_000 + phase)
      outage(false)
      await advance(MINUTE)
      expectBothEdits(p)
    },
  )
})

describe('a stale push from the other device lands long after ours (slow upload, late commit)', () => {
  const twoRows = () => [expense('e1', { amount: 10 }), expense('e2')]

  it.each([6000, 8000, 10_000, 14_000])(
    'the phone push takes %i ms: the laptop amount and the phone notes both survive',
    async (ms) => {
      const p = await pair(twoRows)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? ms : undefined)
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(90_000)
      expectBothEdits(p)
    },
  )

  it.each([8000, 12_000, 14_500])(
    'the phone push commits at %i ms but its answer misses the 15 s deadline',
    async (writeAt) => {
      const p = await pair(twoRows)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? 20_000 : undefined)
      relay().writeFraction = writeAt / 20_000
      S(p.laptop).updateExpense('e1', { amount: 20 })
      await advance(50)
      S(p.phone).updateExpense('e1', { notes: 'phone' })
      await advance(20_000)
      relay().pushLatencyFor = null
      relay().writeFraction = 0.5
      await advance(2 * MINUTE)
      expectBothEdits(p)
    },
  )

  it('a rename on the laptop and a slow phone edit of a re-filed row both stick', async () => {
    const rows = () => ['e1', 'e2', 'e3'].map((id) => expense(id, { category: 'Meals' }))
    const p = await pair(rows)
    relay().pushLatencyFor = (c) => (c === p.phoneClient ? 8000 : undefined)
    S(p.laptop).renameCategory('Meals', 'Dining')
    await advance(50)
    S(p.phone).updateExpense('e1', { amount: 77 })
    await advance(90_000)
    for (const d of [p.laptop, p.phone]) {
      expect(rowOf(d, 'e1')).toMatchObject({ category: 'Dining', amount: 77 })
      expect(S(d).expenses.map((e) => e.category)).toEqual(['Dining', 'Dining', 'Dining'])
      expect(S(d).categories).toContain('Dining')
      expect(S(d).categories).not.toContain('Meals')
    }
    expectConverged(p.laptop, p.phone)
  })

  // The phone only adds an expense; its push was built before the laptop's change landed. The
  // list and the mappings carry no stamps, so nothing but the pending change protects them.
  type Change = 'add category' | 'remove category' | 'rename category' | 'mapping pick'
  const apply = (d: Device, c: Change) => {
    if (c === 'add category') S(d).addCategory('Travel')
    if (c === 'remove category') S(d).removeCategory('Pets')
    if (c === 'rename category') S(d).renameCategory('Pets', 'Animals')
    if (c === 'mapping pick') S(d).addExpense({ itemName: 'grab', amount: 4, category: 'Gym' })
  }
  const holds = (d: Device, c: Change): boolean => {
    const s = S(d)
    if (c === 'add category') return s.categories.includes('Travel')
    if (c === 'remove category') return !s.categories.includes('Pets')
    if (c === 'rename category')
      return s.categories.includes('Animals') && !s.categories.includes('Pets')
    return s.categoryMappings.grab === 'Gym'
  }
  const lists = {
    categories: ['Other', 'Meals', 'Gym', 'Pets'],
    categoryMappings: { grab: 'Meals' },
  }
  const listRows = () => [expense('e1', { amount: 10 }), expense('e2', { category: 'Gym' })]
  const CHANGES: Change[] = ['add category', 'remove category', 'rename category', 'mapping pick']

  it.each(CHANGES.flatMap((c) => [6000, 10_000].map((ms) => [c, ms] as const)))(
    'laptop: %s; the phone push that only adds an expense takes %i ms',
    async (change, ms) => {
      const p = await pair(listRows, LATENCY, lists)
      relay().pushLatencyFor = (c) => (c === p.phoneClient ? ms : undefined)
      apply(p.laptop, change)
      await advance(50)
      S(p.phone).addExpense({ itemName: 'phone add', amount: 3, category: 'Meals' })
      await advance(90_000)
      expect(holds(p.laptop, change)).toBe(true)
      expect(holds(p.phone, change)).toBe(true)
      expectConverged(p.laptop, p.phone)
    },
  )

  it.each(CHANGES)(
    'laptop: %s right after the phone read the relay for an 8 s pull',
    async (change) => {
      const p = await pair(listRows, LATENCY, lists)
      // The phone's next pull reads the row 100 ms in and answers at 8 s (a slow download, or a
      // page frozen between the read and its continuation).
      relay().pullLatencyFor = (c) => (c === p.phoneClient ? 8000 : undefined)
      relay().pullReadFraction = 100 / 8000
      S(p.phone).addExpense({ itemName: 'phone add', amount: 3, category: 'Meals' })
      await advance(2950 + 200) // the phone's cycle started at 3 s and has read the row
      apply(p.laptop, change)
      await advance(9000)
      relay().pullLatencyFor = null
      relay().pullReadFraction = 1
      await advance(90_000)
      expect(holds(p.laptop, change)).toBe(true)
      expect(holds(p.phone, change)).toBe(true)
      expectConverged(p.laptop, p.phone)
    },
  )
})

describe('a deliberate later change on the other device always wins (ABA)', () => {
  it.each([500, 1500, 4000, 10_000])(
    'the laptop sets the amount back %i ms after it received the phone edit',
    async (gap) => {
      const { laptop, phone } = await pair(oneRow, { pull: 200, push: 200, realtime: 100 })
      S(phone).updateExpense('e1', { amount: 20 })
      for (let i = 0; i < 100 && rowOf(laptop, 'e1')?.amount !== 20; i++) await advance(50)
      expect(rowOf(laptop, 'e1')?.amount).toBe(20)

      await advance(gap)
      S(laptop).updateExpense('e1', { amount: 10 })
      await advance(MINUTE)

      expect(rowOf(laptop, 'e1')?.amount).toBe(10)
      expect(rowOf(phone, 'e1')?.amount).toBe(10)
      expectConverged(phone, laptop)
    },
  )

  // The device that pushed loses its network soon after (a locked phone frozen in the background
  // behaves the same), so nothing more is heard from it. Meanwhile the other device sets the
  // value back. Before, the returning device re-applied its old value over that correction, and
  // with both devices in that state they pushed at each other every second, forever.
  const lists = { categories: ['Other', 'Meals', 'Pets'], categoryMappings: { grab: 'Meals' } }

  it('the phone sets 20 and drops off the network; the laptop sets 10 back; 10 stays', async () => {
    const p = await pair(oneRow, LATENCY, lists)
    S(p.phone).updateExpense('e1', { amount: 20 })
    await advance(4000) // pushed and landed
    relay().offlineClients.add(p.phoneClient)
    await advance(10_000)
    expect(rowOf(p.laptop, 'e1')?.amount).toBe(20)
    S(p.laptop).updateExpense('e1', { amount: 10 })
    await advance(30_000)
    relay().offlineClients.delete(p.phoneClient)
    await advance(2 * MINUTE)
    for (const d of [p.laptop, p.phone]) expect(rowOf(d, 'e1')?.amount).toBe(10)
    expectConverged(p.laptop, p.phone)
    await expectQuiet()
  })

  type Opposite = 'field' | 'mapping' | 'category'
  const first: Record<Opposite, (d: Device) => void> = {
    field: (d) => S(d).updateExpense('e1', { amount: 20 }),
    mapping: (d) => S(d).addExpense({ itemName: 'grab', amount: 3, category: 'Pets' }),
    category: (d) => S(d).addCategory('Gym'),
  }
  const back: Record<Opposite, (d: Device) => void> = {
    field: (d) => S(d).updateExpense('e1', { amount: 10 }),
    mapping: (d) => S(d).addExpense({ itemName: 'grab', amount: 4, category: 'Meals' }),
    category: (d) => S(d).removeCategory('Gym'),
  }
  const settled: Record<Opposite, (d: Device) => boolean> = {
    field: (d) => rowOf(d, 'e1')?.amount === 10,
    mapping: (d) => S(d).categoryMappings.grab === 'Meals',
    category: (d) => !S(d).categories.includes('Gym'),
  }

  it.each<Opposite>(['field', 'mapping', 'category'])(
    'both devices drop off right after pushing opposite changes (%s): the later one stays, then quiet',
    async (kind) => {
      const p = await pair(oneRow, LATENCY, lists)
      first[kind](p.phone)
      await advance(4000)
      relay().offlineClients.add(p.phoneClient)
      await advance(2000)
      back[kind](p.laptop)
      await advance(4000)
      relay().offlineClients.add(p.laptopClient)
      await advance(20_000)
      relay().offlineClients.clear()
      await advance(3 * MINUTE)

      expect(settled[kind](p.laptop)).toBe(true)
      expect(settled[kind](p.phone)).toBe(true)
      expectConverged(p.laptop, p.phone)
      for (let hour = 0; hour < 6; hour++) await expectQuiet() // an hour, not a push in it
    },
  )
})

describe('a second write before the other device builds on the first', () => {
  // The phone's first edit is on the relay and the laptop has adopted it, but the laptop's push
  // that carries it back names only that first push: the second write is still pending, and a
  // value this device held is no change from the laptop.
  async function phoneWithLunch(): Promise<Device> {
    const phone = await bootDevice({
      expenses: [expense('e1', { itemName: 'Lunch', amount: 4.5 })],
    })
    relay().latency = { pull: 200, push: 200, realtime: 50 }
    await connect(phone)
    await advance(10_000)
    return phone
  }

  /** The laptop's push: `row` over the relay copy, built on it (or on nothing of ours). */
  function laptopPush(row: Expense, builtOnRelay: boolean): void {
    const landed = rowPayload(SYNC_CODE)
    const seen = builtOnRelay ? [relayWr().rev] : []
    writeAsOther(SYNC_CODE, {
      ...(isRecord(landed) ? landed : {}),
      expenses: [row],
      wr: { app: '0.8.5', dev: 'aaaaaa', rev: 'r-laptop', at: row.updatedAt, seen },
    })
  }

  it.each([true, false])(
    'an undo made after the push landed is not lost (laptop built on our push: %s)',
    async (builtOnRelay) => {
      const phone = await phoneWithLunch()
      S(phone).updateExpense('e1', { itemName: 'Dinner' })
      await advance(3000 + 400 + 10) // pushed and landed
      const undo = S(phone).undoStack.find((u) => u.id.startsWith('update-e1'))
      S(phone).consumeUndo(undo?.id ?? '')
      expect(rowOf(phone, 'e1')?.itemName).toBe('Lunch')

      // The laptop took the phone's "Dinner", then changed the amount, later than the undo.
      const later = new Date(Date.now() + 1000).toISOString()
      laptopPush(
        { ...expense('e1', { itemName: 'Dinner', amount: 9 }), updatedAt: later },
        builtOnRelay,
      )
      await advance(MINUTE)

      expect(rowOf(phone, 'e1')).toMatchObject({ itemName: 'Lunch', amount: 9 })
      expect(contentKey(rowPayload(SYNC_CODE))).toBe(contentKey(S(phone).exportBackup()))
    },
  )

  it('a later deliberate change of that field on the other device still wins', async () => {
    const phone = await phoneWithLunch()
    S(phone).updateExpense('e1', { itemName: 'Dinner' })
    await advance(3000 + 400 + 10)
    const later = new Date(Date.now() + 1000).toISOString()
    laptopPush({ ...expense('e1', { itemName: 'Supper', amount: 4.5 }), updatedAt: later }, true)
    await advance(MINUTE)
    expect(rowOf(phone, 'e1')?.itemName).toBe('Supper')
  })

  it('a second write survives a base move and a newer copy that still holds the first one', async () => {
    const phone = await phoneWithLunch()
    S(phone).updateExpense('e1', { amount: 45 })
    await advance(3000 + 400 + 10)
    // A stale laptop edit of the notes lands: the phone re-applies 45 over it (the base moves).
    const t1 = new Date(Date.now() + 1000).toISOString()
    laptopPush(
      { ...expense('e1', { itemName: 'Lunch', amount: 4.5, notes: 'n1' }), updatedAt: t1 },
      false,
    )
    await advance(10_000)
    expect(rowOf(phone, 'e1')).toMatchObject({ amount: 45, notes: 'n1' })

    S(phone).updateExpense('e1', { amount: 50 }) // the second write, not yet pushed
    // A newer laptop copy that still holds the first write (45) and changes the notes again.
    const t2 = new Date(Date.now() + 60_000).toISOString()
    laptopPush(
      { ...expense('e1', { itemName: 'Lunch', amount: 45, notes: 'n2' }), updatedAt: t2 },
      false,
    )
    await advance(MINUTE)

    expect(rowOf(phone, 'e1')).toMatchObject({ amount: 50, notes: 'n2' })
    expect(relayRows()).toContainEqual(
      expect.objectContaining({ id: 'e1', amount: 50, notes: 'n2' }),
    )
  })
})

describe('the lineage on the wire', () => {
  it("names the copy each push was built on, and never the writer's own revs", async () => {
    const p = await pair(oneRow)
    const revs = [relayWr().rev] // the laptop's first push; the phone found it equal
    const step = async (d: Device, amount: number) => {
      S(d).updateExpense('e1', { amount })
      await advance(10_000)
      revs.push(relayWr().rev)
      return relayWr().seen
    }
    expect(await step(p.phone, 11)).toEqual([revs[0]])
    expect(await step(p.laptop, 12)).toEqual([revs[1]]) // its own first push is left out
    expect(await step(p.phone, 13)).toEqual([revs[2]])
    expect(await step(p.phone, 14)).toEqual([revs[2]]) // built on its own copy: nothing new
    expect(await step(p.laptop, 15)).toEqual([revs[4]])
  })

  it('keeps at most SEEN_MAX revs, newest first', async () => {
    const phone = await bootDevice({ expenses: oneRow() })
    relay().latency = LATENCY
    const long = Array.from({ length: SEEN_MAX + 4 }, (_, i) => `older-${String(i)}`)
    writeAsOther(SYNC_CODE, {
      expenses: [expense('e1', { amount: 10 })],
      categories: ['Other', 'Meals'],
      categoryMappings: {},
      budgets: {},
      budgetUpdatedAt: {},
      budgetDeletedAt: {},
      deletedIds: [],
      exportDate: '',
      version: '4.0',
      wr: { app: '0.8.5', dev: 'aaaaaa', rev: 'r-laptop', at: '', seen: long },
    })
    await connect(phone)
    S(phone).updateExpense('e1', { amount: 11 })
    await advance(10_000)
    expect(relayWr().seen).toEqual(['r-laptop', ...long].slice(0, SEEN_MAX))
  })

  it('a push naming ours acknowledges exactly what ours carried; a stale one acknowledges nothing', async () => {
    const phone = await bootDevice({ expenses: [expense('e1'), expense('e2')] })
    relay().latency = LATENCY
    await connect(phone)
    S(phone).updateExpense('e1', { amount: 45 })
    await advance(10_000)
    const carried = relayWr().rev
    S(phone).updateExpense('e2', { notes: 'later' }) // after that push was built
    const relayCopy = rowPayload(SYNC_CODE)
    const other = (rev: string, seen: string[]) =>
      writeAsOther(SYNC_CODE, {
        ...(isRecord(relayCopy) ? relayCopy : {}),
        wr: { app: '0.8.5', dev: 'aaaaaa', rev, at: '', seen },
      })

    other('r-stale', ['r-unrelated']) // built on a copy from before ours
    await advance(5000)
    expect([...pendingOf(phone).edits.keys()].sort()).toEqual(['e1', 'e2'])

    other('r-built', [carried])
    await advance(5000)
    expect([...pendingOf(phone).edits.keys()]).toEqual(['e2'])
  })
})

describe('the check pull', () => {
  it('is one pull 2.5 s after a push that carried pending changes, none after one that did not', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    await advance(10_000)

    S(phone).addExpense({ itemName: 'Kopi', amount: 1.5 }) // no pending change
    await advance(3000 + 100 + 10) // the debounced cycle pushed
    let pulls = relay().pulls
    await advance(MINUTE)
    expect(relay().pulls).toBe(pulls)

    S(phone).updateExpense('e1', { amount: 9 })
    await advance(3000 + 100 + 10)
    pulls = relay().pulls
    await advance(2500 + 60)
    expect(relay().pulls).toBe(pulls + 1)
    // It found our own copy: that acknowledges nothing.
    expect(pendingOf(phone).edits.has('e1')).toBe(true)
    await expectQuiet()

    // A later push that carries only that, already checked, change gets no second check.
    S(phone).addExpense({ itemName: 'Teh', amount: 1.2 })
    await advance(3000 + 100 + 10)
    pulls = relay().pulls
    await advance(MINUTE)
    expect(relay().pulls).toBe(pulls)
  })

  it('catches up after the network went right after the push, with no event to tell it', async () => {
    const p = await pair(oneRow)
    S(p.phone).updateExpense('e1', { amount: 20 })
    await advance(3000 + 400 + 100) // landed; the check is due in 2.5 s
    relay().offlineClients.add(p.phoneClient) // its check fails; the retries keep going
    S(p.laptop).updateExpense('e1', { notes: 'laptop' })
    await advance(10_000)
    relay().offlineClients.delete(p.phoneClient)
    await advance(2 * MINUTE)
    for (const d of [p.laptop, p.phone])
      expect(rowOf(d, 'e1')).toMatchObject({ amount: 20, notes: 'laptop' })
    expectConverged(p.laptop, p.phone)
  })

  it('is cancelled by a disconnect', async () => {
    const phone = await bootDevice({ expenses: [expense('e1')] })
    relay().latency = { pull: 50, push: 50, realtime: 20 }
    await connect(phone)
    await advance(10_000)
    S(phone).updateExpense('e1', { amount: 9 })
    await advance(3000 + 100 + 10)
    const pulls = relay().pulls
    phone.sync.useSyncStore.getState().disconnectSync()
    await advance(MINUTE)
    expect(relay().pulls).toBe(pulls)
  })
})
