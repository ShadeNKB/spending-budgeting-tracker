// @vitest-environment node
// LEDGER entry criterion d / P2-10 / acceptance 19: PR-0's documented mixed-version delayed sync.
// An old device (0.9.2 or v0.8.4) pushes entry X; a v5 push that pulled BEFORE X landed lands right
// AFTER it and clobbers X on the relay; the old device then goes quiet (the phone is pocketed). The
// v5 device got X in the realtime event of the old push: the bridge keeps that payload and merges
// it into its next cycle, so X reaches the relay with no further change on the old device. With
// absorption off (the PR-0 behaviour) X stays off the relay: the scenario really crosses.
//
// Fixed 100 ms per network leg, so the timeline is exact:
//   t+1450 old: add X, Sync now → pull reaches the relay at +1550 → push lands at +1750 (with X)
//   t+1500 v5:  its add of Y fires the 1.5 s debounce → pull at +1600 (before X) → push at +1800
//   t+1850 old: its push answered; it is closed before v5's event reaches it (+1900)
//   t+1850 v5:  the old push's event (foreign, carries X) → kept → next cycle merges it → push
import { describe, expect, it } from 'vitest'
import { addExpense } from '../../core/ops'
import { must, parseJson, prop } from '../support/must'
import { CALM } from './relay'
import { SIM_TIMEOUT, World } from './world'

const FIXED = { ...CALM, cas: false, latency: [100, 100] as const }

function relayIds(w: World): string[] {
  const list = prop(parseJson(must(w.relay.row)), 'expenses')
  return Array.isArray(list) ? list.map((r: unknown) => String(prop(r, 'id'))) : []
}

async function crossing(
  peer: 'v085' | 'v084',
  absorbNews: boolean,
  seed: number,
): Promise<{ readonly relay: string[]; readonly x: string; readonly w: World }> {
  const w = new World({
    seed,
    devices: [{ kind: 'v5' }, { kind: peer }],
    net: FIXED,
    mode: 'pr2',
    absorbNews,
  })
  await w.setup()
  await w.settle()
  const v5 = must(w.v5[0])
  const old = must(w.old[0]).client
  const t = w.clock.now
  v5.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'Y on the laptop', amount: 2 }))
  await w.clock.runUntil(t + 1450)
  const x = old.addExpense({ itemName: 'X on the phone', amount: 4.5 }).id
  void old.triggerSync()
  await w.clock.runUntil(t + 1860)
  const writes = w.relay.writesBy.get(must(w.old[0]).name) ?? 0
  old.close() // pocketed: no more events, cycles or pushes on the old device
  await w.clock.run(60_000)
  expect(w.relay.writesBy.get(must(w.old[0]).name) ?? 0).toBe(writes)
  return { relay: relayIds(w), x, w }
}

describe('crossing pushes beside an old device (P2-10, acceptance 19)', () => {
  for (const peer of ['v085', 'v084'] as const) {
    it(
      `${peer}: X reaches the relay on the v5 device's next cycle; without absorption it does not`,
      async () => {
        for (const seed of [1, 2, 3, 90058]) {
          const on = await crossing(peer, true, seed)
          const v5 = must(on.w.v5[0])
          expect(on.relay, `seed ${seed}`).toContain(on.x)
          expect(v5.doc.expenses.has(on.x), `seed ${seed}`).toBe(true)
          expect(v5.absorbed, `seed ${seed}`).toBeGreaterThan(0)
          expect(on.w.violations, `seed ${seed}`).toEqual([])
          on.w.stop()

          const off = await crossing(peer, false, seed)
          expect(off.relay, `control, seed ${seed}`).not.toContain(off.x)
          expect(must(off.w.v5[0]).doc.expenses.has(off.x), `control, seed ${seed}`).toBe(false)
          off.w.stop()
        }
      },
      SIM_TIMEOUT,
    )
  }
})
