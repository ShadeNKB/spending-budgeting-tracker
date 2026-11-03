import { test, expect, type Browser } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  itemNames,
  openDevice,
  plainTopic,
  quickAdd,
  relayNames,
  type Device,
} from './support/devices'

// How a change reaches the other 0.11.0 device when realtime is only partly there (§11.2,
// P3-12, P3-13): with row events refused (a table out of the publication, as after 005) the
// Broadcast `rev` ping alone brings it within seconds; with realtime refused altogether the 60 s
// visible poll brings it within 75 s, and an idle minute then costs one HEAD and no pull. The
// topic is always the hashed `st:` name, never the raw code. Invented data.

let relay: Relay | undefined
let hosts: StaticHost[] = []
let devices: Device[] = []

test.afterEach(async () => {
  await closeAll(devices)
  devices = []
  for (const h of hosts) await h.close()
  hosts = []
  await relay?.close()
  relay = undefined
})

async function pair(
  browser: Browser,
  before: (r: Relay) => void,
): Promise<{ readonly r: Relay; readonly a: Device; readonly b: Device }> {
  const r = await startRelay(PORTS.relay)
  relay = r
  before(r)
  hosts = [
    await serveBuild(PORTS.candidateA, build('candidate')),
    await serveBuild(PORTS.candidateB, build('candidate')),
  ]
  const [ha, hb] = hosts
  if (ha === undefined || hb === undefined) throw new Error('two hosts expected')
  const a = await openDevice(browser, ha.origin)
  devices.push(a)
  await expect.poll(() => r.row(SYNC_CODE) !== null, { timeout: 30_000 }).toBe(true)
  const b = await openDevice(browser, hb.origin)
  devices.push(b)
  return { r, a, b }
}

/** When `a`'s write carrying `item` landed on the relay. */
async function landedAt(r: Relay, a: Device, item: string): Promise<number> {
  await expect.poll(() => relayNames(r), { timeout: 30_000 }).toContain(item)
  const at = r.writes(a.origin).at(-1)?.at
  if (at === undefined) throw new Error('no landed write from the first device')
  return at
}

/** How long after `since` the device first holds `item` (polled every 250 ms, up to `ms`). */
async function arrival(d: Device, item: string, since: number, ms: number): Promise<number> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await itemNames(d.page)).includes(item)) return Date.now() - since
    await d.page.waitForTimeout(250)
  }
  return Number.POSITIVE_INFINITY
}

test('row events refused: Broadcast alone brings an add within 5 s; the topic is hashed', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { r, a, b } = await pair(browser, (x) => {
    x.disablePostgresChanges()
  })
  const topic = plainTopic(SYNC_CODE)
  // each device gives up on row events and listens on the topic with Broadcast only
  await expect.poll(() => r.topicChannels(topic), { timeout: 60_000 }).toBe(2)
  expect(r.channels(SYNC_CODE)).toBe(0)
  expect(r.topics().filter((t) => t.includes(SYNC_CODE))).toEqual([])
  await a.page.waitForTimeout(3000) // let both settle
  await quickAdd(a.page, 'by broadcast 2.10')
  const landed = await landedAt(r, a, 'by broadcast')
  expect(await arrival(b, 'by broadcast', landed, 15_000)).toBeLessThanOrEqual(5000)
  const sent = r.requests('broadcast', a.origin).filter((q) => q.at >= landed - 1000)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.every((q) => q.topic === topic)).toBe(true)
})

test('realtime refused: polling brings an add within 75 s; an idle minute is one HEAD, no pull', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const { r, a, b } = await pair(browser, (x) => {
    x.blockRealtime()
  })
  expect(r.topics()).toEqual([])
  await a.page.waitForTimeout(3000)
  await quickAdd(a.page, 'by polling 3.20')
  const landed = await landedAt(r, a, 'by polling')
  expect(await arrival(b, 'by polling', landed, 90_000)).toBeLessThanOrEqual(75_000)
  // nothing pending anywhere: an idle minute on the second device is HEADs only
  await b.page.waitForTimeout(5000)
  const from = Date.now()
  await b.page.waitForTimeout(65_000)
  const idle = r.log.filter((q) => q.origin === b.origin && q.at >= from)
  expect(idle.map((q) => q.kind).filter((k) => k !== 'head')).toEqual([])
  expect(idle.length).toBeGreaterThanOrEqual(1)
  expect(idle.length).toBeLessThanOrEqual(2)
})
