// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, SKEWS, V011, runProblems, standardRun } from './world'

describe('sim: 3 × 0.11.0 with clock skews 0, +2 h, −1 day', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun(
            [V011, { ...V011, skew: SKEWS.fast }, { ...V011, skew: SKEWS.slow }],
            seed,
            { ...CALM, cas },
          )
          expect(runProblems(r, { idle: 3 }), `seed ${seed}`).toEqual([])
        }
      },
      SIM_TIMEOUT,
    )
  }
})
