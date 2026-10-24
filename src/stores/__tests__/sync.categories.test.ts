// Category rename and remove, item mappings and the category list on the v4 wire.
// - A rename or removal re-files its rows, its item mappings and its budget as stamped writes,
//   so last-writer-wins on every device adopts them and nothing undoes them.
// - Item mappings carry a stamp per key (`mappingUpdatedAt`): the pick made last wins.
// - The category list is a union: a removed or renamed-away name can come back in the list
//   (known v4 limit, fixed by the v5 rename table); no row, mapping or budget follows it back.
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
  setClientOffline,
  setVisibility,
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
const DAY = 24 * 60 * MINUTE
const LATENCY = { pull: 200, push: 200, realtime: 100 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
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

/** The writer stamp of another v0.8.5 device (not this one's echo). */
const peer = (rev: string) => ({ wr: { app: '0.8.5', dev: 'aaaaaa', rev, at: '' } })

const relayCategories = (): unknown => relayPayload().categories
const relayMappings = (): unknown => relayPayload().categoryMappings

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

/** Several sync cycles on `device`: Sync now, hide and show, and realtime catch-ups. */
async function manyCycles(device: Device): Promise<void> {
  for (let i = 0; i < 5; i++) {
    void device.sync.useSyncStore.getState().triggerSync()
    await advance(5000)
    setVisibility('hidden')
    await advance(1000)
    setVisibility('visible')
    await advance(40_000)
  }
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
  ])('renaming %s to %s keeps the rows renamed across sync cycles', async (from, to) => {
    const phone = await single(['e1', 'e2'].map((id) => expense(id, { category: from })))
    S(phone).renameCategory(from, to)
    expect(categoriesOf(phone)).toEqual([to, to])

    await manyCycles(phone)

    expect(categoriesOf(phone)).toEqual([to, to])
    expect(S(phone).categories).toContain(to)
    expect(relayRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'e1', category: to }),
        expect.objectContaining({ id: 'e2', category: to }),
      ]),
    )
    expectConverged(phone)
    await expectQuiet()
  })

  it.each(['Transport', 'Bills'])('removing %s keeps its rows in Other', async (name) => {
    const phone = await single(
      ['e1', 'e2'].map((id) => expense(id, { category: name })),
      ['Other', 'Meals', name],
    )
    S(phone).removeCategory(name)
    await manyCycles(phone)

    expect(categoriesOf(phone)).toEqual(['Other', 'Other'])
    expectConverged(phone)
    await expectQuiet()
  })

  it('the category list is a union: a renamed-away name comes back, empty (known v4 limit)', async () => {
    const phone = await single([expense('e1', { category: 'Meals' })])
    S(phone).renameCategory('Meals', 'Dining')
    expect(S(phone).categories).not.toContain('Meals')
    await advance(MINUTE)
    expect(S(phone).categories).toEqual(expect.arrayContaining(['Dining', 'Meals']))
    // Nothing else follows the name back.
    expect(categoriesOf(phone)).toEqual(['Dining'])
    expectConverged(phone)
    await expectQuiet()
  })

  it('a correction of the category picked for an item sticks across many sync cycles', async () => {
    const phone = await single([])
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    await advance(MINUTE)
    expect(relayMappings()).toEqual({ grab: 'Transport' })

    // "Transport" > "Meals": a larger-value tie-break would bring Transport back.
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await manyCycles(phone)

    expect(S(phone).categoryMappings.grab).toBe('Meals')
    expect(relayMappings()).toEqual({ grab: 'Meals' })
    expect(S(phone).getSmartCategory('grab')).toBe('Meals')
    expectConverged(phone)
    await expectQuiet()
  })
})

