// Category rename and remove, item mappings and the category list on the v5 wire (§6.5, §6.6).
// - A rename or removal is an entry in the rename table: every device resolves its rows, item
//   mappings and budget through it, so nothing undoes it and a renamed-away name stays gone
//   (PR-0's union brought it back: fixed). Rows are re-filed without a new stamp, so another
//   device's concurrent edit of the same row survives (per-field merge).
// - Item mappings carry a stamp per key (`x5.mts` and the top-level `mappingUpdatedAt` 0.9.2
//   reads, P2-3): the pick made last wins.
// - Reserved names (`__proto__`, `constructor`…) are refused with a readable message (F-010).
// Scenarios ported from the final review's adversarial harness (twoDevice, legacy).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense, ExpenseView } from '../../types'
import { isRecord } from '../../lib/backup'
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
  type V4Seed,
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
const rowOf = (d: Device, id: string): ExpenseView | undefined =>
  S(d).expenses.find((e) => e.id === id)
const categoriesOf = (d: Device): string[] => S(d).expenses.map((e) => e.category)

/** The relay payload right now as an old device holds it: no writer stamp, no x5. */
function relayPayload(): Record<string, unknown> {
  const payload = rowPayload(SYNC_CODE)
  if (!isRecord(payload)) return {}
  const rest = { ...payload }
  delete rest.wr
  delete rest.x5
  return rest
}

/** The writer stamp of a 0.9.2 (protocol 0.8.5) device (not this one's echo). */
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

/** What the owner sees of an entry, and what the relay holds of it. */
const shown = (r: unknown) =>
  isRecord(r) ? JSON.stringify([r.id, r.itemName, r.amount, r.category, r.notes ?? null]) : 'bad'

/** Every device shows the relay's entries, and the same categories, item picks and budgets. */
function expectConverged(...devices: Device[]): void {
  const relayed = relayRows().map(shown).sort()
  const [first] = devices
  for (const d of devices) {
    expect(S(d).expenses.map(shown).sort()).toEqual(relayed)
    if (first === undefined) continue
    expect([...S(d).categories].sort()).toEqual([...S(first).categories].sort())
    expect({ ...S(d).categoryMappings }).toEqual({ ...S(first).categoryMappings })
    expect({ ...S(d).budgets }).toEqual({ ...S(first).budgets })
  }
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
  const phone = await bootDevice({ expenses: rows, v4: categories ? { categories } : {} })
  relay().latency = LATENCY
  await connect(phone)
  await advance(10_000)
  return phone
}

