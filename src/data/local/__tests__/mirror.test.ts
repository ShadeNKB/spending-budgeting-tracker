// The v4 mirror (§9.10, §18.3, track spec §8.4; F-097, I10): crash-ordered, sum first, and what a
// rollback to 0.9.2 (or 0.8.4) boots from. Checked against the frozen clients themselves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V084Client, mergeBackups as merge084 } from '../../__tests__/legacy/v084'
import type { ClockPort, StoragePort } from '../../__tests__/legacy/v084'
import { V085Client, mergeBackups as merge085 } from '../../__tests__/legacy/v085'
import { must } from '../../__tests__/support/must'
import { makeRng } from '../../__tests__/support/rng'
import { MIRROR_ORDER } from '../../core/constants'
import { FakeBacking } from './fakeStorage'
import { bootTab, hidePage, settle, stored } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

const clockAt = (t: number): ClockPort => ({
  now: () => t,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
})

const noRelay = {
  pull: () => Promise.resolve(null),
  push: () => Promise.resolve(),
  subscribe: () => () => undefined,
}

/** A storage port over a plain copy of the keys (what a rolled-back build would find). */
function portOver(data: Map<string, string>): StoragePort {
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    },
    removeItem: (k) => {
      data.delete(k)
    },
  }
}

function v092(data: Map<string, string>): V085Client {
  const c = new V085Client(clockAt(T0 + 3_600_000), makeRng(9).next, portOver(data), noRelay)
  c.hydrate()
  return c
}

function v084(data: Map<string, string>): V084Client {
  const c = new V084Client(clockAt(T0 + 3_600_000), makeRng(9).next, portOver(data), noRelay)
  c.hydrate()
  return c
}

