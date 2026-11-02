// The write path (§9.3–§9.6.3, track spec §8.3, §8.5): write-through on a microtask (F-017), one
// atomic setItem per flush (F-097), honest quota handling, and a recovery ladder that never deletes
// (F-014).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { FakeBacking } from './fakeStorage'
import { bootTab, envelopeDoc, hidePage, settle } from './harness'
import { ownerV4, truncated } from './fixtures/v4Owner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const rowsIn = (backing: FakeBacking): readonly unknown[] => {
  const ex = envelopeDoc(backing).expenses
  return Array.isArray(ex) ? ex : []
}

describe('write-through (F-017)', () => {
  it('an add is in st5:db within one microtask', async () => {
    const { store, backing } = await bootTab()
    store.getState().addExpense({ itemName: 'Chicken rice', amount: 4.5 })
    expect(backing.data.has('st5:db')).toBe(false)
    await Promise.resolve()
    expect(rowsIn(backing)).toHaveLength(1)
  })

  it('an add is in storage when the page is hidden in the same task', async () => {
    const { store, backing } = await bootTab({ install: true })
    store.getState().addExpense({ itemName: 'Grab to camp', amount: 21 })
    hidePage()
    expect(rowsIn(backing)).toHaveLength(1)
    // the mirror is flushed on hide too
    expect(String(backing.data.get('expenses'))).toContain('Grab to camp')
  })

  it('several commits in one task make one flush', async () => {
    const { store, backing } = await bootTab()
    store.getState().addExpense({ itemName: 'Seed', amount: 1 })
    await settle()
    backing.resetCounts()
    store.getState().addExpense({ itemName: 'A', amount: 1 })
    store.getState().addExpense({ itemName: 'B', amount: 2 })
    store.getState().addExpense({ itemName: 'C', amount: 3 })
    await settle()
    expect(backing.setsOf('st5:db')).toBe(1)
    expect(backing.setsOf('st5:gen')).toBe(1)
    expect(rowsIn(backing)).toHaveLength(4)
  })
})

describe('one atomic write per flush (F-097)', () => {
  it('writes exactly one st5:db (+ st5:gen) per flush and no v4 key until the mirror runs', async () => {
    vi.useFakeTimers()
    const { store, backing } = await bootTab({ keys: ownerV4({ rows: 50 }).keys })
    store.getState().addExpense({ itemName: 'Warm up', amount: 1 })
    await settle()
    vi.advanceTimersByTime(2000)
    backing.resetCounts()
    store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    await settle()
    expect(backing.sets).toEqual(['st5:db', 'st5:gen'])
    vi.advanceTimersByTime(1000)
    expect(backing.sets.filter((k) => k === 'st5:db')).toHaveLength(2)
    expect(backing.sets).toContain('expenses')
  })

  it('a quota error shows "error-quota", never "saved", and retries on the next commit and every 30 s', async () => {
    vi.useFakeTimers()
    const { store, backing } = await bootTab()
    store.getState().addExpense({ itemName: 'First', amount: 1 })
    await settle()
    expect(store.getState().local).toBe('saved')
    backing.failures.set('st5:db', 'quota')
    store.getState().addExpense({ itemName: 'Second', amount: 2 })
    await settle()
    expect(store.getState().local).toBe('error-quota')
    expect(store.getState().syncStatus).toBe('error')
    expect(rowsIn(backing)).toHaveLength(1)
    // a commit retries
    backing.resetCounts()
    store.getState().addExpense({ itemName: 'Third', amount: 3 })
    await settle()
    expect(backing.setsOf('st5:db')).toBeGreaterThan(0)
    expect(store.getState().local).toBe('error-quota')
    // and so does the timer, once storage has room again
    backing.failures.delete('st5:db')
    vi.advanceTimersByTime(30_000)
    expect(store.getState().local).toBe('saved')
    expect(rowsIn(backing)).toHaveLength(3)
  })

  it('sheds the oldest daily snapshot to make room before it gives up', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 1, 4))
    const { store, backing } = await bootTab({ keys: ownerV4({ rows: 60 }).keys })
    // a daily snapshot from more than a week ago
    vi.setSystemTime(Date.UTC(2026, 9, 19, 4))
    store.getState().addExpense({ itemName: 'Today', amount: 1 })
    await settle()
    const snaps = [...backing.data.keys()].filter((k) => k.startsWith('st5:snap:'))
    expect(snaps.length).toBeGreaterThan(0)
    backing.quota = backing.used() + 50
    store.getState().addExpense({ itemName: 'Squeezed in', amount: 2 })
    await settle()
    expect(store.getState().local).toBe('saved')
  })
})

