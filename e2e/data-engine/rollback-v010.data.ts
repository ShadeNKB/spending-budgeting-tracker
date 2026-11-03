import { test, expect, type Page } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  itemNames,
  openDevice,
  quickAdd,
  relayDevices,
  relayNames,
  syncState,
  waitForApp,
  type Device,
} from './support/devices'

// §18.3 / lead entry note (b): if 0.11.0 has to be pulled, the owner's devices go back to 0.10.0
// on the same origin with sync on, and forward again later. 0.10.0 reads the same envelope (it
// ignores, then drops, the meta fields 0.11.0 added) and the same `st5:sync` (it ignores
// `established`), keeps syncing on the same code, and 0.11.0 picks it all up again: every entry
// on the device and on the relay, the code kept, no pause. Invented data.

let relay: Relay
let host: StaticHost
let device: Device | undefined

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  host = await serveBuild(PORTS.rollback, build('candidate'))
})

test.afterAll(async () => {
  await closeAll([device])
  await host.close()
  await relay.close()
})

/** The page leaves (the mirror and envelope are flushed on hide), then the origin's build loads. */
async function reopen(page: Page): Promise<void> {
  await page.goto('about:blank')
  await page.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(page)
}

const onRelay = (item: string) =>
  expect.poll(() => relayNames(relay), { timeout: 30_000 }).toContain(item)

test('0.11.0 → 0.10.0 → 0.11.0 on one origin with sync on: data, code and sync intact', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const d = await openDevice(browser, host.origin, { path: '/ledger?range=all' })
  device = d
  const page = d.page
  await quickAdd(page, 'before rollback 2.50')
  await onRelay('before rollback')
  const linked = await syncState(page)
  expect(linked.config).toMatchObject({ kind: 'plain', code: SYNC_CODE, established: true })
  await expect.poll(() => Object.values(relayDevices(relay)).length, { timeout: 30_000 }).toBe(1)

  // Rolled back: 0.10.0 on the same origin, the same storage.
  host.serve(build('v010'))
  await reopen(page)
  expect(await itemNames(page)).toEqual(['before rollback'])
  await quickAdd(page, 'on 0.10.0 3.10')
  await onRelay('on 0.10.0')
  const old = relay.pushes(host.origin).at(-1)
  expect(old?.writer).toBe('v5')
  expect((await syncState(page)).code).toBe(SYNC_CODE)

  // Forward again: everything is here and sync carries on, on the same code.
  host.serve(build('candidate'))
  await reopen(page)
  expect(await itemNames(page)).toEqual(['before rollback', 'on 0.10.0'])
  await quickAdd(page, 'forward again 4.20')
  await onRelay('forward again')
  expect(relayNames(relay)).toEqual(['before rollback', 'forward again', 'on 0.10.0'])
  const back = await syncState(page)
  expect(back.config).toMatchObject({ kind: 'plain', code: SYNC_CODE, established: true })
  await expect.poll(async () => (await syncState(page)).outbox, { timeout: 30_000 }).toBe(0)
  // the registry still names this device as 0.11.0, and nothing paused the sync
  const apps = Object.values(relayDevices(relay)).map((x) =>
    typeof x === 'object' && x !== null ? Reflect.get(x, 'app') : null,
  )
  expect(apps).toEqual(['0.11.0'])
  await expect(page.getByText(/Sync paused/)).toHaveCount(0)
})
