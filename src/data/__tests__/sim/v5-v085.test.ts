// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, standardRun } from './world'

describe('sim: v5 + frozen v0.8.5, then the old client upgrades in place', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([{ kind: 'v5' }, { kind: 'v085' }], seed, { ...CALM, cas })
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
          expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(1)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
