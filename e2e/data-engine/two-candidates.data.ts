import { test, expect } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  openDevice,
  openSettingsTab,
  storedRows,
  type Device,
} from './support/devices'

// F-004 / P2-20: two devices on this build and one code. A deletes everything everywhere (typed
// DELETE); B is told "Your other device removed 60 entries" with Undo, and its Undo brings
// every entry back on both devices. Invented data.

let relay: Relay
let hostA: StaticHost
let hostB: StaticHost
let devices: Device[] = []

const SIXTY = Array.from({ length: 60 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 1 - i)).toISOString().slice(0, 10)
  return {
    id: `pair-${String(i).padStart(3, '0')}`,
    itemName: `pair entry ${String(i).padStart(3, '0')}`,
    amount: 2 + (i % 9),
    category: 'Food & Dining',
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
  }
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

test('delete everywhere on A, then Undo on B: every entry is back on both', async ({ browser }) => {
  const a = await openDevice(browser, hostA.origin, { seed: { expenses: JSON.stringify(SIXTY) } })
  const b = await openDevice(browser, hostB.origin)
  devices = [a, b]
  const count = async (d: Device) => (await storedRows(d.page)).length
  await expect.poll(() => count(b), { timeout: 30_000 }).toBe(60)

  const sheet = await openSettingsTab(a.page, 'Backup')
  await sheet.getByRole('button', { name: 'Delete all 60 entries everywhere', exact: true }).click()
  const ask = sheet.getByRole('group', {
    name: 'Delete all 60 entries on this device and on your other devices?',
  })
  await ask.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
  await ask.getByRole('button', { name: 'Delete everywhere', exact: true }).click()
  const toastsA = a.page.getByRole('region', { name: 'Notifications' })
  await expect(toastsA.getByText('All entries deleted')).toBeVisible()
  await expect.poll(() => count(a)).toBe(0)

  // B is told, and can take it back.
  const toastsB = b.page.getByRole('region', { name: 'Notifications' })
  await expect(toastsB.getByText(/^Your other device removed 60 entries/)).toBeVisible({
    timeout: 30_000,
  })
  await expect.poll(() => count(b)).toBe(0)
  await b.page.getByRole('button', { name: 'Undo', exact: true }).last().click()
  await expect(toastsB.getByText('Restored 60 entries')).toBeVisible()

  await expect.poll(() => count(b)).toBe(60)
  await expect.poll(() => count(a), { timeout: 30_000 }).toBe(60)
  const names = async (d: Device) => (await storedRows(d.page)).map((r) => r.itemName).sort()
  expect(await names(a)).toEqual(SIXTY.map((e) => e.itemName).sort())
  expect(await names(b)).toEqual(await names(a))
})
