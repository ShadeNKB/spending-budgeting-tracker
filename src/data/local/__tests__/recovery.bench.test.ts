// The Recovery centre on the owner's scale (PR-4 track spec §6): previewing a 5,000-row snapshot
// (read the body, decode it as the recovery ladder does, plan the restore) within the join
// preview's budget of 80 ms on a desktop, and applying it as one map copy within 120 ms.
// BENCH_STRICT=1 asserts the median ≤ 1.2 × budget; the CI guard asserts the fastest run ≤ 2.5 ×
// (contention only ever adds time), as bench.test.ts does.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { ownerDoc } from '../../__tests__/support/ownerShape'
import { BENCH_STRICT } from '../../__tests__/support/rng'
import { buildEnvelope, freshMeta } from '../envelope'
import type { RecoveryApi } from '../types'
import { FakeBacking } from './fakeStorage'
import { bootTab, type Tab } from './harness'

const ROWS = 5000
const RUNS = 15
const FACTOR = BENCH_STRICT ? 1.2 : 2.5

interface Timing {
  readonly median: number
  readonly fastest: number
}

async function measure(f: () => void | Promise<void>): Promise<Timing> {
  for (let i = 0; i < 2; i++) await f()
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

describe(`Recovery centre budgets (${String(ROWS)} rows, ${BENCH_STRICT ? 'strict 1.2×' : 'CI 2.5×'})`, () => {
  let tab: Tab
  let recovery: RecoveryApi
  let snapId = ''

  beforeAll(async () => {
    const backing = new FakeBacking()
    backing.data.set(
      'st5:db',
      buildEnvelope(ownerDoc(ROWS, 7), {
        ...freshMeta(),
        persistAskedAt: 1,
        dailySnapDay: '2999-01-01',
      }),
    )
    tab = await bootTab({ backing })
    expect(tab.store.getState().expenses.length).toBeGreaterThan(4000)
    tab.store.getState().deleteAllEverywhere()
    recovery = await tab.store.getState().recovery()
    snapId = must(recovery.snapshots()[0], 'snapshot').id
  }, 120_000)

  afterAll(() => {
    console.info(`[bench] ${results.join('\n[bench] ')}`)
    vi.unstubAllGlobals()
  })

  it('previewSnapshot of a 5,000-row "Before Delete all": 80 ms', async () => {
    const ms = await measure(async () => {
      const preview = await recovery.previewSnapshot(snapId)
      if (preview.counts.restored < 4000) throw new Error('the preview must restore every row')
    })
    check('previewSnapshot', ms, 80)
  }, 120_000)

  it('applying it (one map copy, a safety copy, an Undo): 120 ms', async () => {
    // each run restores the whole copy again: the run before is undone first (not timed)
    const times: number[] = []
    for (let i = 0; i < 6; i++) {
      const preview = await recovery.previewSnapshot(snapId)
      const t = performance.now()
      tab.store.getState().applyImport(preview, 'restore')
      times.push(performance.now() - t)
      expect(tab.store.getState().expenses.length).toBeGreaterThan(4000)
      const undo = must(tab.store.getState().undoStack.at(-1), 'undo')
      tab.store.getState().consumeUndo(undo.id)
      expect(tab.store.getState().expenses).toHaveLength(0)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)] ?? Number.POSITIVE_INFINITY
    check('apply snapshot restore', { median, fastest: times[0] ?? median }, 120)
  }, 120_000)
})
