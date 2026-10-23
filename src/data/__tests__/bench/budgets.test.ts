// @vitest-environment node
// §9.12 budgets for the core part of each path, on 5,000 owner-shaped rows. Median of 9 runs after a
// warm-up; CI guard ≤ 2.5 × budget, BENCH_STRICT=1 asserts ≤ 1.2 × (phones are 3–5× slower, so
// these are desktop numbers by design). PR-2 re-measures the full paths with a fake localStorage.
import { describe, expect, it } from 'vitest'
import { budgetView, displayList } from '../../core/categories'
import { dayOf } from '../../core/dates'
import { mergeDoc } from '../../core/doc'
import { addExpense } from '../../core/ops'
import { NEW_MEMO, decidePush } from '../../core/push'
import type { Doc, OpCtx } from '../../core/types'
import { decodeWire, encodeWire, wireString } from '../../core/wire'
import { T0 } from '../support/gen'
import { parseJson } from '../support/must'
import { ownerDoc } from '../support/ownerShape'
import { BENCH_STRICT, makeRng } from '../support/rng'

const ROWS = 5000
const RUNS = 9
const FACTOR = BENCH_STRICT ? 1.2 : 2.5

function median(f: () => void): number {
  for (let i = 0; i < 3; i++) f()
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    f()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(RUNS / 2)] ?? Infinity
}

const results: string[] = []
function check(name: string, ms: number, budget: number): void {
  results.push(`${name}: ${ms.toFixed(2)} ms (budget ${budget} ms, ${(ms / budget).toFixed(2)}×)`)
  expect(ms, name).toBeLessThanOrEqual(budget * FACTOR)
}

describe(`performance budgets (${ROWS} owner-shaped rows, ${BENCH_STRICT ? 'strict 1.2×' : 'CI 2.5×'})`, () => {
  const base = ownerDoc(ROWS, 42)
  const ctx = (i: number): OpCtx => ({
    wall: T0 + 1000 + i,
    clock: { last: 0 },
    dev: 'bench',
    rng: makeRng(i).next,
  })

  it('add + wireString of the result (warm record cache): 8 ms', () => {
    wireString(base)
    let i = 0
    const ms = median(() => {
      const r = addExpense(base, ctx(i++), {
        itemName: 'Chicken rice',
        amount: 4.5,
        category: 'Food & Dining',
      })
      wireString(r.doc)
    })
    check('add + wire', ms, 8)
  }, 120_000)

  it('no-op pull: decode with reuse + mergeDoc + decidePush (parse excluded): 30 ms', () => {
    const parsed = parseJson(wireString(base, { rev: 'r' }))
    const ms = median(() => {
      const dec = decodeWire(parsed, 'remote', { reuse: base })
      const m = mergeDoc(base, dec.doc)
      decidePush(m.doc, dec, { etag: 'e' }, 'remote', NEW_MEMO, T0)
      if (m.doc !== base) throw new Error('a no-op pull must return the same doc')
    })
    check('no-op pull', ms, 30)
  }, 120_000)

  it('boot core: parse + decode + displayList + budgetView + dayOf (cold caches): 80 ms', () => {
    const text = wireString(base)
    let k = 0
    const ms = median(() => {
      // a fresh string defeats every identity cache, as at app start
      const doc: Doc = decodeWire(
        parseJson(`${text.slice(0, -1)}${' '.repeat(k++ % 3)}}`),
        'local-envelope',
      ).doc
      displayList(doc)
      budgetView(doc)
      for (const rec of doc.expenses.values()) dayOf(rec)
    })
    check('boot core', ms, 80)
  }, 120_000)

  it('encodeWire after one changed record (warm): 25 ms; cold encode reported', () => {
    encodeWire(base)
    let i = 0
    const ms = median(() => {
      const r = addExpense(base, ctx(1000 + i++), { itemName: 'Kopi', amount: 1.4 })
      encodeWire(r.doc)
    })
    check('encode after one change', ms, 25)
    const cold = median(() => {
      encodeWire(ownerDoc(ROWS, 7 + i++))
    })
    results.push(`cold encode incl. building the doc: ${cold.toFixed(2)} ms (reported only)`)
    console.info(`[bench] ${results.join('\n[bench] ')}`)
  }, 120_000)
})
