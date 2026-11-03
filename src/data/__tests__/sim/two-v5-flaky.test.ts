// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { FLAKY } from './relay'
import { SIM_TIMEOUT, V011, runProblems, standardRun } from './world'

describe('sim: 2 × 0.11.0 on a flaky network (drops, lost responses, reordering, lost events, socket drops)', () => {
  for (const cas of [true, false]) {
    it(
      `converges (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V011], seed, { ...FLAKY, cas })
          // a dropped HEAD is retried, so the idle minutes may pull; they never push
          expect(
            runProblems(r, { idle: Number.POSITIVE_INFINITY, headOnly: false }),
            `seed ${seed}`,
          ).toEqual([])
        }
      },
      SIM_TIMEOUT,
    )
  }
})
