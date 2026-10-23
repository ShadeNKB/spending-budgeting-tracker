// Category rename and remove, and the category an item name maps to, have no stamps on the v4
// wire. The pure merge only unions names and picks the larger mapping value, so these changes
// were undone by the next sync (rows re-filed back by the tie-break, the old name back in the
// list, the older pick back in the mapping). Re-filed rows now carry a forward stamp and a
// pending category edit; list and mapping changes stay pending until another device builds on
// the push that carried them, and another device's changes are told apart by the relay copy
// seen last.
// Scenarios ported from the final review's adversarial harness (twoDevice, legacy).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { isRecord } from '../../lib/backup'
import { contentKey } from '../../services/syncService'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
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

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const LATENCY = { pull: 200, push: 200, realtime: 100 }

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

const store = (d: Device) => d.expense.useExpenseStore
const S = (d: Device) => store(d).getState()
const rowOf = (d: Device, id: string): Expense | undefined => S(d).expenses.find((e) => e.id === id)
const categoriesOf = (d: Device): string[] => S(d).expenses.map((e) => e.category)

/** The relay payload right now, without its writer stamp. */
function relayPayload(): Record<string, unknown> {
  const payload = rowPayload(SYNC_CODE)
  if (!isRecord(payload)) return {}
  const rest = { ...payload }
  delete rest.wr
  return rest
}

/** The writer stamp of another v0.8.5 device (not this one's echo), built on `seen`. */
const peer = (rev: string, seen: string[] = []) => ({
  wr: { app: '0.8.5', dev: 'aaaaaa', rev, at: '', seen },
})

/** The rev of the relay copy (the push it holds). */
function relayRev(): string {
  const payload = rowPayload(SYNC_CODE)
  const wr = isRecord(payload) ? payload.wr : undefined
  return isRecord(wr) && typeof wr.rev === 'string' ? wr.rev : ''
}

const relayCategories = (): unknown => relayPayload().categories
const relayMappings = (): unknown => relayPayload().categoryMappings

function expectConverged(...devices: Device[]): void {
  const key = contentKey(rowPayload(SYNC_CODE))
  for (const d of devices) expect(contentKey(S(d).exportBackup())).toBe(key)
}

async function expectQuiet(ms = 10 * MINUTE): Promise<void> {
  const upserts = relay().upserts
  await advance(ms)
  expect(relay().upserts).toBe(upserts)
}

/** One device with `rows`, connected and settled. */
async function single(rows: Expense[], categories?: string[]): Promise<Device> {
  const phone = await bootDevice({ expenses: rows })
  if (categories) store(phone).setState({ categories })
  relay().latency = LATENCY
  await connect(phone)
  await advance(10_000)
  return phone
}

/** Phone and laptop with the same rows, connected and settled. */
async function pair(rows: () => Expense[]): Promise<{ phone: Device; laptop: Device }> {
  const phone = await bootDevice({ expenses: rows() })
  const laptop = await bootDevice({ expenses: rows() })
  relay().latency = LATENCY
  await connect(phone)
  await connect(laptop)
  await advance(20_000)
  return { phone, laptop }
}

