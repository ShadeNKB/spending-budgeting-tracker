import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupData, Expense } from '../../types'
import { loadDevice, type Device } from '../../__tests__/fakeRelay'

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const T1 = '2026-10-01T04:00:00.000Z'

const row = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  itemName: `item ${id}`,
  amount: 1,
  category: 'Other',
  date: '2026-10-01T12:00:00',
  createdAt: T1,
  ...over,
})

function backup(state: Device['expense']['useExpenseStore']): BackupData {
  return state.getState().exportBackup()
}

/** A deep copy: equal content, no shared objects. */
const copy = <T>(value: T): T => structuredClone(value)

let device: Device
let sharing: typeof import('../applySync')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  device = await loadDevice()
  // The engine's lazy module, in this device's module graph.
  sharing = await import('../applySync')
})

afterEach(() => {
  device.expense.useExpenseStore.setState({ hydrated: false })
  vi.useRealTimers()
})

function seed(over: Partial<BackupData> = {}) {
  device.expense.useExpenseStore.setState({
    hydrated: true,
    expenses: [row('e1'), row('e2', { amount: 2 })],
    categories: ['Other', 'Meals'],
    categoryMappings: { kopi: 'Meals' },
    mappingUpdatedAt: { kopi: T1 },
    budgets: { Meals: 300 },
    budgetUpdatedAt: { Meals: T1 },
    budgetDeletedAt: {},
    deletedIds: ['gone'],
    ...over,
  })
}

describe('applySync', () => {
  it('changes nothing and notifies no one when the data is equal by content', () => {
    seed()
    const store = device.expense.useExpenseStore
    const before = store.getState()
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)

    const changed = sharing.applySync(copy(backup(store)))

    unsubscribe()
    expect(changed).toBe(false)
    expect(notifications).toBe(0)
    const after = store.getState()
    expect(after.expenses).toBe(before.expenses)
    expect(after.categories).toBe(before.categories)
    expect(after.categoryMappings).toBe(before.categoryMappings)
    expect(after.mappingUpdatedAt).toBe(before.mappingUpdatedAt)
    expect(after.budgets).toBe(before.budgets)
    expect(after.budgetUpdatedAt).toBe(before.budgetUpdatedAt)
    expect(after.budgetDeletedAt).toBe(before.budgetDeletedAt)
    expect(after.deletedIds).toBe(before.deletedIds)
  })

  it('treats a reordering of rows, categories and tombstones as no change', () => {
    seed({ deletedIds: ['a', 'b'] })
    const store = device.expense.useExpenseStore
    const before = store.getState()
    const data = copy(backup(store))
    data.expenses.reverse()
    data.deletedIds = ['b', 'a']
    expect(sharing.applySync(data)).toBe(false)
    expect(store.getState().expenses).toBe(before.expenses)
    expect(store.getState().deletedIds).toBe(before.deletedIds)
  })

  it('replaces only the changed record and writes it to storage at once', () => {
    seed()
    const store = device.expense.useExpenseStore
    device.expense.installPersistence()
    const [e1, e2] = store.getState().expenses
    const data = copy(backup(store))
    data.expenses = [data.expenses[0]!, { ...data.expenses[1]!, amount: 20, updatedAt: T1 }]
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)

    expect(sharing.applySync(data)).toBe(true)

    unsubscribe()
    const after = store.getState()
    expect(after.expenses[0]).toBe(e1)
    expect(after.expenses[1]).not.toBe(e2)
    expect(after.expenses[1]?.amount).toBe(20)
    // Flushed synchronously: no 400 ms debounce left to lose on a kill.
    expect(localStorage.getItem('expenses')).toContain('"amount":20')
    expect(localStorage.getItem('spendtrack:app')).toBe('0.8.5')
    expect(notifications).toBeLessThanOrEqual(3)
  })

  it('never re-files categories (F-015)', () => {
    seed({ expenses: [row('t', { itemName: 'Kitchen towel', category: 'Other' })] })
    const store = device.expense.useExpenseStore
    const data = copy(backup(store))
    data.expenses.push(row('g', { itemName: 'GitHub shares', category: 'Investment' }))
    sharing.applySync(data)
    expect(store.getState().expenses.map((e) => [e.itemName, e.category])).toEqual([
      ['Kitchen towel', 'Other'],
      ['GitHub shares', 'Investment'],
    ])
  })

  it('shares rows by content even when the store holds unreadable rows', () => {
    const badDate = row('bad', { date: 'last tuesday' })
    const garbage: unknown = null
    const store = device.expense.useExpenseStore
    // The local store can hold unreadable rows until PR-2 sanitises it; sync passes back the
    // ones it keeps (sync.honesty.test.ts covers which).
    const rows = [row('e1'), badDate, ...([garbage] as Expense[])]
    store.setState({ hydrated: true, expenses: rows })
    const data: BackupData = {
      ...backup(store),
      expenses: [copy(row('e1')), badDate, ...rows.slice(2)],
    }
    expect(sharing.applySync(data)).toBe(false)
    expect(store.getState().expenses).toBe(rows)
  })
})

