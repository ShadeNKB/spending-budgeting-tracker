// Two tabs on one device (§9.9, P2-17, track spec §8.8; F-003): read-merge-write on every flush,
// storage events, and the fold of an old 0.9.2 tab's whole-array writes. Absence is never deletion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V085Client } from '../../__tests__/legacy/v085'
import { must } from '../../__tests__/support/must'
import { makeRng } from '../../__tests__/support/rng'
import { FakeBacking } from './fakeStorage'
import { bootTab, settle, type Tab } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Lets storage events reach the other tab and its debounces run. */
async function quiet(backing: FakeBacking): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await settle()
    backing.deliver()
    vi.advanceTimersByTime(250)
  }
  await settle()
}

const names = (t: Tab): string[] =>
  t.store
    .getState()
    .expenses.map((e) => e.itemName)
    .sort()

async function twoTabs(
  keys?: Readonly<Record<string, string>>,
): Promise<readonly [Tab, Tab, FakeBacking]> {
  const backing = new FakeBacking()
  const a = await bootTab({ backing, install: true, ...(keys === undefined ? {} : { keys }) })
  const b = await bootTab({ backing, install: true })
  return [a, b, backing]
}

describe('two 0.10.0 tabs', () => {
  it('never lose each other’s adds, even when both write before either hears the other', async () => {
    const [a, b, backing] = await twoTabs()
    a.store.getState().addExpense({ itemName: 'From A', amount: 1 })
    b.store.getState().addExpense({ itemName: 'From B', amount: 2 })
    await quiet(backing)
    expect(names(a)).toEqual(['From A', 'From B'])
    expect(names(b)).toEqual(['From A', 'From B'])
    const c = await bootTab({ backing })
    expect(names(c)).toEqual(['From A', 'From B'])
  })

  it('keep deletes, edits, undos and renames made in either tab', async () => {
    const [a, b, backing] = await twoTabs(ownerV4({ rows: 30, noSync: true }).keys)
    await quiet(backing)
    const doomed = must(a.store.getState().expenses[0])
    const edited = must(a.store.getState().expenses[1])
    a.store.getState().deleteExpense(doomed.id)
    b.store.getState().updateExpense(edited.id, { amount: 123 })
    await quiet(backing)
    const added = b.store.getState().addExpense({ itemName: 'Undone in B', amount: 9 })
    await quiet(backing)
    expect(b.store.getState().consumeUndo(`add-${added.id}`)).toEqual({ applied: 1, skipped: 0 })
    a.store.getState().renameCategory('Shopping', 'Retail')
    await quiet(backing)
    for (const t of [a, b, await bootTab({ backing })]) {
      const s = t.store.getState()
      expect(s.expenses.some((e) => e.id === doomed.id)).toBe(false)
      expect(s.expenses.find((e) => e.id === edited.id)?.amount).toBe(123)
      expect(s.expenses.some((e) => e.itemName === 'Undone in B')).toBe(false)
      expect(s.categories).toContain('Retail')
      expect(s.categories).not.toContain('Shopping')
      expect(s.expenses.some((e) => e.category === 'Shopping')).toBe(false)
    }
  })

  it("another tab's mirror write does not make this tab fold (P2-17)", async () => {
    const [a, b, backing] = await twoTabs(ownerV4({ rows: 20, noSync: true }).keys)
    await quiet(backing)
    a.store.getState().addExpense({ itemName: 'Mirror me', amount: 4 })
    await settle()
    vi.advanceTimersByTime(1100)
    const before = b.store.getState().expenses
    backing.resetCounts()
    await quiet(backing)
    // B absorbed A's envelope (one new row) and wrote nothing back: no fold, no echo
    expect(b.store.getState().expenses.length).toBe(before.length)
    expect(backing.sets.filter((k) => k === 'st5:db')).toEqual([])
  })
})

describe('a stale 0.9.2 tab beside 0.10.0', () => {
  it('cannot remove anything the 0.10.0 tab holds; its own add folds in', async () => {
    const backing = new FakeBacking()
    const f = ownerV4({ rows: 40, noSync: true })
    // the old tab loaded the v4 keys before the upgrade, then idled
    const oldData = backing.view()
    for (const [k, v] of Object.entries(f.keys)) backing.data.set(k, v)
    const old = new V085Client(
      { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined },
      makeRng(3).next,
      oldData,
      {
        pull: () => Promise.resolve(null),
        push: () => Promise.resolve(),
        subscribe: () => () => undefined,
      },
    )
    old.hydrate()
    const tab = await bootTab({ backing, install: true })
    const added = tab.store.getState().addExpense({ itemName: 'Only on 0.10.0', amount: 5 })
    await quiet(backing)
    vi.advanceTimersByTime(1100)
    // the old tab now writes its stale whole arrays (without the 0.10.0 add) plus its own add
    old.addExpense({ itemName: 'Added in the old tab', amount: 7 })
    old.flushPendingSave()
    await quiet(backing)
    const s = tab.store.getState()
    expect(s.expenses.some((e) => e.id === added.id)).toBe(true)
    expect(s.expenses.some((e) => e.itemName === 'Added in the old tab')).toBe(true)
    expect(s.expenses).toHaveLength(
      42 - f.tombstones.filter((id) => f.rows.some((r) => r.id === id)).length,
    )
    // the mirror is ours again (with both adds), so the same keys never fold twice
    expect(String(backing.data.get('expenses'))).toContain('Only on 0.10.0')
    expect(backing.data.get('spendtrack:app')).toBe('5')
    backing.resetCounts()
    await quiet(backing)
    expect(backing.setsOf('st5:db')).toBe(0)
  })

  it('a delete made in the old tab is applied (only its tombstones delete)', async () => {
    const backing = new FakeBacking()
    const f = ownerV4({ rows: 10, tombstones: 0, noSync: true })
    for (const [k, v] of Object.entries(f.keys)) backing.data.set(k, v)
    const tab = await bootTab({ backing, install: true })
    vi.advanceTimersByTime(1100)
    const old = new V085Client(
      { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined },
      makeRng(4).next,
      backing.view(),
      {
        pull: () => Promise.resolve(null),
        push: () => Promise.resolve(),
        subscribe: () => () => undefined,
      },
    )
    old.hydrate()
    const victim = must(old.s.expenses[0])
    old.deleteExpense(victim.id)
    old.flushPendingSave()
    await quiet(backing)
    expect(tab.store.getState().expenses.some((e) => e.id === victim.id)).toBe(false)
    expect(tab.store.getState().expenses).toHaveLength(9)
  })
})