/** The ids of `want` that the stored list lacks (a Set: arrayContaining is quadratic). */
function missingFrom(list: unknown, want: readonly string[]): string[] {
  const have = new Set(Array.isArray(list) ? list : [])
  return want.filter((id) => !have.has(id))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the mirror write', () => {
  it('saves the sum in the envelope before the keys, then writes them in MIRROR_ORDER and the marker', async () => {
    const { store, backing } = await bootTab({ keys: ownerV4({ rows: 30, noSync: true }).keys })
    vi.advanceTimersByTime(2000)
    backing.resetCounts()
    const first = must(store.getState().expenses[0])
    store.getState().deleteExpense(first.id)
    store.getState().setBudget('Shopping', 99)
    await settle()
    vi.advanceTimersByTime(1000)
    const order = backing.sets.filter((k) => k !== 'st5:gen')
    // the commit's flush, then the sum-first flush, then the changed keys in crash order
    expect(order[0]).toBe('st5:db')
    expect(order[1]).toBe('st5:db')
    const written = order.slice(2).filter((k) => k !== 'spendtrack:app')
    const expected = MIRROR_ORDER.filter((k) => written.includes(k))
    expect(written).toEqual(expected)
    expect(written.indexOf('deletedExpenseIds')).toBeLessThan(written.indexOf('expenses'))
    expect(backing.data.get('spendtrack:app')).toBe('5')
  })

  it('is debounced 1 s after commits and flushed at once on hide', async () => {
    const { store, backing } = await bootTab({ install: true })
    store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    await settle()
    expect(backing.data.has('expenses')).toBe(false)
    hidePage()
    expect(String(backing.data.get('expenses'))).toContain('Kopi')
  })

  it('catches up after a crash inside the debounce: the next boot rewrites a lagging mirror', async () => {
    const a = await bootTab({ install: true })
    a.store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    hidePage()
    a.store.getState().addExpense({ itemName: 'Teh tarik', amount: 1.6 })
    await settle()
    expect(String(a.backing.data.get('st5:db'))).toContain('Teh tarik')
    expect(String(a.backing.data.get('expenses'))).not.toContain('Teh tarik')
    // the renderer dies before the mirror's idle timer: that tab never runs again
    vi.clearAllTimers()
    const b = await bootTab({ backing: a.backing })
    expect(String(b.backing.data.get('expenses'))).not.toContain('Teh tarik')
    await vi.advanceTimersByTimeAsync(1100)
    expect(String(b.backing.data.get('expenses'))).toContain('Teh tarik')
    // and a mirror that is already current is left alone
    b.backing.resetCounts()
    await bootTab({ backing: b.backing })
    await vi.advanceTimersByTimeAsync(1100)
    expect(b.backing.sets).toEqual([])
  })

  it('leaves a pristine origin unwritten after the idle check: no envelope or mirror until the first commit', async () => {
    const { store, backing } = await bootTab({ install: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(backing.data.has('st5:db')).toBe(false)
    expect(MIRROR_ORDER.filter((k) => backing.data.has(k))).toEqual([])
    store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    await settle()
    expect(backing.data.has('st5:db')).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(String(backing.data.get('expenses'))).toContain('Kopi')
  })

  it('a re-run hydrate never leaves a pending mirror behind: the new boot catches it up (P2-14)', async () => {
    const a = await bootTab({ install: true })
    a.store.getState().addExpense({ itemName: 'Kaya toast', amount: 2.2 })
    await settle()
    expect(String(a.backing.data.get('expenses'))).not.toContain('Kaya toast')
    await a.store.getState().hydrate()
    await vi.advanceTimersByTimeAsync(1100)
    expect(String(a.backing.data.get('expenses'))).toContain('Kaya toast')
  })

  it("folds in an old tab's save that lands inside the fold debounce before it writes over it (F-003)", async () => {
    const a = await bootTab({ install: true })
    a.store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    hidePage()
    // a stale 0.9.2 tab saves its whole arrays; its storage event is still on the way
    const old = v092(a.backing.data)
    old.addExpense({ itemName: 'Saved on 0.9.2', amount: 3.3, category: 'Food & Dining' })
    old.flushPendingSave()
    expect(String(a.backing.data.get('expenses'))).toContain('Saved on 0.9.2')
    // this tab changes something, and the page hides before the 200 ms fold debounce
    a.store.getState().addExpense({ itemName: 'Teh tarik', amount: 1.6 })
    hidePage()
    const mirror = String(a.backing.data.get('expenses'))
    expect(mirror).toContain('Saved on 0.9.2')
    expect(mirror).toContain('Teh tarik')
    expect(String(a.backing.data.get('st5:db'))).toContain('Saved on 0.9.2')
    expect(a.store.getState().expenses.map((e) => e.itemName)).toContain('Saved on 0.9.2')
  })

  it('round-trips 10,000 tombstones through the envelope and the mirror (F-013)', async () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `dead-${String(i)}`)
    const keys = {
      ...ownerV4({ rows: 10, tombstones: 0 }).keys,
      deletedExpenseIds: JSON.stringify(ids),
    }
    const { store, backing } = await bootTab({ keys })
    store.getState().addExpense({ itemName: 'Nudge', amount: 1 })
    await settle()
    vi.advanceTimersByTime(1000)
    expect(missingFrom(stored(backing, 'deletedExpenseIds'), ids)).toEqual([])
    const again = await bootTab({ backing })
    again.store.getState().addExpense({ itemName: 'Again', amount: 1 })
    await settle()
    vi.advanceTimersByTime(1000)
    expect(missingFrom(stored(backing, 'deletedExpenseIds'), ids)).toEqual([])
  })

  it('is shed visibly under quota: rollback copy off, stale v4 keys removed, envelope kept', async () => {
    const backing = new FakeBacking()
    const { store } = await bootTab({ backing, keys: ownerV4({ rows: 20 }).keys })
    vi.advanceTimersByTime(2000)
    backing.failures.set('expenses', 'quota')
    store.getState().addExpense({ itemName: 'Too big for the mirror', amount: 1 })
    await settle()
    vi.advanceTimersByTime(1000)
    expect(store.getState().facts.mirror).toBe('off')
    expect(backing.data.has('categoryBudgets')).toBe(false)
    expect(backing.data.has('st5:db')).toBe(true)
    expect(store.getState().local).toBe('saved')
    // the next boot does not mistake the missing mirror for anything
    const again = await bootTab({ backing })
    expect(again.store.getState().expenses).toHaveLength(store.getState().expenses.length)
  })
})

