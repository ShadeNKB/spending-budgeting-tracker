// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { FLAKY } from './relay'
import { SIM_TIMEOUT, standardRun } from './world'

describe('sim: 2 × v5 on a flaky network (drops, lost responses, reordering, lost events)', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([{ kind: 'v5' }, { kind: 'v5' }], seed, { ...FLAKY, cas })
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
