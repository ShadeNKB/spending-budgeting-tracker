// @vitest-environment node
// M1 (§16.6.1) in-suite: the v0.8 snapshot-before-await shape loses data in EVERY seed, the real
// cycle (fresh read after the await, no await in the merge section) in none (T-001-2).
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { SIM_TIMEOUT, raceRun } from './world'

const SEEDS = Math.max(40, Math.min(SIM_SEEDS, 60))

describe('negative control: snapshot before the await (F-001)', () => {
  it(
    `the real cycle loses no write across ${SEEDS} seeds × 60 writes`,
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await raceRun(seed, false)
        expect(r.writes).toBe(60)
        expect(r.lost, `seed ${seed}`).toBe(0)
      }
    },
    SIM_TIMEOUT,
  )

  it(
    `the snapshot-before-await variant loses writes in every one of ${SEEDS} seeds`,
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await raceRun(seed, true)
        expect(r.lost, `seed ${seed}`).toBeGreaterThan(0)
      }
    },
    SIM_TIMEOUT,
  )
})
