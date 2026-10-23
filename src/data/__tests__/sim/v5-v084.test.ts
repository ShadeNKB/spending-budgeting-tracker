// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, standardRun } from './world'

describe('sim: v5 + frozen v0.8.4 (re-filing, 1,000 cap, unconditional push, self-echo loop)', () => {
  for (const cas of [true, false]) {
    it(
      `converges and stays quiet against the chatter (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([{ kind: 'v5' }, { kind: 'v084' }], seed, { ...CALM, cas })
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
          // ≤ 1 push per 10 virtual minutes per v5 device while v0.8.4 chatters (the window is 60 s)
          expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(1)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
