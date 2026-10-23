// @vitest-environment node
// T-012-5 (§6.5.5): renames on every replica, arbitrary gossip orders: everyone converges.
import { describe, expect, it } from 'vitest'
import { displayList, resolver } from '../../core/categories'
import { digestDoc, mergeDoc } from '../../core/doc'
import {
  OpError,
  addCategory,
  addExpense,
  removeCategory,
  renameCategory,
  setBudget,
  updateExpense,
} from '../../core/ops'
import { recordString } from '../../core/record'
import type { Doc } from '../../core/types'
import { decodeWire, wireString } from '../../core/wire'
import { PureDevice } from '../sim/world'
import { CATS, T0, genDoc } from '../support/gen'
import { parseJson } from '../support/must'
import { PROP_SCALE, PROP_TIMEOUT, makeRng } from '../support/rng'

const ORDERS = 600 * PROP_SCALE
const merge = (a: Doc, b: Doc): Doc => mergeDoc(a, b).doc

function converged(docs: readonly Doc[]): boolean {
  const first = docs[0]
  if (first === undefined) return true
  const d = digestDoc(first)
  return docs.every(
    (x) =>
      digestDoc(x) === d &&
      [...first.expenses].every(
        ([id, rec]) =>
          recordString(rec) === recordString(x.expenses.get(id) ?? rec) && x.expenses.has(id),
      ),
  )
}

describe('rename convergence', () => {
  it(
    `${ORDERS} gossip orders × 4 random replicas with renames converge`,
    () => {
      const r = makeRng(12)
      for (let i = 0; i < ORDERS; i++) {
        const replicas = [genDoc(r), genDoc(r), genDoc(r), genDoc(r)]
        for (let k = 0; k < 8; k++) {
          const x = r.int(4)
          const y = r.int(4)
          replicas[x] = merge(
            replicas[x] ?? replicas[0] ?? genDoc(r),
            replicas[y] ?? replicas[0] ?? genDoc(r),
          )
        }
        for (let round = 0; round < 6; round++) {
          for (let x = 0; x < 4; x++) {
            for (let y = 0; y < 4; y++) {
              const a = replicas[x]
              const b = replicas[y]
              if (a !== undefined && b !== undefined) replicas[x] = merge(a, b)
            }
          }
        }
        expect(converged(replicas)).toBe(true)
        // every category resolves without a cycle and is a fixed point
        const res = resolver((replicas[0] ?? genDoc(r)).renames)
        for (const c of CATS) expect(res(res(c))).toBe(res(c))
      }
    },
    PROP_TIMEOUT,
  )

  it(
    `${ORDERS / 6} runs of 4 devices doing concurrent renames, removes, re-adds, budgets and edits converge`,
    () => {
      for (let run = 0; run < ORDERS / 6; run++) {
        const r = makeRng(1000 + run)
        const time = { now: T0 }
        const devs = ['a', 'b', 'c', 'd'].map(
          (n) => new PureDevice(n, time, r.pick([0, 0, 7_200_000, -86_400_000])),
        )
        for (let step = 0; step < 40; step++) {
          time.now += 1000 + r.int(60_000)
          const d = r.pick(devs)
          const shown = displayList(d.doc)
          const ids = [...d.doc.expenses.keys()]
          try {
            const roll = r.next()
            if (roll < 0.3 || ids.length === 0)
              d.op((doc, ctx) =>
                addExpense(doc, ctx, {
                  itemName: r.pick(['kopi', 'grab', 'gym']),
                  amount: 1 + r.int(9),
                  category: r.pick(CATS),
                  day: '2026-10-18',
                }),
              )
            else if (roll < 0.5)
              d.op((doc, ctx) =>
                renameCategory(doc, ctx, r.pick(shown), r.pick([...CATS, 'Dining', 'Gym'])),
              )
            else if (roll < 0.6) d.op((doc, ctx) => removeCategory(doc, ctx, r.pick(shown)))
            else if (roll < 0.7)
              d.op((doc, ctx) => addCategory(doc, ctx, r.pick([...CATS, 'Dining', 'Gym'])))
            else if (roll < 0.8)
              d.op((doc, ctx) => setBudget(doc, ctx, r.pick(shown), r.pick([100, 200])))
            else d.op((doc, ctx) => updateExpense(doc, ctx, r.pick(ids), { amount: 1 + r.int(50) }))
          } catch (e) {
            if (!(e instanceof OpError)) throw e
          }
          if (r.chance(0.4)) {
            const x = r.pick(devs)
            const y = r.pick(devs)
            x.doc = merge(x.doc, decodeWire(parseJson(wireString(y.doc)), 'remote').doc)
          }
        }
        for (let round = 0; round < 6; round++) {
          for (const x of devs)
            for (const y of devs)
              x.doc = merge(x.doc, decodeWire(parseJson(wireString(y.doc)), 'remote').doc)
        }
        expect(converged(devs.map((d) => d.doc)), `run ${run}`).toBe(true)
      }
    },
    PROP_TIMEOUT,
  )
})
