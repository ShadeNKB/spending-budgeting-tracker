// @vitest-environment node
// AC-P1 / T-002-1: two 0.11.0 devices, self-echo on postgres_changes plus Broadcast.
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, V011, runProblems, standardRun } from './world'

describe('sim: 2 × 0.11.0', () => {
  for (const cas of [true, false]) {
    it(
      `converges with I1–I5 and the field oracle; one add ≤ 2 pushes, then none (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V011], seed, { ...CALM, cas }, true)
          expect(runProblems(r, { idle: 2 }), `seed ${seed}`).toEqual([])
        }
      },
      SIM_TIMEOUT,
    )
  }
})
