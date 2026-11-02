// @vitest-environment node
// §9.12 budgets for the core part of each path, on 5,000 owner-shaped rows. Median of 9 runs after a
// warm-up; CI guard ≤ 2.5 × budget, BENCH_STRICT=1 asserts ≤ 1.2 × (phones are 3–5× slower, so
// these are desktop numbers by design). PR-2 re-measures the full paths with a fake localStorage.
import { describe, expect, it } from 'vitest'
import { budgetView, displayList } from '../../core/categories'
import { dayOf } from '../../core/dates'
import { digestDoc, mergeDoc } from '../../core/doc'
import { addExpense } from '../../core/ops'
import { NEW_MEMO, decidePush } from '../../core/push'
import type { Doc, OpCtx } from '../../core/types'
import { decodeWire, encodeWire, wireString } from '../../core/wire'
import { registryEntry, sameEntry } from '../../sync/registry'
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

  it('no-op pull beside 0.9.2 (it wrote the relay): + its writer-aware news check (P2-4): 30 ms', () => {
    // 0.9.2 re-pushes our records as it holds them, drops x5 and stamps its own writer
    const wire = parseJson(wireString(base, { rev: 'r' }))
    const relay092 =
      typeof wire === 'object' && wire !== null
        ? {
            ...Object.fromEntries(Object.entries(wire).filter(([k]) => k !== 'x5')),
            wr: { app: '0.8.5', dev: 'phone1', rev: 'p', at: '2026-10-18T04:00:00.000Z' },
          }
        : null
    // what this device holds after its first exchange with it (the old device is now known)
    const held = mergeDoc(base, decodeWire(relay092, 'remote', { reuse: base }).doc).doc
    const ms = median(() => {
      const dec = decodeWire(relay092, 'remote', { reuse: held })
      if (dec.writer !== 'v085') throw new Error('expected a v0.8.5 relay')
      const m = mergeDoc(held, dec.doc)
      const d = decidePush(m.doc, dec, { etag: 'e' }, 'remote', NEW_MEMO, T0)
      if (d.kind !== 'none') throw new Error(`0.9.2 holds everything: expected quiet, got ${d.why}`)
      if (m.doc !== held) throw new Error('a no-op pull must return the same doc')
    })
    check('no-op pull beside 0.9.2', ms, 30)
  }, 120_000)

  it('PR-3 no-op cycle: decode + merge + registry check + register + digest + decide: 30 ms', () => {
    // The relay copy holds this device's current entry; the cycle registers `seen` only at a
    // push, so a no-op merge leaves the doc as it is. The digest after a registry write reuses
    // every record hash (the expenses Map is the same object, P3-7).
    const me = registryEntry(undefined, '0.11.0', 'table', T0)
    const held: Doc = { ...base, devices: new Map([['bench1', me]]) }
    const parsed = parseJson(wireString(held, { rev: 'r', dev: 'bench1' }))
    digestDoc(held)
    let n = 0
    const ms = median(() => {
      const dec = decodeWire(parsed, 'remote', { reuse: held })
      const m = mergeDoc(held, dec.doc)
      const entry = registryEntry(m.doc.devices.get('bench1'), '0.11.0', 'table', T0 + n++)
      if (!sameEntry(m.doc.devices.get('bench1'), entry)) throw new Error('the entry is current')
      const registered: Doc = { ...m.doc, devices: new Map([['bench1', entry]]) }
      digestDoc(registered)
      decidePush(m.doc, dec, { etag: 'e' }, 'poll', NEW_MEMO, T0)
      if (m.doc !== held) throw new Error('a no-op pull must return the same doc')
    })
    check('PR-3 no-op cycle', ms, 30)
  }, 120_000)

  it('PR-3 join preview of a 5,000-row relay copy: decode + merge + counts (parse excluded): 80 ms', () => {
    // A device with a few entries of its own joins 5,000. Every run decodes a freshly parsed
    // copy, so nothing is cached for the relay rows. The worst case (5,000 here as well, half
    // the ids shared) is reported. The budget is boot core's: both decode 5,000 fresh rows,
    // which alone costs about what the track spec's first 50 ms line allowed for the whole path.
    const text = wireString(ownerDoc(ROWS, 99), { rev: 'r', dev: 'laptop' })
    const copies = Array.from({ length: 2 * (RUNS + 3) }, () => parseJson(text))
    const preview = (local: Doc, raw: unknown): void => {
      const dec = decodeWire(raw, 'remote', { reuse: local })
      const m = mergeDoc(local, dec.doc)
      const counts = [
        local.expenses.size,
        dec.doc.expenses.size,
        m.doc.expenses.size,
        m.removed.length,
      ]
      if (counts.some((c) => !Number.isFinite(c))) throw new Error('bad counts')
    }
    const small = ownerDoc(50, 5)
    let k = 0
    const ms = median(() => {
      preview(small, copies[k++])
    })
    check('PR-3 join preview', ms, 80)
    const worst = median(() => {
      preview(base, copies[k++])
    })
    results.push(`PR-3 join preview, 5,000 here too: ${worst.toFixed(2)} ms (reported only)`)
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