describe('rollback to 0.9.2 and forward again (§18.3)', () => {
  it('0.9.2 boots from the mirror with every live entry, mapping (with stamps) and budget, none of the deleted', async () => {
    const f = ownerV4()
    const tab = await bootTab({ keys: f.keys, install: true })
    const st = tab.store.getState()
    const victim = must(st.expenses[3])
    st.deleteExpense(victim.id)
    st.updateExpense(must(st.expenses[5]).id, { amount: 77 })
    st.addExpense({ itemName: 'Added on 0.10.0', amount: 6.5, category: 'Shopping' })
    hidePage()
    const live = tab.store.getState().expenses
    const old = v092(new Map(tab.backing.data))
    expect(old.s.expenses.map((e) => e.id).sort()).toEqual(live.map((e) => e.id).sort())
    const byId = new Map(old.s.expenses.map((e) => [e.id, e]))
    for (const v of live) {
      const e = must(byId.get(v.id))
      expect([e.itemName, e.amount, e.category, e.date, e.notes]).toEqual([
        v.itemName,
        v.amount,
        v.category,
        v.date,
        v.notes,
      ])
    }
    expect(old.s.categoryMappings).toEqual({ ...tab.store.getState().categoryMappings })
    for (const [k, at] of Object.entries(f.mappingStamps)) {
      expect(Date.parse(must(old.s.mappingUpdatedAt[k]))).toBe(Date.parse(at))
    }
    expect(old.s.budgets).toEqual({ ...tab.store.getState().budgets })
    expect(old.s.deletedIds).toContain(victim.id)
  })

  it('an entry added on 0.9.2 after the rollback is folded in by 0.10.0, with nothing lost', async () => {
    const f = ownerV4({ rows: 120 })
    const a = await bootTab({ keys: f.keys, install: true })
    a.store.getState().addExpense({ itemName: 'Before rollback', amount: 3 })
    hidePage()
    const before = a.store.getState().expenses.map((e) => e.id)
    const data = new Map(a.backing.data)
    const old = v092(data)
    old.addExpense({ itemName: 'Added on 0.9.2', amount: 8, category: 'Gaming' })
    old.flushPendingSave()
    expect(data.get('spendtrack:app')).toBe('0.8.5')
    const backing = new FakeBacking()
    for (const [k, v] of data) backing.data.set(k, v)
    const b = await bootTab({ backing })
    const ids = b.store.getState().expenses.map((e) => e.id)
    for (const id of before) expect(ids).toContain(id)
    expect(b.store.getState().expenses.some((e) => e.itemName === 'Added on 0.9.2')).toBe(true)
  })
})

describe('a mirror torn at any of its keys never lets a rolled-back build resurrect a deleted row', () => {
  for (let cut = 0; cut <= MIRROR_ORDER.length; cut++) {
    it(`torn after ${String(cut)} of ${String(MIRROR_ORDER.length)} keys`, async () => {
      const f = ownerV4({ rows: 60, tombstones: 5, noSync: true })
      const a = await bootTab({ keys: f.keys, install: true })
      hidePage()
      const before = new Map(a.backing.data)
      const liveBefore = a.store.getState().expenses.map((e) => e.id)
      const victims = liveBefore.slice(0, 3)
      for (const id of victims) a.store.getState().deleteExpense(id)
      a.store.getState().setBudget('Travel', 250)
      hidePage()
      const after = new Map(a.backing.data)
      // crash: the envelope (with the new sum) is down, the mirror only up to `cut`
      const torn = new Map(after)
      MIRROR_ORDER.forEach((k, i) => {
        const v = i < cut ? after.get(k) : before.get(k)
        if (v === undefined) torn.delete(k)
        else torn.set(k, v)
      })
      // I10: whenever the new expenses key is down, the new tombstones are too
      const tombs = JSON.stringify(torn.get('deletedExpenseIds') ?? '[]')
      for (const id of victims) {
        if (!String(torn.get('expenses')).includes(id)) expect(tombs).toContain(id)
      }
      // 0.9.2 and 0.8.4 never push a victim live over a relay that already has the deletion
      const relayCopy = {
        ...v092(new Map(after)).exportBackup(),
      }
      for (const rolled of [v092(new Map(torn)), v084(new Map(torn))]) {
        const local = rolled.exportBackup()
        const pushed =
          rolled instanceof V085Client
            ? merge085(local, relayCopy, clockAt(T0))
            : merge084(local, relayCopy, clockAt(T0))
        for (const id of victims) expect(pushed.expenses.some((e) => e.id === id)).toBe(false)
      }
      // and forward again, 0.10.0 keeps every victim deleted
      const backing = new FakeBacking()
      for (const [k, v] of torn) backing.data.set(k, v)
      const b = await bootTab({ backing })
      for (const id of victims)
        expect(b.store.getState().expenses.some((e) => e.id === id)).toBe(false)
      // nor under another id: a victim folded back in as a revived copy (a new id) is the same
      // resurrection, so the live set is exactly what was left
      expect(
        b.store
          .getState()
          .expenses.map((e) => e.id)
          .sort(),
      ).toEqual(liveBefore.filter((id) => !victims.includes(id)).sort())
      expect(b.store.getState().budgets.Travel).toBe(250)
    })
  }
})