describe('the recovery ladder (F-014)', () => {
  it('recovers a truncated envelope from the mirror and the snapshots, with the recovered report', async () => {
    vi.useFakeTimers()
    const f = ownerV4({ rows: 80, tombstones: 6 })
    const a = await bootTab({ keys: f.keys })
    a.store.getState().addExpense({ itemName: 'After migration', amount: 9 })
    await settle()
    vi.advanceTimersByTime(1500)
    const raw = must(a.backing.data.get('st5:db'))
    a.backing.data.set('st5:db', truncated(raw, 200))
    a.backing.resetCounts()
    const b = await bootTab({ backing: a.backing })
    const s = b.store.getState()
    expect(s.report?.kind).toBe('recovered')
    expect(s.expenses.length).toBe(a.store.getState().expenses.length)
    expect(s.expenses.some((e) => e.itemName === 'After migration')).toBe(true)
    // the damaged copy is kept, never deleted
    const copies = [...b.backing.data.keys()].filter((k) => k.startsWith('st5:q:st5:db:'))
    expect(copies).toHaveLength(1)
    expect(b.backing.data.get(must(copies[0]))).toBe(truncated(raw, 200))
    expect(b.backing.removes).toEqual([])
    // and a deleted row stays deleted
    for (const id of f.tombstones) expect(s.expenses.some((e) => e.id === id)).toBe(false)
  })

  it('takes the same ladder when the digest does not match a readable body', async () => {
    const a = await bootTab()
    a.store.getState().addExpense({ itemName: 'Real', amount: 3 })
    await settle()
    const raw = must(a.backing.data.get('st5:db'))
    a.backing.data.set('st5:db', `5|0000000000000000|${raw.slice(raw.indexOf('|', 2) + 1)}`)
    const b = await bootTab({ backing: a.backing })
    // the digest is checked right after the first render (off the boot path, §8.12)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    expect(b.store.getState().report?.kind).toBe('recovered')
    const copies = [...a.backing.data.keys()].filter((k) => k.startsWith('st5:q:st5:db:'))
    expect(copies).toHaveLength(1)
    expect(b.store.getState().expenses.map((e) => e.itemName)).toEqual(['Real'])
  })

  it('runs in memory with nothing written when the damaged envelope cannot even be copied', async () => {
    const a = await bootTab()
    a.store.getState().addExpense({ itemName: 'Kept', amount: 3 })
    await settle()
    const raw = must(a.backing.data.get('st5:db'))
    a.backing.data.set('st5:db', truncated(raw, 30))
    a.backing.prefixFailures.set('st5:q', 'quota')
    a.backing.resetCounts()
    const b = await bootTab({ backing: a.backing })
    expect(b.store.getState().local).toBe('memory-only')
    expect(b.backing.data.get('st5:db')).toBe(truncated(raw, 30))
    b.store.getState().addExpense({ itemName: 'In memory', amount: 1 })
    await settle()
    expect(b.backing.setsOf('st5:db')).toBe(0)
    expect(b.backing.removes).toEqual([])
  })

  it('runs in memory when storage is inaccessible (SecurityError)', async () => {
    const backing = new FakeBacking()
    backing.blocked = true
    const { store } = await bootTab({ backing })
    expect(store.getState().local).toBe('memory-only')
    expect(store.getState().hydrated).toBe(true)
    const v = store.getState().addExpense({ itemName: 'Works anyway', amount: 2 })
    expect(store.getState().expenses).toEqual([v])
  })
})
