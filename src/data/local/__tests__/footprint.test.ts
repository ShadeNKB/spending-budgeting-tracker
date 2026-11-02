// How much of the origin's storage SpendTrack takes after the upgrade (§9.10, §9.11): at the
// owner's scale, and at 5,000 rows inside a quota the size of LS_BUDGET (the iPhone Safari model,
// where the rollback copy is the first thing to go). Through the real store over a string-copying
// fake localStorage, on owner-shaped invented rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LS_BUDGET } from '../../core/constants'
import { isSpendTrackKey } from '../keys'
import { FakeBacking, seed } from './fakeStorage'
import { bootTab, hidePage, settle } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Characters SpendTrack holds (keys and values), as a browser counts them. */
const footprint = (b: FakeBacking): number =>
  [...b.data].reduce((n, [k, v]) => (isSpendTrackKey(k) ? n + k.length + v.length : n), 0)

describe('storage taken after the upgrade', () => {
  it('the owner’s scale (700 rows): under a third of the budget at once, a fifth once compressed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(T0)
    const f = ownerV4({ noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    const before = footprint(b)
    const t = await bootTab({ backing: b, install: true })
    hidePage()
    await settle()
    // the envelope, the rollback copy and two plain snapshots (pre-v5, today's) until they are
    // compressed, 35 s on (or 3 s into the next boot)
    const first = footprint(b)
    await vi.advanceTimersByTimeAsync(40_000)
    await vi.waitFor(() => {
      expect(
        [...b.data].filter(([k, v]) => k.startsWith('st5:snap:') && v.startsWith('z0|')),
      ).toEqual([])
    })
    const steady = footprint(b)
    const pct = (n: number): string => `${((100 * n) / LS_BUDGET).toFixed(1)} %`
    console.info(
      `[footprint] 700 rows: v4 ${String(before)} chars; after the upgrade ${String(first)} ` +
        `(${(first / before).toFixed(2)}×, ${pct(first)} of LS_BUDGET); compressed ${String(steady)} ` +
        `(${(steady / before).toFixed(2)}×, ${pct(steady)})`,
    )
    expect(t.store.getState().facts.mirror).toBe('on')
    expect(first).toBeLessThan(0.33 * LS_BUDGET)
    expect(steady).toBeLessThan(0.2 * LS_BUDGET)
  })

  it('5,000 rows in an iPhone-sized quota: the rollback copy is shed, never a save', async () => {
    const f = ownerV4({ rows: 5000, tombstones: 300, noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    b.quota = LS_BUDGET
    const t = await bootTab({ backing: b, install: true })
    await settle()
    expect(t.store.getState().local).toBe('saved')
    expect(t.store.getState().expenses).toHaveLength(5000)
    // the upgrade could not keep both the rollback copy and its own envelope: the copy went,
    // and Settings says so ("Rollback copy: off")
    expect(t.store.getState().facts.mirror).toBe('off')
    for (let i = 0; i < 40; i++) {
      t.store.getState().addExpense({ itemName: `Kopi ${String(i)}`, amount: 1.8 })
      expect(t.store.getState().saveNow()).toBe('saved')
      if (i % 10 === 9) hidePage()
    }
    await settle()
    expect(t.store.getState().local).toBe('saved')
    console.info(
      `[footprint] 5,000 rows: ${String(footprint(b))} chars of ${String(LS_BUDGET)}, mirror ${t.store.getState().facts.mirror}`,
    )
    const next = await bootTab({ backing: b })
    await settle()
    expect(next.store.getState().expenses).toHaveLength(5040)
  }, 120_000)
})
