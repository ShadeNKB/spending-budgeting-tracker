import { test } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import { PORTS, build, closeAll, type Device } from './support/devices'
import { soak } from './support/soak'

// The phone may still run 0.9.2 while the laptop runs this build, on one sync code. For 60 s both
// add, edit, delete, undo and change a budget, on their own entries and on each other's; then
// 15 s of quiet: one live set, no resurrection, bounded traffic, a quiet end (support/soak.ts).
// The fake relay is real enough for both (relay.data.ts). Invented data.
//
// ST5_E2E_PAIR=baseline runs the same script with 0.9.2 on both sides: the bar 0.9.2 sets.

const pair = process.env.ST5_E2E_PAIR === 'baseline' ? 'v092' : 'candidate'

let relay: Relay
let hostNew: StaticHost
let hostOld: StaticHost
const devices: Device[] = []

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  hostNew = await serveBuild(PORTS.candidateA, build(pair))
  hostOld = await serveBuild(PORTS.v092, build('v092'))
})

test.afterAll(async () => {
  await closeAll(devices)
  await hostNew.close()
  await hostOld.close()
  await relay.close()
})

test(`${pair} beside 0.9.2 for 60 s: one live set, no resurrection, bounded and quiet`, async ({
  browser,
}) => {
  test.setTimeout(240_000)
  await soak(
    browser,
    relay,
    hostNew,
    hostOld,
    { n: pair === 'candidate' ? 'v5' : null, o: 'v085' },
    devices,
  )
})
