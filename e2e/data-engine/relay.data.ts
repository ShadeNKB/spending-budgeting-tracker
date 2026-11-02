import { test, expect } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  itemNames,
  openDevice,
  quickAdd,
  type Device,
} from './support/devices'

// The fake relay speaks what the shipped client speaks: two 0.9.2 devices on one code exchange
// an entry through it, the second one by realtime alone (0.9.2 has no polling, so nothing else
// would bring it). Without this the mixed-version results would say nothing. Invented data.

let relay: Relay
let hostA: StaticHost
let hostB: StaticHost
let a: Device | undefined
let b: Device | undefined

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  hostA = await serveBuild(PORTS.v092, build('v092'))
  hostB = await serveBuild(PORTS.candidateB, build('v092'))
})

test.afterAll(async () => {
  await closeAll([a, b])
  await hostA.close()
  await hostB.close()
  await relay.close()
})

test('two 0.9.2 devices exchange an entry through the fake relay, by realtime', async ({
  browser,
}) => {
  const first = await openDevice(browser, hostA.origin)
  const second = await openDevice(browser, hostB.origin)
  a = first
  b = second
  // Both listen before anything is written.
  await expect.poll(() => relay.channels(SYNC_CODE)).toBe(2)

  await quickAdd(first.page, 'relay smoke kopi 2')
  await expect
    .poll(() => JSON.stringify(relay.row(SYNC_CODE)?.payload ?? null))
    .toContain('relay smoke kopi')
  await expect.poll(() => itemNames(second.page)).toEqual(['relay smoke kopi'])

  // Each push is the 0.8.5 writer's (app 0.9.2), from the device that made it.
  const pushes = relay.pushes(hostA.origin)
  expect(pushes.length).toBeGreaterThan(0)
  expect(pushes.every((p) => p.writer === 'v085')).toBe(true)
  // B pulled after A's push landed: the realtime event made it run a cycle.
  const landed = pushes[0]?.at ?? Infinity
  expect(
    relay.log.some((r) => r.kind === 'pull' && r.origin === hostB.origin && r.at >= landed),
  ).toBe(true)
})