/** Phone and laptop with the same rows (and v4 keys), connected and settled. */
async function pair(
  rows: () => Expense[],
  v4: Omit<V4Seed, 'expenses'> = {},
): Promise<{ phone: Device; laptop: Device }> {
  const phone = await bootDevice({ expenses: rows(), v4 })
  const laptop = await bootDevice({ expenses: rows(), v4 })
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

  it('a renamed-away name stays gone after sync (the rename table; PR-0 brought it back)', async () => {
    const phone = await single([expense('e1', { category: 'Meals' })])
    S(phone).renameCategory('Meals', 'Dining')
    expect(S(phone).categories).not.toContain('Meals')
    await manyCycles(phone)
    expect(S(phone).categories).toContain('Dining')
    expect(S(phone).categories).not.toContain('Meals')
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

describe('two 0.10.0 devices', () => {
  const meals = () => ['e1', 'e2'].map((id) => expense(id, { category: 'Meals' }))

  it('converge to a rename made on one of them: rows, mappings and budget, then go quiet', async () => {
    const { phone, laptop } = await pair(meals, {
      categoryMappings: { kopi: 'Meals' },
      categoryMappingUpdatedAt: { kopi: '2026-10-01T00:00:00.000Z' },
      categoryBudgets: { Meals: 300 },
      categoryBudgetUpdatedAt: { Meals: '2026-10-01T00:00:00.000Z' },
    })
    await advance(MINUTE)
    S(phone).renameCategory('Meals', 'Dining')
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(categoriesOf(d)).toEqual(['Dining', 'Dining'])
      expect(S(d).categories).toContain('Dining')
      expect({ ...S(d).categoryMappings }).toEqual({ kopi: 'Dining' })
      expect({ ...S(d).budgets }).toEqual({ Dining: 300 })
      expect(S(d).categories).not.toContain('Meals')
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
    'a concurrent edit of a re-filed row keeps both: the new name and the edit (%s)',
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

      // Per field: the re-file (no new stamp) and the amount edit both survive, in either order.
      for (const d of [phone, laptop]) {
        expect(rowOf(d, 'e1')).toMatchObject({ category: 'Dining', amount: 9 })
        expect(rowOf(d, 'e2')).toMatchObject({ category: 'Dining' })
        expect(S(d).categories).not.toContain('Meals')
      }
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )

  it("a removal moves the other device's concurrent row to Other: no row is lost (§6.5.3)", async () => {
    const { phone, laptop } = await pair(() => [expense('e1', { category: 'Other' })], {
      categories: ['Other', 'Meals', 'Gym'],
    })
    await advance(MINUTE)
    S(phone).removeCategory('Gym')
    const gym = S(laptop).addExpense({ itemName: 'gym pass', amount: 30, category: 'Gym' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      expect(rowOf(d, gym.id)).toMatchObject({ category: 'Other', amount: 30 })
      expect(S(d).categories).not.toContain('Gym')
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

  it('an item named "__proto__" with a picked category: the entry everywhere, no pick, then quiet', async () => {
    const { phone, laptop } = await pair(() => [])
    S(phone).addExpense({ itemName: '__proto__', amount: 3, category: 'Meals' })
    await advance(MINUTE)

    for (const d of [phone, laptop]) {
      // A reserved key is never learned as an item pick (F-010); the entry itself syncs.
      expect(own(S(d).categoryMappings, '__proto__')).toBeUndefined()
      expect(Object.getPrototypeOf(S(d).categoryMappings)).toBeNull()
      expect(S(d).expenses.find((e) => e.itemName === '__proto__')?.category).toBe('Meals')
    }
    expect(own(relayMappings(), '__proto__')).toBeUndefined()
    expectConverged(phone, laptop)
    await expectQuiet()
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'a category named %s is refused with a readable message, and nothing syncs',
    async (name) => {
      const { phone, laptop } = await pair(() => [])
      const upserts = relay().upserts
      expect(() => {
        S(phone).addCategory(name)
      }).toThrow('That name is reserved. Choose another.')
      expect(() => {
        S(phone).setBudget(name, 100)
      }).toThrow()
      await advance(MINUTE)

      for (const d of [phone, laptop]) {
        expect(own(S(d).budgets, name)).toBeUndefined()
        expect(S(d).categories).not.toContain(name)
      }
      expect(relay().upserts).toBe(upserts)
      expectConverged(phone, laptop)
      await expectQuiet()
    },
  )

  it.each(['Constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'an item named %s with no category picked is filed under Other and reaches the other device',
    async (itemName) => {
      const { phone, laptop } = await pair(() => [])
      const added = S(phone).addExpense({ itemName, amount: 7 })
      expect(added.category).toBe('Other')
      expect({ ...S(phone).categoryMappings }).toEqual({})
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
    const before = S(laptop).budgets
    const undos = S(laptop).undoStack.length
    S(laptop).setBudget('Meals', 200)
    expect(S(laptop).budgets).toBe(before) // no write, so no fresh stamp
    expect(S(laptop).undoStack).toHaveLength(undos)
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
    const phone = await bootDevice({ v4: { categories: ['Other', 'Gym'] } })
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

  it('from a 0.9.2 writer the same tie still goes to the deterministic winner', async () => {
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

  it('a legacy edit it stamped is merged as usual; one it did not stamp loses (rank 0, G2)', async () => {
    const row = expense('k1', { itemName: 'Kitchen towel', category: 'Other', amount: 1 })
    const phone = await single([row, expense('k2', { amount: 1 })])
    writeAsLegacy(SYNC_CODE, {
      ...relayPayload(),
      expenses: [
        { ...row, category: 'Shopping', amount: 2, updatedAt: new Date(NOW - 1000).toISOString() },
        expense('k2', { amount: 5 }), // changed without a stamp: an unstamped mutation
      ],
    })
    await advance(MINUTE)
    expect(rowOf(phone, 'k1')).toMatchObject({ category: 'Shopping', amount: 2 })
    expect(rowOf(phone, 'k2')).toMatchObject({ amount: 1 })
  })

  it('its copy without mapping stamps neither reverts a pick nor draws pushes it will not keep', async () => {
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
    // 0.8.4 keeps its own pick whatever it pulls (local wins), so pushing ours over it would only
    // ping-pong (§11.4): the relay keeps the old device's copy until it updates.
    expect(relayMappings()).toEqual({ grab: 'Transport' })

    // It writes again with the same mappings, only without the stamps: nothing to send.
    const pushes = relay().pushes.length
    writeAsLegacy(SYNC_CODE, { ...relayPayload(), mappingUpdatedAt: undefined })
    await advance(MINUTE)
    expect(relay().pushes.length).toBe(pushes)
    expect(phone.sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      waitingForOld: 0,
    })
  })
})

describe('the currency register (P2-11, acceptance 23)', () => {
  const currencyOf = (d: Device) => d.ui.useUIStore.getState().currency

  it('a currency picked on one device shows on the other after sync, then quiet', async () => {
    const { phone, laptop } = await pair(() => [expense('e1')])
    const own = currencyOf(laptop)
    const picked = own === 'EUR' ? 'JPY' : 'EUR'
    phone.ui.useUIStore.getState().setCurrency(picked)
    expect(currencyOf(phone)).toBe(picked)
    // The laptop never picked: it keeps its own until the pick arrives.
    expect(currencyOf(laptop)).toBe(own)
    await advance(10_000)
    expect(currencyOf(laptop)).toBe(picked)
    await expectQuiet()
  })

  it('the later pick wins on both devices', async () => {
    const { phone, laptop } = await pair(() => [expense('e1')])
    phone.ui.useUIStore.getState().setCurrency('EUR')
    await advance(MINUTE)
    laptop.ui.useUIStore.getState().setCurrency('JPY')
    await advance(MINUTE)
    expect([currencyOf(phone), currencyOf(laptop)]).toEqual(['JPY', 'JPY'])
  })

  it('a 0.9.2 push, which drops x5, leaves the picked currency alone', async () => {
    const { phone, laptop } = await pair(() => [expense('e1')])
    phone.ui.useUIStore.getState().setCurrency('EUR')
    await advance(MINUTE)
    writeAsOther(SYNC_CODE, { ...relayPayload(), ...peer('p1') })
    await advance(MINUTE)
    expect([currencyOf(phone), currencyOf(laptop)]).toEqual(['EUR', 'EUR'])
  })
})
