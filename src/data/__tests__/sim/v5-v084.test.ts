// @vitest-environment node
// AC-P1 / T-002-3: beside a frozen v0.8.4 (re-filing, 1,000 cap, unconditional push, self-echo
// loop) a 0.11.0 device pushes at most once per 10 minutes while it chatters.
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, V011, V084, runProblems, standardRun } from './world'

describe('sim: 0.11.0 + frozen v0.8.4', () => {
  for (const cas of [true, false]) {
    it(
      `converges and stays quiet against the chatter (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V084], seed, { ...CALM, cas })
          // ≤ 1 push per 10 virtual minutes while v0.8.4 chatters (the window is 60 s)
          expect(runProblems(r, { idle: 1 }), `seed ${seed}`).toEqual([])
        }
      },
      SIM_TIMEOUT,
    )
  }
})
