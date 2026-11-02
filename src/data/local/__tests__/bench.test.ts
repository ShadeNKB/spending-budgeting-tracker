// §9.12 / track spec §8.12: the full local paths on 5,000 owner-shaped rows, through the real store
// over a string-copying fake localStorage (phones are 3–5× slower: these are desktop numbers).
// BENCH_STRICT=1 (a quiet machine) asserts the median of the runs ≤ 1.2 × budget, as §9.12 says.
// The CI guard runs inside the parallel suite, where other test processes share the CPU: it asserts
// the fastest run ≤ 2.5 × budget, because contention only ever adds time, so the fastest run is
// the closest reading of the path's own cost (an algorithmic slip still fails it by far). Both
// numbers are printed. (CPU time is no help here: Windows counts it in 15.6 ms ticks.)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { must, parseJson } from '../../__tests__/support/must'
import { ownerDoc } from '../../__tests__/support/ownerShape'
import { BENCH_STRICT } from '../../__tests__/support/rng'
import { decodeWire, wireString } from '../../core/wire'
import { buildEnvelope, freshMeta } from '../envelope'
import { FakeBacking } from './fakeStorage'
import { bootTab, hidePage, settle, type Tab } from './harness'

const ROWS = 5000
const RUNS = 15
const FACTOR = BENCH_STRICT ? 1.2 : 2.5

interface Timing {
  readonly median: number
  readonly fastest: number
}

async function measure(f: () => void | Promise<void>): Promise<Timing> {
  for (let i = 0; i < 3; i++) await f()
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    await f()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return {
    median: times[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY,
    fastest: times[0] ?? Number.POSITIVE_INFINITY,
  }
}

const results: string[] = []
function check(name: string, t: Timing, budget: number): void {
  results.push(
    `${name}: median ${t.median.toFixed(2)} ms, fastest ${t.fastest.toFixed(2)} ms ` +
      `(budget ${String(budget)} ms, median ${(t.median / budget).toFixed(2)}×)`,
  )
  expect(BENCH_STRICT ? t.median : t.fastest, name).toBeLessThanOrEqual(budget * FACTOR)
}

describe(`local engine budgets (${String(ROWS)} rows, ${BENCH_STRICT ? 'strict 1.2×' : 'CI 2.5×'})`, () => {
  let tab: Tab
  const backing = new FakeBacking()

  beforeAll(async () => {
    const doc = ownerDoc(ROWS, 42)
    backing.data.set(
      'st5:db',
      buildEnvelope(doc, { ...freshMeta(), persistAskedAt: 1, dailySnapDay: '2999-01-01' }),
    )
    tab = await bootTab({ backing, install: true })
    expect(tab.store.getState().expenses.length).toBeGreaterThan(4000)
  }, 120_000)

  afterAll(() => {
    console.info(`[bench] ${results.join('\n[bench] ')}`)
    vi.unstubAllGlobals()
  })

  it('addExpense → commit → flush (envelope written): 8 ms', async () => {
    let i = 0
    const ms = await measure(async () => {
      tab.store.getState().addExpense({
        itemName: `Chicken rice ${String(i++)}`,
        amount: 4.5,
        category: 'Food & Dining',
      })
      await Promise.resolve()
    })
    expect(tab.backing.data.get('st5:db')).toContain(`Chicken rice ${String(i - 1)}`)
    check('add → commit → flush', ms, 8)
  }, 120_000)

  it('boot (read + parse + decode + views): 80 ms', async () => {
    await settle()
    const ms = await measure(() => tab.store.getState().hydrate())
    check('boot', ms, 80)
  }, 120_000)

  it('no-op applyRemote of our own last push (decode with reuse): 30 ms', async () => {
    const port = must(tab.mod.getSyncPort())
    const parsed = parseJson(wireString(port.doc(), { rev: 'r' }))
    const ms = await measure(() => {
      const out = port.applyRemote(decodeWire(parsed, 'remote', { reuse: port.doc() }))
      if (out.changedLocal) throw new Error('our own push must be a no-op')
    })
    check('no-op applyRemote', ms, 30)
  }, 120_000)

  it('mirror write after one change (on hide): 25 ms', async () => {
    hidePage()
    let i = 0
    const ms = await measure(async () => {
      const first = must(tab.store.getState().expenses[0])
      tab.store.getState().updateExpense(first.id, { amount: 1 + (i++ % 50) })
      await Promise.resolve()
      hidePage()
    })
    check('mirror write', ms, 25)
  }, 120_000)
})