describe('two v0.8.5 devices', () => {
  const meals = () => ['e1', 'e2'].map((id) => expense(id, { category: 'Meals' }))

  it('converge to a rename made on one of them: rows, mappings and budget, then go quiet', async () => {
    const { phone, laptop } = await pair(meals)
    for (const d of [phone, laptop]) {
      store(d).setState({
        categoryMappings: { kopi: 'Meals' },
        mappingUpdatedAt: { kopi: '2026-10-01T00:00:00.000Z' },
        budgets: { Meals: 300 },
        budgetUpdatedAt: { Meals: '2026-10-01T00:00:00.000Z' },
      })
    }
    await advance(MINUTE)
    S(phone).renameCategory('Meals', 'Dining')
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(categoriesOf(d)).toEqual(['Dining', 'Dining'])
      expect(S(d).categories).toContain('Dining')
      expect(S(d).categoryMappings).toEqual({ kopi: 'Dining' })
      expect(S(d).budgets).toEqual({ Dining: 300 })
    }
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('converge to a removal made on one of them', async () => {
    const { phone, laptop } = await pair(meals)
    S(phone).removeCategory('Meals')
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(categoriesOf(d)).toEqual(['Other', 'Other'])
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each([
    ['the laptop edits 500 ms before the rename', true, 500],
    ['the laptop edits 500 ms after the rename', false, 500],
    ['the laptop edits 3 s after the rename', false, 3000],
  ])(
    'a concurrent edit of a re-filed row: the later record wins it whole (%s)',
    async (_label, laptopFirst, gap) => {
      const { phone, laptop } = await pair(meals)
      const rename = () => S(phone).renameCategory('Meals', 'Dining')
      const edit = () => S(laptop).updateExpense('e1', { amount: 9 })
      if (laptopFirst) edit()
      else rename()
      await advance(gap)
      if (laptopFirst) rename()
      else edit()
      await advance(MINUTE)

      // Whole-record last-writer-wins: the later of the two writes holds e1.
      const e1 = laptopFirst ? { category: 'Dining', amount: 1 } : { category: 'Meals', amount: 9 }
      for (const d of [phone, laptop]) {
        expect(rowOf(d, 'e1')).toMatchObject(e1)
        expect(rowOf(d, 'e2')).toMatchObject({ category: 'Dining' })
        expect(S(d).categories).toEqual(expect.arrayContaining(['Dining', 'Meals']))
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

    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(S(d).categoryMappings.grab).toBe('Meals')
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each([
    ['a day behind', -DAY],
    ['a day ahead', DAY],
  ])(
    'a correction on a device whose clock runs %s still wins once it has seen the pick',
    async (_label, skew) => {
      const { phone, laptop } = await pair(() => [])
      withClock(-skew, () => {
        S(laptop).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
      })
      await advance(MINUTE)
      expect(S(phone).categoryMappings.grab).toBe('Transport')

      withClock(skew, () => {
        S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
      })
      await advance(MINUTE)

      for (const d of [phone, laptop]) expect(S(d).categoryMappings.grab).toBe('Meals')
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )

  it('concurrent picks for one item converge to the later stamp on both devices', async () => {
    const { phone, laptop } = await pair(() => [])
    S(laptop).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    await advance(10)
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

describe('names that are also Object.prototype keys are plain names', () => {
  const own = (record: unknown, key: string): unknown =>
    isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined

  it('an item named "__proto__" with a picked category: one mapping everywhere, then quiet', async () => {
    const { phone, laptop } = await pair(() => [])
    S(phone).addExpense({ itemName: '__proto__', amount: 3, category: 'Meals' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(own(S(d).categoryMappings, '__proto__')).toBe('Meals')
      expect(own(S(d).mappingUpdatedAt, '__proto__')).toEqual(expect.any(String))
    }
    expect(own(relayMappings(), '__proto__')).toBe('Meals')
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it('a category named "__proto__" with a budget: one budget everywhere, then quiet', async () => {
    const { phone, laptop } = await pair(() => [])
    S(phone).addCategory('__proto__')
    S(phone).setBudget('__proto__', 100)
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(own(S(d).budgets, '__proto__')).toBe(100)
      expect(S(d).categories).toContain('__proto__')
    }
    expect(own(relayPayload().budgets, '__proto__')).toBe(100)
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each(['Constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'an item named %s with no category picked is filed under Other and reaches the other device',
    async (itemName) => {
      const { phone, laptop } = await pair(() => [])
      const added = S(phone).addExpense({ itemName, amount: 7 })
      expect(added.category).toBe('Other')
      expect(S(phone).categoryMappings).toEqual({})
      await advance(MINUTE)

      expect(rowOf(laptop, added.id)).toMatchObject({ itemName, category: 'Other', amount: 7 })
      expect(relayRows()).toContainEqual(expect.objectContaining({ id: added.id }))
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )
})

describe('a budget field left unchanged is no edit', () => {
  it("re-setting the shown value cannot revert the other device's newer change", async () => {
    const start = (): Expense[] => []
    const phone = await bootDevice({ expenses: start() })
    const laptop = await bootDevice({ expenses: start() })
    relay().latency = LATENCY
    await connect(phone)
    const laptopClient = relay().nextClient
    await connect(laptop)
    await advance(20_000)
    S(phone).setBudget('Meals', 200)
    await advance(MINUTE)
    expect(S(laptop).budgets.Meals).toBe(200)

    // The laptop drops off the network for a moment; the phone raises the budget.
    setClientOffline(laptopClient, true)
    S(phone).setBudget('Meals', 300)
    await advance(10_000)
    // On the laptop the Budgets list still shows 200: the owner tabs through the field.
    vi.setSystemTime(Date.now() + 1000)
    const before = S(laptop).budgetUpdatedAt
    S(laptop).setBudget('Meals', 200)
    expect(S(laptop).budgetUpdatedAt).toBe(before) // no fresh stamp
    setClientOffline(laptopClient, false)
    window.dispatchEvent(new Event('online'))
    await advance(MINUTE)

    for (const d of [phone, laptop]) expect(S(d).budgets.Meals).toBe(300)
    expectConverged(phone, laptop)
    await expectQuiet()
  })
})

describe('what the relay copy cannot take away', () => {
  it('a new category survives a peer push built on a pull from before it landed', async () => {
    const phone = await single([])
    const stale = relayPayload()
    S(phone).addCategory('Gym')
    await advance(3000 + 2 * LATENCY.pull)
    expect(relayCategories()).toEqual(expect.arrayContaining(['Gym']))
    writeAsOther(SYNC_CODE, { ...stale, ...peer('r-stale') })
    await advance(MINUTE)

    expect(S(phone).categories).toContain('Gym')
    expect(relayCategories()).toEqual(expect.arrayContaining(['Gym']))
  })

  it('a mapping correction survives a peer push built on a pull from before it landed', async () => {
    const phone = await single([])
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    await advance(MINUTE)
    const stale = relayPayload()
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await advance(MINUTE)
    writeAsOther(SYNC_CODE, { ...stale, ...peer('r-stale') })
    await advance(MINUTE)

    expect(S(phone).categoryMappings.grab).toBe('Meals')
    expect(relayMappings()).toEqual({ grab: 'Meals' })
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

describe('an old (v0.8.4) device on the relay', () => {
  it('a re-file at the same stamp is not adopted: the copy here is kept (§12.3 row 23)', async () => {
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

  it('its copy without mapping stamps neither reverts a pick nor draws pushes over the stamps', async () => {
    const phone = await single([])
    S(phone).addExpense({ itemName: 'grab', amount: 5, category: 'Meals' })
    await advance(MINUTE)
    // The old device keeps its own pick ("Transport" > "Meals") and drops the stamps.
    writeAsLegacy(SYNC_CODE, {
      ...relayPayload(),
      categoryMappings: { grab: 'Transport' },
      mappingUpdatedAt: undefined,
    })
    await advance(MINUTE)
    expect(S(phone).categoryMappings.grab).toBe('Meals')
    expect(relayMappings()).toEqual({ grab: 'Meals' })

    // It writes again with the same mappings, only without the stamps: nothing to send.
    const pushes = relay().pushes.length
    writeAsLegacy(SYNC_CODE, { ...relayPayload(), mappingUpdatedAt: undefined })
    await advance(MINUTE)
    expect(relay().pushes.length).toBe(pushes)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      waitingForOld: false,
    })
  })
})
