// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, standardRun } from './world'

describe('sim: 2 × v5', () => {
  for (const cas of [true, false]) {
    it(
      `converges with I1–I5 and the field oracle (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun(
            [{ kind: 'v5' }, { kind: 'v5' }],
            seed,
            { ...CALM, cas },
            true,
          )
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
          expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(2)
          expect(r.addPushes, `seed ${seed} add`).toBeLessThanOrEqual(2)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
