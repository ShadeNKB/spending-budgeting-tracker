// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, V011, V092, runProblems, standardRun } from './world'

describe('sim: 0.11.0 + frozen 0.9.2 (v0.8.5 writer), then the old client upgrades in place', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V092], seed, { ...CALM, cas })
          expect(runProblems(r, { idle: 1 }), `seed ${seed}`).toEqual([])
        }
      },
      SIM_TIMEOUT,
    )
  }
})