describe('F-015: user categories survive hydrate and import', () => {
  const fixtures = [
    row('k', { itemName: 'Kitchen towel', category: 'Other' }),
    row('g', { itemName: 'GitHub shares', category: 'Investment' }),
    row('s', { itemName: 'SQL course', category: 'Education' }),
    row('p', { itemName: 'SP Group electricity', category: 'Bills & Utilities' }),
  ]
  const categoriesOf = (expenses: Expense[]) => expenses.map((e) => [e.itemName, e.category])
  const expected = categoriesOf(fixtures)

  it('keeps them through hydrate twice', () => {
    localStorage.setItem('expenses', JSON.stringify(fixtures))
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    store.getState().hydrate()
    expect(categoriesOf(store.getState().expenses)).toEqual(expected)
  })

  it('keeps them through an import', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    store.getState().importBackup({ ...backup(store), expenses: copy(fixtures) })
    expect(categoriesOf(store.getState().expenses)).toEqual(expected)
  })
})

describe('updateExpense', () => {
  it('is a no-op when no field changes: no stamp, no undo entry, no notification', () => {
    seed()
    const store = device.expense.useExpenseStore
    const before = store.getState().expenses
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)
    store.getState().updateExpense('e1', {
      itemName: 'item e1',
      amount: 1,
      category: 'Other',
      date: '2026-10-01T12:00:00',
      notes: undefined,
    })
    unsubscribe()
    expect(notifications).toBe(0)
    expect(store.getState().expenses).toBe(before)
    expect(store.getState().undoStack).toEqual([])
  })

  it('applies only the editable fields that change and stamps now', () => {
    seed()
    const store = device.expense.useExpenseStore
    store
      .getState()
      .updateExpense('e1', { amount: 45, id: 'hijack', createdAt: 'x', category: 'Other' })
    const e1 = store.getState().expenses.find((e) => e.id === 'e1')
    expect(e1).toEqual({ ...row('e1'), amount: 45, updatedAt: new Date(NOW).toISOString() })
  })

  it('stamps strictly after a record whose updatedAt is ahead of this clock', () => {
    const ahead = '2026-10-20T08:00:00.000Z'
    seed({ expenses: [row('e1', { updatedAt: ahead })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 9 })
    expect(store.getState().expenses[0]?.updatedAt).toBe('2026-10-20T08:00:00.001Z')
  })

  it('can clear the notes', () => {
    seed({ expenses: [row('e1', { notes: 'to camp' })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { notes: undefined })
    expect(store.getState().expenses[0]?.notes).toBeUndefined()
  })
})

describe('undo is a forward write (F-011)', () => {
  it('undoes an edit with the previous values and a later stamp', () => {
    seed({ expenses: [row('e1', { amount: 4.5 })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    const editStamp = store.getState().expenses[0]?.updatedAt ?? ''
    const entry = store.getState().undoStack.at(-1)
    expect(entry?.id).toMatch(/^update-e1-/)

    vi.setSystemTime(NOW - 60_000) // even with the clock stepping back
    store.getState().consumeUndo(entry?.id ?? '')

    const e1 = store.getState().expenses[0]
    expect(e1?.amount).toBe(4.5)
    expect(Date.parse(e1?.updatedAt ?? '')).toBeGreaterThan(Date.parse(editStamp))
  })

  it('does nothing when the edited record was deleted meanwhile', () => {
    seed()
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    const entry = store.getState().undoStack.at(-1)
    store.getState().deleteExpense('e1')
    store.getState().consumeUndo(entry?.id ?? '')
    expect(store.getState().expenses.map((e) => e.id)).toEqual(['e2'])
  })

  it('undoes a delete by re-adding the record under a new id; the old id stays dead', () => {
    seed({ expenses: [row('e1', { updatedAt: T1 })] })
    const store = device.expense.useExpenseStore
    store.getState().deleteExpense('e1')
    const entry = store.getState().undoStack.at(-1)
    expect(entry?.id).toMatch(/^del-e1-/)
    store.getState().consumeUndo(entry?.id ?? '')

    const [revived] = store.getState().expenses
    expect(revived?.id).not.toBe('e1')
    expect(revived).toMatchObject({ itemName: 'item e1', amount: 1, createdAt: T1 })
    expect(Date.parse(revived?.updatedAt ?? '')).toBeGreaterThan(Date.parse(T1))
    expect(store.getState().deletedIds).toContain('e1')
  })

  it('keeps add-undo as a tombstone', () => {
    seed({ expenses: [] })
    const store = device.expense.useExpenseStore
    const added = store.getState().addExpense({ itemName: 'kopi', amount: 1.5 })
    store.getState().consumeUndo(`add-${added.id}`)
    expect(store.getState().expenses).toEqual([])
    expect(store.getState().deletedIds).toContain(added.id)
  })
})

const ISO = (ms: number) => new Date(ms).toISOString()
const AHEAD = '2026-10-20T08:00:00.000Z' // a day ahead of this device's clock

describe('item mappings carry a stamp per key', () => {
  it('stamps a newly learned pick, and a changed pick strictly after its last stamp', () => {
    seed({ categoryMappings: {}, mappingUpdatedAt: {} })
    const store = device.expense.useExpenseStore
    store.getState().addExpense({ itemName: 'Grab', amount: 5, category: 'Transport' })
    expect(store.getState().categoryMappings).toEqual({ grab: 'Transport' })
    expect(store.getState().mappingUpdatedAt).toEqual({ grab: ISO(NOW) })

    store.setState({ mappingUpdatedAt: { grab: AHEAD } }) // set on a device whose clock runs ahead
    store.getState().addExpense({ itemName: 'grab ', amount: 5, category: 'Meals' })
    expect(store.getState().categoryMappings).toEqual({ grab: 'Meals' })
    expect(store.getState().mappingUpdatedAt).toEqual({ grab: '2026-10-20T08:00:00.001Z' })
  })

  it('leaves the mappings and their stamps alone when the pick is unchanged or Other', () => {
    seed({ categoryMappings: { kopi: 'Meals' }, mappingUpdatedAt: { kopi: T1 } })
    const store = device.expense.useExpenseStore
    const before = store.getState()
    store.getState().addExpense({ itemName: 'Kopi', amount: 1.5 }) // the learned pick, again
    store.getState().addExpense({ itemName: 'stamps', amount: 2, category: 'Other' })
    expect(store.getState().categoryMappings).toBe(before.categoryMappings)
    expect(store.getState().mappingUpdatedAt).toBe(before.mappingUpdatedAt)
  })

  it('round-trips through export, import, applySync, storage and hydrate', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    store.getState().addExpense({ itemName: 'grab', amount: 5, category: 'Transport' })
    expect(backup(store).mappingUpdatedAt).toEqual({ grab: ISO(NOW) })
    device.expense.flushPendingSave()
    expect(JSON.parse(localStorage.getItem('categoryMappingUpdatedAt') ?? '{}')).toEqual({
      grab: ISO(NOW),
    })

    store.getState().hydrate()
    expect(store.getState().mappingUpdatedAt).toEqual({ grab: ISO(NOW) })

    // A stamp for a key the file has no mapping for is dropped on import.
    store.getState().importBackup({
      ...backup(store),
      categoryMappings: { grab: 'Meals' },
      mappingUpdatedAt: { grab: T1, gone: T1 },
    })
    expect(store.getState().mappingUpdatedAt).toEqual({ grab: T1 })

    const stamped = { ...backup(store), mappingUpdatedAt: { grab: AHEAD } }
    expect(sharing.applySync(stamped)).toBe(true)
    expect(store.getState().mappingUpdatedAt).toEqual({ grab: AHEAD })
    const kept = store.getState().mappingUpdatedAt
    expect(sharing.applySync(copy(backup(store)))).toBe(false)
    expect(store.getState().mappingUpdatedAt).toBe(kept)
  })
})

describe('a category rename or removal is a set of stamped changes', () => {
  it('re-files rows with forward stamps and leaves other rows untouched', () => {
    const other = row('e2')
    seed({ expenses: [row('e1', { category: 'Meals', updatedAt: AHEAD }), other] })
    const store = device.expense.useExpenseStore
    store.getState().renameCategory('Meals', 'Dining')
    const [e1, e2] = store.getState().expenses
    expect(e1).toMatchObject({ category: 'Dining', updatedAt: '2026-10-20T08:00:00.001Z' })
    expect(e2).toBe(other)
  })

  it('points the item mappings at the new name, each with a fresh stamp', () => {
    seed({
      categoryMappings: { kopi: 'Meals', teh: 'Meals', grab: 'Transport' },
      mappingUpdatedAt: { kopi: AHEAD, grab: T1 },
    })
    const store = device.expense.useExpenseStore
    store.getState().renameCategory('Meals', 'Dining')
    expect(store.getState().categoryMappings).toEqual({
      kopi: 'Dining',
      teh: 'Dining',
      grab: 'Transport',
    })
    expect(store.getState().mappingUpdatedAt).toEqual({
      kopi: '2026-10-20T08:00:00.001Z',
      teh: ISO(NOW),
      grab: T1,
    })
  })

  it('moves the budget under a fresh stamp and tombstones the old name', () => {
    seed({ budgets: { Meals: 300 }, budgetUpdatedAt: { Meals: AHEAD }, budgetDeletedAt: {} })
    const store = device.expense.useExpenseStore
    store.getState().renameCategory('Meals', 'Dining')
    expect(store.getState()).toMatchObject({
      budgets: { Dining: 300 },
      budgetUpdatedAt: { Dining: ISO(NOW) },
      // Strictly after the old name's set stamp, so the removal wins the merge everywhere.
      budgetDeletedAt: { Meals: '2026-10-20T08:00:00.001Z' },
    })
  })

  it('keeps an existing target budget and its stamp when renaming onto it', () => {
    seed({
      categories: ['Other', 'Meals', 'Dining'],
      budgets: { Meals: 300, Dining: 100 },
      budgetUpdatedAt: { Meals: T1, Dining: T1 },
      budgetDeletedAt: {},
    })
    const store = device.expense.useExpenseStore
    store.getState().renameCategory('Meals', 'Dining')
    expect(store.getState()).toMatchObject({
      categories: ['Other', 'Dining'],
      budgets: { Dining: 100 },
      budgetUpdatedAt: { Dining: T1 },
      budgetDeletedAt: { Meals: ISO(NOW) },
    })
  })

  it('a removal moves rows and mappings to Other and tombstones the budget, all stamped', () => {
    seed({
      expenses: [row('e1', { category: 'Meals' })],
      categoryMappings: { kopi: 'Meals' },
      mappingUpdatedAt: { kopi: T1 },
      budgets: { Meals: 300 },
      budgetUpdatedAt: { Meals: AHEAD },
    })
    const store = device.expense.useExpenseStore
    store.getState().removeCategory('Meals')
    expect(store.getState()).toMatchObject({
      categories: ['Other'],
      expenses: [{ id: 'e1', category: 'Other', updatedAt: ISO(NOW) }],
      categoryMappings: { kopi: 'Other' },
      mappingUpdatedAt: { kopi: ISO(NOW) },
      budgets: {},
      budgetUpdatedAt: {},
      budgetDeletedAt: { Meals: '2026-10-20T08:00:00.001Z' },
    })
  })

  it('a removal of a name nothing uses changes only the list', () => {
    seed({ categories: ['Other', 'Meals', 'Gym'] })
    const store = device.expense.useExpenseStore
    const before = store.getState()
    store.getState().removeCategory('Gym')
    const after = store.getState()
    expect(after.categories).toEqual(['Other', 'Meals'])
    for (const key of [
      'expenses',
      'categoryMappings',
      'mappingUpdatedAt',
      'budgets',
      'budgetUpdatedAt',
      'budgetDeletedAt',
    ] as const) {
      expect(after[key]).toBe(before[key])
    }
  })

  it('treats an item or category named like an Object prototype key as a plain key', () => {
    const mappings: Record<string, string> = Object.fromEntries([['__proto__', 'Meals']])
    seed({ categoryMappings: mappings, mappingUpdatedAt: {}, budgets: {} })
    const store = device.expense.useExpenseStore
    store.getState().renameCategory('Meals', 'Dining')
    const after = store.getState().categoryMappings
    expect(Object.hasOwn(after, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(after, '__proto__')?.value).toBe('Dining')
    store.getState().removeCategory('constructor') // no own budget of that name: nothing moves
    expect(store.getState().budgetDeletedAt).toEqual({})
  })
})

describe('budget stamps move forward', () => {
  it('a set is stamped strictly after the last set or delete of its key', () => {
    seed({ budgets: { Meals: 300 }, budgetUpdatedAt: { Meals: AHEAD }, budgetDeletedAt: {} })
    const store = device.expense.useExpenseStore
    store.getState().setBudget('Meals', 350)
    expect(store.getState().budgetUpdatedAt.Meals).toBe('2026-10-20T08:00:00.001Z')
    store.getState().setBudget('Gym', 50)
    expect(store.getState().budgetUpdatedAt.Gym).toBe(ISO(NOW))
  })

  it('a removal is stamped strictly after the set it removes; a later set clears it', () => {
    seed({ budgets: { Meals: 300 }, budgetUpdatedAt: { Meals: AHEAD }, budgetDeletedAt: {} })
    const store = device.expense.useExpenseStore
    store.getState().removeBudget('Meals')
    expect(store.getState()).toMatchObject({
      budgets: {},
      budgetUpdatedAt: {},
      budgetDeletedAt: { Meals: '2026-10-20T08:00:00.001Z' },
    })
    store.getState().setBudget('Meals', 200)
    expect(store.getState()).toMatchObject({
      budgets: { Meals: 200 },
      budgetUpdatedAt: { Meals: '2026-10-20T08:00:00.002Z' },
      budgetDeletedAt: {},
    })
  })
})

describe('flushPendingSave', () => {
  it('writes a scheduled save at once and is a no-op otherwise', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    device.expense.flushPendingSave()
    expect(localStorage.getItem('expenses')).toBeNull()

    const added = store.getState().addExpense({ itemName: 'kopi', amount: 1.5 })
    expect(localStorage.getItem('expenses')).toBeNull()
    device.expense.flushPendingSave()
    expect(localStorage.getItem('expenses')).toContain(added.id)
    expect(localStorage.getItem('spendtrack:app')).toBe('0.8.5')
  })
})

// A save that failed (storage full, or WebKit refusing writes on a nearly full iPhone) leaves
// storage behind the store. It must be retried on purpose, by the next flush, even with no new
// change in between: otherwise an OS kill of the hidden app loses everything since.
describe('a save that failed is retried by the next flush', () => {
  const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')
  const hide = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    }
  }
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('when the failed attempt was itself a flush (hidden while storage was full)', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota()
    })
    const added = store.getState().addExpense({ itemName: 'unsaved', amount: 2 })
    hide() // the flush runs at once and fails
    expect(store.getState().syncStatus).toBe('error')
    setItem.mockRestore() // room again
    vi.advanceTimersByTime(60_000) // nothing changes meanwhile
    expect(localStorage.getItem('expenses')).toBeNull()
    hide()
    expect(localStorage.getItem('expenses')).toContain(added.id)
    expect(store.getState().syncStatus).toBe('saved')
  })

  it('when the failed attempt was the debounced save', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota()
    })
    const added = store.getState().addExpense({ itemName: 'unsaved', amount: 2 })
    vi.advanceTimersByTime(400) // the 400 ms save fails
    expect(store.getState().syncStatus).toBe('error')
    setItem.mockRestore()
    device.expense.flushPendingSave()
    expect(localStorage.getItem('expenses')).toContain(added.id)
  })

  it('and a flush after a save that worked writes nothing', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    store.getState().addExpense({ itemName: 'kopi', amount: 1.5 })
    vi.advanceTimersByTime(400)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    device.expense.flushPendingSave()
    hide()
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('the network state at start-up', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  // The store reads navigator.onLine when it loads, and AppShell installs the listeners a little
  // later (its bootstrap effect): going offline in between must still show the offline strip.
  it('is read again when persistence starts listening', () => {
    const store = device.expense.useExpenseStore
    expect(store.getState().isOffline).toBe(false)
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline')) // before anything listens
    expect(store.getState().isOffline).toBe(false)
    device.expense.installPersistence()
    expect(store.getState().isOffline).toBe(true)
  })
})

