import { test, expect } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  openSettingsTab,
  plainTopic,
  relayDevices,
  type Device,
} from './support/devices'
import { soak } from './support/soak'

// Lead entry note (b): after gate B a device that has not reloaded still runs 0.10.0 beside this
// build. Both are v5 writers: the digest rule converges them with no ping-pong; 0.10.0 ignores
// Broadcast and the hashed topic, and carries this build's registry entry in `x5.devs` without
// pushing for it. The same 60 s script as beside 0.9.2 (support/soak.ts). Invented data.

let relay: Relay
let hostNew: StaticHost
let hostOld: StaticHost
const devices: Device[] = []

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  hostNew = await serveBuild(PORTS.candidateA, build('candidate'))
  hostOld = await serveBuild(PORTS.v092, build('v010'))
})

test.afterAll(async () => {
  await closeAll(devices)
  await hostNew.close()
  await hostOld.close()
  await relay.close()
})

test('0.11.0 beside 0.10.0 for 60 s: one live set, no resurrection, bounded and quiet', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const { n } = await soak(browser, relay, hostNew, hostOld, { n: 'v5', o: 'v5' }, devices)
  // This build listens on the hashed topic (never the raw code) and announced its pushes;
  // 0.10.0 still uses its raw-code channel, as shipped.
  expect(relay.topics()).toContain(plainTopic(SYNC_CODE))
  expect(relay.topics().filter((t) => t.includes(SYNC_CODE))).toEqual([`sync:${SYNC_CODE}`])
  expect(relay.requests('broadcast', n.origin).length).toBeGreaterThan(0)
  // The registry survives 0.10.0's pushes: this build's entry, 0.11.0, and none from 0.10.0.
  const devs = Object.values(relayDevices(relay))
  expect(
    devs.map((d) => (typeof d === 'object' && d !== null ? Reflect.get(d, 'app') : null)),
  ).toEqual(['0.11.0'])
  // 0.10.0 never registers itself, yet Settings › Sync names it, in the list and the banner alike,
  // and so never says every device runs this build (the gate B signal).
  const sheet = await openSettingsTab(n.page, 'Sync')
  const list = sheet.getByRole('list', { name: 'Devices' })
  await expect(list.getByText('Older SpendTrack (0.10.0)')).toBeVisible({ timeout: 20_000 })
  await expect(
    sheet
      .getByText('Your other device runs SpendTrack 0.10.0. Open it and reload to update.')
      .first(),
  ).toBeVisible()
  await expect(sheet.getByText(/All your devices run/)).toHaveCount(0)
})
