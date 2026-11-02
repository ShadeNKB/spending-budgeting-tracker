// @vitest-environment node
// AC-P1, lead entry note (b): 0.11.0 beside the shipped 0.10.0 (mode 'pr2': plain upsert, no
// head, no Broadcast, no registry of its own), with and without the frozen 0.9.2, CAS on and off.
// Both are v5 writers, so the digest rule converges them with no ping-pong; 0.11.0 flags the
// 0.10.0 writer (legacySeen.v5pre); at the end every older device updates in place (0.10.0 keeps
// its envelope and device id, 0.9.2 migrates its storage) and the world goes quiet again.
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM } from './relay'
import { SIM_TIMEOUT, V010, V011, V092, runProblems, standardRun } from './world'

describe('sim: 0.11.0 beside 0.10.0', () => {
  for (const cas of [true, false]) {
    it(
      `0.11.0 + 0.10.0: converges, one add ≤ 2 pushes then none, idle HEADs only (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V010], seed, { ...CALM, cas }, true)
          expect(runProblems(r, { idle: 2 }), `seed ${seed}`).toEqual([])
          expect(r.v5preSeen, `seed ${seed}`).toBe(true)
        }
      },
      SIM_TIMEOUT,
    )

    it(
      `0.11.0 + 0.10.0 + frozen 0.9.2: converges, then all update in place (CAS ${cas ? 'on' : 'off'}, ${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun([V011, V010, V092], seed, { ...CALM, cas })
          expect(runProblems(r, { idle: 2 }), `seed ${seed}`).toEqual([])
          expect(r.v5preSeen, `seed ${seed}`).toBe(true)
        }
      },
      SIM_TIMEOUT,
    )
  }
})
