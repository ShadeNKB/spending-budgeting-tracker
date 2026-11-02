// @vitest-environment node
// The PR-2 sync bridge (track spec §9, mode 'pr2'): plain upsert, PR-0's triggers, the P2-9 echo
// filter, news absorption (P2-10) and the P2-8 writer classes, beside the re-frozen 0.9.2 client
// and v0.8.4, then after the old clients upgrade in place. Every invariant of the standard run
// (I1–I5, the field oracle, convergence) must hold, as in the PR-3 configurations.
import { describe, expect, it } from 'vitest'
import { SIM_SEEDS } from '../support/rng'
import { CALM, FLAKY } from './relay'
import { SIM_TIMEOUT, standardRun, type DeviceSpec } from './world'

const PLAIN = { ...CALM, cas: false }

describe('sim (pr2 bridge): plain upsert beside 0.9.2 and v0.8.4, then in-place upgrades', () => {
  const configs: readonly (readonly [string, readonly DeviceSpec[], number])[] = [
    ['v5 + 0.9.2', [{ kind: 'v5' }, { kind: 'v085' }], 1],
    ['v5 + v0.8.4', [{ kind: 'v5' }, { kind: 'v084' }], 1],
    ['2 × v5 + 0.9.2', [{ kind: 'v5' }, { kind: 'v5' }, { kind: 'v085' }], 2],
  ]
  for (const [name, devices, idle] of configs) {
    it(
      `${name}: converges, quiet after, ≤ ${idle} idle push per 10 min (${SIM_SEEDS} seeds)`,
      async () => {
        for (let seed = 1; seed <= SIM_SEEDS; seed++) {
          const r = await standardRun(devices, seed, PLAIN, false, 'pr2')
          expect(r.violations, `seed ${seed}`).toEqual([])
          expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
          expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(idle)
        }
      },
      SIM_TIMEOUT,
    )
  }

  it(
    `2 × v5: one add costs ≤ 2 upserts, then none (${SIM_SEEDS} seeds)`,
    async () => {
      for (let seed = 1; seed <= SIM_SEEDS; seed++) {
        const r = await standardRun([{ kind: 'v5' }, { kind: 'v5' }], seed, PLAIN, true, 'pr2')
        expect(r.violations, `seed ${seed}`).toEqual([])
        expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
        expect(r.idlePushes, `seed ${seed} idle`).toBeLessThanOrEqual(2)
        expect(r.addPushes, `seed ${seed} add`).toBeLessThanOrEqual(2)
      }
    },
    SIM_TIMEOUT,
  )

  it(
    `2 × v5 on a flaky network (drops, lost responses, lost events) converges (${SIM_SEEDS} seeds)`,
    async () => {
      for (let seed = 1; seed <= SIM_SEEDS; seed++) {
        const r = await standardRun(
          [{ kind: 'v5' }, { kind: 'v5' }],
          seed,
          { ...FLAKY, cas: false },
          false,
          'pr2',
        )
        expect(r.violations, `seed ${seed}`).toEqual([])
        expect(r.roundPushes, `seed ${seed} rounds`).toBe(0)
      }
    },
    SIM_TIMEOUT,
  )
})