describe('a category rename or removal sticks on the device that made it', () => {
  it.each([
    ['Meals', 'Dining'],
    ['Meals', 'Snacks'],
  ])(
    'renaming %s to %s keeps the rows and the list renamed across sync cycles',
    async (from, to) => {
      const phone = await single(['e1', 'e2'].map((id) => expense(id, { category: from })))
      S(phone).renameCategory(from, to)
      expect(categoriesOf(phone)).toEqual([to, to])

      await advance(MINUTE)
      void phone.sync.useSyncStore.getState().triggerSync()
      await advance(MINUTE)

      expect(categoriesOf(phone)).toEqual([to, to])
      expect(S(phone).categories).toContain(to)
      expect(S(phone).categories).not.toContain(from)
      expect(relayCategories()).toEqual(expect.not.arrayContaining([from]))
      expect(relayRows()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'e1', category: to })]),
      )
      expectConverged(phone)
      await expectQuiet()

      // The re-filed rows stay pending until another device builds on the push that carried
      // them; then they are its to change, and the rename still holds.
      expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(2)
      const relayCopy = relayPayload()
      writeAsOther(SYNC_CODE, { ...relayCopy, ...peer('r-laptop', [relayRev()]) })
      await advance(MINUTE)
      expect(phone.expense.pendingEditsSnapshot().edits.size).toBe(0)
      expect(categoriesOf(phone)).toEqual([to, to])
      expect(S(phone).categories).not.toContain(from)
    },
  )

  it.each(['Transport', 'Bills'])(
    'removing %s keeps its rows in Other and the name out of the list',
    async (name) => {
      const phone = await single(
        ['e1', 'e2'].map((id) => expense(id, { category: name })),
        ['Other', 'Meals', name],
      )
      S(phone).removeCategory(name)
      await advance(MINUTE)
      void phone.sync.useSyncStore.getState().triggerSync()
      await advance(MINUTE)

      expect(categoriesOf(phone)).toEqual(['Other', 'Other'])
      expect(S(phone).categories).not.toContain(name)
      expectConverged(phone)
      await expectQuiet()
    },
  )

  it('re-filed rows carry a forward stamp and a pending category edit; others are untouched', async () => {
    const stamp = '2026-10-20T08:00:00.000Z' // a day ahead of this device's clock
    const other = expense('e2', { category: 'Other' })
    const phone = await single([expense('e1', { category: 'Meals', updatedAt: stamp }), other])
    S(phone).renameCategory('Meals', 'Dining')
    expect(Date.parse(rowOf(phone, 'e1')?.updatedAt ?? '')).toBeGreaterThan(Date.parse(stamp))
    expect(rowOf(phone, 'e2')).toBe(other)
    const { edits } = phone.expense.pendingEditsSnapshot()
    expect(edits.get('e1')?.fields).toEqual(new Set(['category']))
    expect(edits.has('e2')).toBe(false)
  })

  it('the latest category picked for an item name is kept', async () => {
    const phone = await single([])
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    await advance(10_000)
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await advance(10_000)
    void phone.sync.useSyncStore.getState().triggerSync()
    await advance(MINUTE)

    expect(S(phone).categoryMappings.grab).toBe('Meals')
    expect(relayMappings()).toEqual({ grab: 'Meals' })
    await expectQuiet()
  })
})

