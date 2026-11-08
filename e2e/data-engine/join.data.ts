import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  itemNames,
  openDevice,
  openSettingsTab,
  relayNames,
  syncState,
  type Device,
} from './support/devices'

// Generate, then Join on the other device through the real Settings › Sync (§3.7, P3-5, AC-U3):
// a code that is not one, or one with no synced copy, says so under the field and nothing is
// saved or written anywhere (a join never creates); a found code shows the merge preview with
// exact counts, and Join merges both ways. Invented data.

let relay: Relay
let hostA: StaticHost
let hostB: StaticHost
const devices: Device[] = []

/** The release this build was made from (package.json), as it names itself in Settings › Sync. */
const RELEASE = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version

const MISSING = '5e5e5e5e-0e2e-4e2e-8e2e-00000000dead'
const entry = (id: string, itemName: string, day: string) => ({
  id,
  itemName,
  amount: 4.2,
  category: 'Food & Dining',
  date: `${day}T12:00:00`,
  createdAt: `${day}T12:00:00`,
})

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  hostA = await serveBuild(PORTS.candidateA, build('candidate'))
  hostB = await serveBuild(PORTS.candidateB, build('candidate'))
})

test.afterAll(async () => {
  await closeAll(devices)
  await hostA.close()
  await hostB.close()
  await relay.close()
})

test('Generate on one device, Join on the other: checked, previewed, merged; never creates', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const a = await openDevice(browser, hostA.origin, {
    syncCode: null,
    seed: {
      expenses: JSON.stringify([
        entry('join-a1', 'laptop kopi', '2026-10-30'),
        entry('join-a2', 'laptop lunch', '2026-10-31'),
      ]),
    },
  })
  devices.push(a)
  const sheetA = await openSettingsTab(a.page, 'Sync')
  await sheetA.getByRole('button', { name: 'Generate sync code for this device' }).click()
  const toastsA = a.page.getByRole('region', { name: 'Notifications' })
  await expect(toastsA.getByText('Sync code created. Join it on your other device.')).toBeVisible()
  await expect.poll(async () => (await syncState(a.page)).code).not.toBeNull()
  const code = (await syncState(a.page)).code ?? ''
  await expect.poll(() => relayNames(relay, code)).toEqual(['laptop kopi', 'laptop lunch'])

  const b = await openDevice(browser, hostB.origin, {
    syncCode: null,
    seed: { expenses: JSON.stringify([entry('join-b1', 'phone taxi', '2026-11-01')]) },
  })
  devices.push(b)
  const sheetB = await openSettingsTab(b.page, 'Sync')
  // AC-P4: the build says which release it is
  await expect(sheetB.getByText(`This device runs SpendTrack ${RELEASE}`)).toBeVisible()
  const field = sheetB.getByRole('textbox', { name: 'Sync code' })
  const join = sheetB.getByRole('button', { name: 'Join', exact: true })
  const quietBefore = relay.log.filter((q) => q.origin === b.origin).length

  // not a code: checked before any network call
  await field.fill('not a sync code')
  await join.click()
  await expect(sheetB.getByText(/^That code isn.t valid\./)).toBeVisible()
  expect(relay.log.filter((q) => q.origin === b.origin)).toHaveLength(quietBefore)

  // a well-formed code with no synced copy: said so, nothing saved, nothing written
  await field.fill(MISSING)
  await join.click()
  await expect(
    sheetB.getByText('No synced data found for this code. Check it on your other device.'),
  ).toBeVisible()
  expect(relay.pushes().filter((q) => q.syncId === MISSING)).toEqual([])
  expect(relay.row(MISSING)).toBeNull()
  expect((await syncState(b.page)).config).toBeNull()

  // the real code: the preview counts this device, the synced copy and the merge
  await field.fill(code)
  await join.click()
  const ask = sheetB.getByRole('group', { name: 'Join this sync?' })
  await expect(ask).toContainText(
    'This device: 1 entry · Synced: 2 entries · After joining: about 3 entries. Nothing here is removed.',
  )
  expect(relay.pushes().filter((q) => q.syncId === code && q.origin === b.origin)).toEqual([])
  await ask.getByRole('button', { name: 'Join', exact: true }).click()
  const toastsB = b.page.getByRole('region', { name: 'Notifications' })
  await expect(toastsB.getByText('Joined. This device is synced.')).toBeVisible({
    timeout: 30_000,
  })
  const all = ['laptop kopi', 'laptop lunch', 'phone taxi']
  await expect.poll(() => itemNames(b.page)).toEqual(all)
  await expect.poll(() => relayNames(relay, code), { timeout: 30_000 }).toEqual(all)
  await expect.poll(() => itemNames(a.page), { timeout: 30_000 }).toEqual(all)
  // the joined device is established once its first cycle found the copy
  await expect
    .poll(async () => (await syncState(b.page)).config)
    .toMatchObject({ kind: 'plain', code, established: true })
})
