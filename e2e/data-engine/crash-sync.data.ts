import { test, expect } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  openDevice,
  quickAdd,
  relayNames,
  syncState,
  waitForApp,
  type Device,
} from './support/devices'

// T-018-3 / F-017 with sync on (§12.3 row 16): offline, an entry is added and the renderer is
// killed from outside before anything could send it, as when the OS reclaims a suspended app.
// The write-through had already put the entry and its outbox key in the envelope; the relaunch,
// back online, finds the non-empty outbox, pushes it, and the pill says Synced. The renderer
// processes are killed the way crash.spec.ts does it (CDP SystemInfo.getProcessInfo, then
// SIGKILL): CDP Page.crash raised no crash event on Linux CI. Chromium only. Invented data.

let relay: Relay
let host: StaticHost
let device: Device | undefined

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  host = await serveBuild(PORTS.candidateA, build('candidate'))
})

test.afterAll(async () => {
  await closeAll([device])
  await host.close()
  await relay.close()
})

test('an entry added offline right before the renderer dies is pushed at the relaunch', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'SystemInfo.getProcessInfo is a Chromium DevTools command')
  test.setTimeout(120_000)
  const d = await openDevice(browser, host.origin, { path: '/ledger?range=all' })
  device = d
  await expect.poll(() => relay.row(SYNC_CODE) !== null, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await syncState(d.page)).outbox).toBe(0)

  await d.context.setOffline(true)
  await quickAdd(d.page, 'offline then killed 5.50')
  await expect.poll(async () => (await syncState(d.page)).outbox).toBeGreaterThan(0)
  const pushesBefore = relay.pushes(host.origin).length

  // Only this test's context is open in this worker's browser, so its renderers are this page's
  // (and at most a spare one).
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  const renderers = processInfo.filter((p) => p.type === 'renderer').map((p) => p.id)
  expect(renderers.length).toBeGreaterThan(0)
  const crashed = d.page.waitForEvent('crash', { timeout: 15_000 })
  for (const pid of renderers) process.kill(pid, 'SIGKILL')
  await crashed
  await cdp.detach()
  expect(relay.pushes(host.origin)).toHaveLength(pushesBefore) // nothing went out before the kill

  // the app is opened again, back online (a crashed page cannot be set online: it goes first)
  await d.page.close()
  await d.context.setOffline(false)
  const relaunched = await d.context.newPage()
  await relaunched.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(relaunched)
  await expect.poll(() => relayNames(relay), { timeout: 30_000 }).toContain('offline then killed')
  await expect.poll(async () => (await syncState(relaunched)).outbox).toBe(0)
  await expect(relaunched.getByText(/^Synced/).first()).toBeVisible({ timeout: 15_000 })
})