describe('the persistence layer flushes on hide by itself', () => {
  it('without a sync code (no engine loaded), an add is in localStorage when the app is hidden', () => {
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    const added = store.getState().addExpense({ itemName: 'kopi', amount: 1.5 })
    expect(localStorage.getItem('expenses')).toBeNull() // the 400 ms save has not run

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    }
    expect(localStorage.getItem('expenses')).toContain(added.id)
  })
})

describe('budgets: a set that changes nothing writes nothing', () => {
  it('re-setting the value a budget has keeps every object (no stamp, no save, no sync)', () => {
    seed()
    const store = device.expense.useExpenseStore
    const before = store.getState()
    store.getState().setBudget('Meals', 300)
    const after = store.getState()
    expect(after.budgets).toBe(before.budgets)
    expect(after.budgetUpdatedAt).toBe(before.budgetUpdatedAt)
    expect(after.budgetDeletedAt).toBe(before.budgetDeletedAt)
    store.getState().setBudget('Meals', 301)
    expect(store.getState().budgets.Meals).toBe(301)
  })

  it('refuses an amount that is not a finite number above zero', () => {
    seed()
    const store = device.expense.useExpenseStore
    const before = store.getState().budgets
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      store.getState().setBudget('Meals', amount)
      store.getState().setBudget('Gym', amount)
    }
    expect(store.getState().budgets).toBe(before)
  })
})

