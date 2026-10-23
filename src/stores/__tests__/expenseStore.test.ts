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

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  device = await loadDevice()
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

    const changed = store.getState().applySync(copy(backup(store)))

    unsubscribe()
    expect(changed).toBe(false)
    expect(notifications).toBe(0)
    const after = store.getState()
    expect(after.expenses).toBe(before.expenses)
    expect(after.categories).toBe(before.categories)
    expect(after.categoryMappings).toBe(before.categoryMappings)
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
    expect(store.getState().applySync(data)).toBe(false)
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

    expect(store.getState().applySync(data)).toBe(true)

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
    store.getState().applySync(data)
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
    expect(store.getState().applySync(data)).toBe(false)
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
    expect(device.expense.pendingEditsSnapshot().edits.size).toBe(0)
  })

  it('applies only the editable fields that change and stamps now', () => {
    seed()
    const store = device.expense.useExpenseStore
    store
      .getState()
      .updateExpense('e1', { amount: 45, id: 'hijack', createdAt: 'x', category: 'Other' })
    const e1 = store.getState().expenses.find((e) => e.id === 'e1')
    expect(e1).toEqual({ ...row('e1'), amount: 45, updatedAt: new Date(NOW).toISOString() })
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toEqual({
      fields: new Set(['amount']),
      baseStamp: Date.parse(T1),
      base: { amount: 1 },
      own: new Map([['amount', [1, 45]]]),
    })
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
    device.expense.ackPendingEdits(device.expense.pendingEditsSnapshot().seq)

    vi.setSystemTime(NOW - 60_000) // even with the clock stepping back
    store.getState().consumeUndo(entry?.id ?? '')

    const e1 = store.getState().expenses[0]
    expect(e1?.amount).toBe(4.5)
    expect(Date.parse(e1?.updatedAt ?? '')).toBeGreaterThan(Date.parse(editStamp))
    // Pending again, built on the acknowledged edit it reverts.
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toEqual({
      fields: new Set(['amount']),
      baseStamp: Date.parse(editStamp),
      base: { amount: 45 },
      own: new Map([['amount', [45, 4.5]]]),
    })
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

describe('pending field edits', () => {
  it('acknowledges only the entries made up to a snapshot', () => {
    seed()
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 7 })
    const snap = device.expense.pendingEditsSnapshot()
    store.getState().updateExpense('e2', { notes: 'later' })
    device.expense.ackPendingEdits(snap.seq)
    const edits = device.expense.pendingEditsSnapshot().edits
    expect(edits.has('e1')).toBe(false)
    expect(edits.get('e2')?.fields).toEqual(new Set(['notes']))
    device.expense.clearPendingEdits()
    expect(device.expense.pendingEditsSnapshot().edits.size).toBe(0)
  })

  it('hands out a snapshot that later edits do not change', () => {
    seed()
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 7 })
    const snap = device.expense.pendingEditsSnapshot()
    store.getState().updateExpense('e1', { itemName: 'renamed' })
    expect(snap.edits.get('e1')?.fields).toEqual(new Set(['amount']))
  })

  it('keeps the base of a field from its first edit, and takes each new field at its own', () => {
    seed({ expenses: [row('e1', { amount: 4.5, notes: 'a', updatedAt: T1 })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    store.getState().updateExpense('e1', { amount: 46, notes: 'b' })
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toEqual({
      fields: new Set(['amount', 'notes']),
      baseStamp: Date.parse(T1),
      base: { amount: 4.5, notes: 'a' },
      // Every value this device held: a relay copy holding any of them changed nothing.
      own: new Map<string, unknown[]>([
        ['amount', [4.5, 45, 46]],
        ['notes', ['a', 'b']],
      ]),
    })
  })

  it("moves the base to another device's newer copy, never to an older one", () => {
    seed({ expenses: [row('e1', { amount: 4.5, updatedAt: T1 })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    const newer = row('e1', { amount: 9, updatedAt: '2026-10-05T00:00:00.000Z' })
    device.expense.notePendingBase('e1', row('e1', { amount: 1, updatedAt: T1 }), null)
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')?.base).toEqual({ amount: 4.5 })
    device.expense.notePendingBase('e1', newer, null)
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toMatchObject({
      baseStamp: Date.parse('2026-10-05T00:00:00.000Z'),
      base: { amount: 9 },
      // That copy's value joins every value held before: the base and the edit stay.
      own: new Map([['amount', [4.5, 45, 9]]]),
    })
    device.expense.notePendingBase('e2', newer, null) // nothing pending: no entry is created
    expect(device.expense.pendingEditsSnapshot().edits.has('e2')).toBe(false)
  })

  it('never moves the base to a copy this device wrote (its own push read back)', () => {
    seed({ expenses: [row('e1', { amount: 4.5, updatedAt: T1 })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    const mine = store.getState().expenses[0]
    if (!mine) throw new Error('no e1')
    device.expense.notePendingBase('e1', mine, null)
    // A stale copy from another device, newer than the base but older than ours, is still news.
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toMatchObject({
      baseStamp: Date.parse(T1),
      own: new Map([['amount', [4.5, 45]]]),
    })

    // A copy the rebase wrote here is this device's own as well.
    const theirs = row('e1', {
      amount: 4.5,
      notes: 'laptop',
      updatedAt: '2026-10-19T08:00:01.000Z',
    })
    const rebased = { ...theirs, amount: 45, updatedAt: '2026-10-19T08:00:01.001Z' }
    device.expense.notePendingBase('e1', theirs, rebased)
    device.expense.notePendingBase('e1', rebased, null)
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')?.baseStamp).toBe(
      Date.parse(theirs.updatedAt ?? ''),
    )
  })

  it('acknowledges field by field: a later edit of another field of the record stays', () => {
    seed({ expenses: [row('e1', { amount: 4.5, notes: 'a', updatedAt: T1 })] })
    const store = device.expense.useExpenseStore
    store.getState().updateExpense('e1', { amount: 45 })
    const pushed = device.expense.pendingEditsSnapshot().seq
    store.getState().updateExpense('e1', { notes: 'b' })
    device.expense.ackPendingEdits(pushed)
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')).toEqual({
      fields: new Set(['notes']),
      baseStamp: Date.parse(T1),
      base: { amount: 4.5, notes: 'a' },
      own: new Map([['notes', ['a', 'b']]]),
    })
    // A field written again after the acknowledged push stays too.
    store.getState().updateExpense('e1', { amount: 50 })
    device.expense.ackPendingEdits(pushed)
    expect(device.expense.pendingEditsSnapshot().edits.get('e1')?.fields).toEqual(
      new Set(['notes', 'amount']),
    )
    device.expense.ackPendingEdits(device.expense.pendingEditsSnapshot().seq)
    expect(device.expense.pendingEditsSnapshot().edits.size).toBe(0)
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
