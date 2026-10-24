// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CALM, FLAKY } from './relay'
import { SIM_TIMEOUT, standardRun } from './world'

describe('simulation determinism', () => {
  it(
    'the same seed gives the same trace digest; another seed gives another',
    async () => {
      for (const [devices, net] of [
        [[{ kind: 'v5' }, { kind: 'v5' }], FLAKY],
        [[{ kind: 'v5' }, { kind: 'v084' }], CALM],
        [[{ kind: 'v5' }, { kind: 'v085' }], CALM],
      ] as const) {
        const a = await standardRun(devices, 7, net)
        const b = await standardRun(devices, 7, net)
        const c = await standardRun(devices, 8, net)
        expect(b.digest).toBe(a.digest)
        expect(b.violations).toEqual(a.violations)
        expect(c.digest).not.toBe(a.digest)
      }
    },
    SIM_TIMEOUT,
  )
})