describe('names that are also Object.prototype keys', () => {
  it.each(['constructor', 'Constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    '%s has no learned category until one is picked, and then exactly that one',
    (itemName) => {
      seed({ categoryMappings: {}, mappingUpdatedAt: {} })
      const store = device.expense.useExpenseStore
      expect(store.getState().getSmartCategory(itemName)).toBeNull()
      const first = store.getState().addExpense({ itemName, amount: 7 })
      expect(first.category).toBe('Other')
      expect(store.getState().categoryMappings).toEqual({})

      store.getState().addExpense({ itemName, amount: 7, category: 'Meals' })
      const key = itemName.toLowerCase()
      expect(Object.hasOwn(store.getState().categoryMappings, key)).toBe(true)
      expect(store.getState().getSmartCategory(itemName)).toBe('Meals')
      expect(store.getState().addExpense({ itemName, amount: 7 }).category).toBe('Meals')
    },
  )

  it('a budget for a category named "constructor" is stamped with its own stamp', () => {
    seed()
    const store = device.expense.useExpenseStore
    sharing.applySync({
      ...backup(store),
      budgets: { constructor: 40 },
      budgetUpdatedAt: {},
      budgetDeletedAt: {},
    })
    // Not Object's constructor function: the key has no stamp, so the legacy one.
    expect(store.getState().budgetUpdatedAt).toEqual({ constructor: '1970-01-01T00:00:00.000Z' })
  })
})

describe('rows in storage that are not objects', () => {
  it('a null row is dropped on load; adds, undo and every row reader keep working', () => {
    localStorage.setItem(
      'expenses',
      JSON.stringify([null, row('e1', { itemName: 'Chicken rice' })]),
    )
    const store = device.expense.useExpenseStore
    store.getState().hydrate()
    device.expense.installPersistence()
    expect(store.getState().expenses).toEqual([row('e1', { itemName: 'Chicken rice' })])

    const added = store.getState().addExpense({ itemName: 'kopi 2', amount: 2 })
    const undo = store.getState().undoStack.at(-1)
    if (!undo) throw new Error('no undo entry')
    store.getState().consumeUndo(undo.id)
    expect(store.getState().expenses.map((e) => e.id)).toEqual(['e1'])
    expect(store.getState().deletedIds).toContain(added.id)
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(localStorage.getItem('expenses') ?? '[]')).toEqual([
      row('e1', { itemName: 'Chicken rice' }),
    ])
  })
})