describe('two v0.8.5 devices', () => {
  const meals = () => ['e1', 'e2'].map((id) => expense(id, { category: 'Meals' }))

  it('converge to a rename made on one of them, list included, then go quiet', async () => {
    const { phone, laptop } = await pair(meals)
    S(phone).renameCategory('Meals', 'Dining')
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(categoriesOf(d)).toEqual(['Dining', 'Dining'])
      expect(S(d).categories).toContain('Dining')
      expect(S(d).categories).not.toContain('Meals')
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('converge to a removal made on one of them', async () => {
    const { phone, laptop } = await pair(meals)
    S(phone).removeCategory('Meals')
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(categoriesOf(d)).toEqual(['Other', 'Other'])
      expect(S(d).categories).not.toContain('Meals')
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each([
    ['the laptop edits 500 ms before the rename', true, 500],
    ['the laptop edits at the same moment', false, 0],
    ['the laptop edits 500 ms after the rename', false, 500],
    ['the laptop edits 3 s after the rename', false, 3000],
  ])(
    'a concurrent amount edit of a re-filed row survives (%s)',
    async (_label, laptopFirst, gap) => {
      const { phone, laptop } = await pair(meals)
      const first = laptopFirst
        ? () => S(laptop).updateExpense('e1', { amount: 9 })
        : () => S(phone).renameCategory('Meals', 'Dining')
      const second = laptopFirst
        ? () => S(phone).renameCategory('Meals', 'Dining')
        : () => S(laptop).updateExpense('e1', { amount: 9 })
      first()
      await advance(gap)
      second()
      await advance(MINUTE)

      for (const d of [phone, laptop]) {
        expect(rowOf(d, 'e1')).toMatchObject({ category: 'Dining', amount: 9 })
        expect(rowOf(d, 'e2')).toMatchObject({ category: 'Dining' })
      }
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )

  it('keep a removed name that a row on the other device still uses (no row loses its category)', async () => {
    const { phone, laptop } = await pair(() => [expense('e1', { category: 'Other' })])
    store(phone).setState({ categories: ['Other', 'Meals', 'Gym'] })
    store(laptop).setState({ categories: ['Other', 'Meals', 'Gym'] })
    await advance(MINUTE)
    S(phone).removeCategory('Gym')
    const gym = S(laptop).addExpense({ itemName: 'gym pass', amount: 30, category: 'Gym' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(rowOf(d, gym.id)?.category).toBe('Gym')
      expect(S(d).categories).toContain('Gym')
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('converge to the item mapping picked last, without pushing back and forth', async () => {
    const { phone, laptop } = await pair(() => [])
    S(laptop).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    await advance(MINUTE)
    expect(S(phone).categoryMappings.grab).toBe('Transport')

    // "Transport" > "Meals": the pure merge alone would bring Transport back on every device.
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(S(d).categoryMappings.grab).toBe('Meals')
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it("adopt another device's new category name and keep their own", async () => {
    const { phone, laptop } = await pair(() => [])
    S(phone).addCategory('Gym')
    S(laptop).addCategory('Pets')
    await advance(MINUTE)

    for (const d of [phone, laptop])
      expect(S(d).categories).toEqual(expect.arrayContaining(['Gym', 'Pets']))
    expectConverged(phone, laptop)
    await expectQuiet()
  })
})

describe('what the relay copy cannot take away', () => {
  it('a new category survives a peer push built on a pull from before it landed', async () => {
    const phone = await single([])
    const stale = relayPayload()
    S(phone).addCategory('Gym')
    await advance(3000 + 2 * LATENCY.pull) // pushed, not yet confirmed
    expect(relayCategories()).toEqual(expect.arrayContaining(['Gym']))
    writeAsOther(SYNC_CODE, { ...stale, ...peer('r-stale') })
    await advance(MINUTE)

    expect(S(phone).categories).toContain('Gym')
    expect(relayCategories()).toEqual(expect.arrayContaining(['Gym']))
  })

  it('a damaged category list on the relay removes no category here', async () => {
    const phone = await single([], ['Other', 'Meals', 'Gym'])
    writeAsOther(SYNC_CODE, { ...relayPayload(), categories: 5, ...peer('r-damaged') })
    await advance(MINUTE)

    expect(S(phone).categories).toEqual(expect.arrayContaining(['Other', 'Meals', 'Gym']))
    expect(relayCategories()).toEqual(expect.arrayContaining(['Other', 'Meals', 'Gym']))
  })

  it('a first sync with another device adds its names and drops none of ours', async () => {
    seedRow(SYNC_CODE, payloadOf([], { categories: ['Other', 'Pets'] }))
    const phone = await bootDevice()
    store(phone).setState({ categories: ['Other', 'Gym'] })
    await connect(phone)
    await advance(MINUTE)
    expect(S(phone).categories).toEqual(expect.arrayContaining(['Other', 'Gym', 'Pets']))
  })
})

describe('an old (v0.8.4) device re-filing a row without a stamp (§12.3 row 23)', () => {
  it('a re-file at the same stamp is not adopted: the copy here is kept', async () => {
    const towel = expense('k1', { itemName: 'Kitchen towel', category: 'Other' })
    const phone = await single([
      towel,
      expense('k2', { itemName: 'SQL course', category: 'Education' }),
    ])
    // v0.8.4 re-files by keyword without touching the stamp and pushes its whole copy.
    writeAsLegacy(SYNC_CODE, {
      ...relayPayload(),
      expenses: [
        { ...towel, category: 'Shopping' },
        expense('k2', { itemName: 'SQL course', category: 'Subscriptions' }),
      ],
    })
    await advance(MINUTE)

    expect(rowOf(phone, 'k1')?.category).toBe('Other')
    expect(rowOf(phone, 'k2')?.category).toBe('Education')
  })

  it('from a v0.8.5 writer the same tie still goes to the deterministic winner', async () => {
    const row = expense('k1', { itemName: 'Kitchen towel', category: 'Other' })
    const phone = await single([row])
    writeAsOther(SYNC_CODE, {
      ...relayPayload(),
      expenses: [{ ...row, category: 'Shopping' }],
      ...peer('r-tie'),
    })
    await advance(MINUTE)
    // "Shopping" sorts after "Other": the larger canonical copy wins, on every device alike.
    expect(rowOf(phone, 'k1')?.category).toBe('Shopping')
  })

  it('a legacy copy that differs in more than the category is merged as usual', async () => {
    const row = expense('k1', { itemName: 'Kitchen towel', category: 'Other', amount: 1 })
    const phone = await single([row])
    writeAsLegacy(SYNC_CODE, {
      ...relayPayload(),
      expenses: [{ ...row, category: 'Shopping', amount: 2 }],
    })
    await advance(MINUTE)
    expect(rowOf(phone, 'k1')).toMatchObject({ category: 'Shopping', amount: 2 })
  })
})
