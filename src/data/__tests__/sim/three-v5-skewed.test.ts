// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, SKEWS, standardRun } from './world'

describe('sim: 3 × v5 with clock skews 0, +2 h, −1 day', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun(
            [{ kind: 'v5' }, { kind: 'v5', skew: SKEWS.fast }, { kind: 'v5', skew: SKEWS.slow }],
            seed,
            { ...CALM, cas },
          )
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
          expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(3)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
