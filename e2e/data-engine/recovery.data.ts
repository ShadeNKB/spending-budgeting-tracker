import { test, expect } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  deleteEntry,
  itemNames,
  openDevice,
  openSettingsTab,
  storedRows,
  type Device,
} from './support/devices'

// F-004, PR-4 acceptance 3 and 4: two devices on this build and one code. A deletes everything
// everywhere (typed DELETE) and its Undo is not used; later A brings it all back from Settings ›
// Backup › Recovery › Snapshots › "Before Delete all". B gets every entry back through sync, with
// the same names, amounts, categories and days. Then B deletes one of the restored entries, and
// it stays deleted on both. Invented data.

let relay: Relay
let hostA: StaticHost
let hostB: StaticHost
let devices: Device[] = []

const THIRTY = Array.from({ length: 30 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 1 - i)).toISOString().slice(0, 10)
  return {
    id: `rec-${String(i).padStart(3, '0')}`,
    itemName: `recovery entry ${String(i).padStart(3, '0')}`,
    amount: 3 + (i % 7),
    category: i % 2 === 0 ? 'Food & Dining' : 'Transportation',
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
  }
})

/** What the owner sees of an entry: name, amount, category, day. */
const shown = (r: { itemName: string; amount: number; category: string; date: string }) =>
  `${r.itemName}|${String(r.amount)}|${r.category}|${r.date.slice(0, 10)}`

const seen = async (d: Device) => (await storedRows(d.page)).map(shown).sort()

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

test('Delete all on A, then its "Before Delete all" snapshot: back on both; a later delete on B sticks', async ({
  browser,
}) => {
  const a = await openDevice(browser, hostA.origin, { seed: { expenses: JSON.stringify(THIRTY) } })
  const b = await openDevice(browser, hostB.origin)
  devices = [a, b]
  const count = async (d: Device) => (await storedRows(d.page)).length
  await expect.poll(() => count(b), { timeout: 30_000 }).toBe(30)
  const before = await seen(a)
  expect(before).toHaveLength(30)

  // A deletes everything everywhere; both devices end up empty.
  const sheet = await openSettingsTab(a.page, 'Backup')
  await sheet.getByRole('button', { name: 'Delete all 30 entries everywhere', exact: true }).click()
  const ask = sheet.getByRole('group', {
    name: 'Delete all 30 entries on this device and on your other devices?',
  })
  await ask.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
  await ask.getByRole('button', { name: 'Delete everywhere', exact: true }).click()
  await expect.poll(() => count(a)).toBe(0)
  await expect.poll(() => count(b), { timeout: 30_000 }).toBe(0)
  // Neither Undo is used: the toasts go.
  for (const d of [a, b]) {
    const toasts = d.page.getByRole('region', { name: 'Notifications' })
    for (const dismiss of await toasts.getByRole('button', { name: 'Dismiss' }).all()) {
      await dismiss.click()
    }
  }

  // A: Recovery › Snapshots › "Before Delete all" › Restore.
  await sheet.getByRole('button', { name: /^Recovery/ }).click()
  await expect(sheet.getByRole('heading', { name: 'Recovery', level: 3 })).toBeFocused()
  const snapshots = sheet.getByRole('list', { name: 'Snapshots' })
  await snapshots.getByRole('button', { name: /^Restore Before Delete all, / }).click()
  const preview = sheet.getByRole('region', { name: 'Restore from this copy?' })
  await expect(preview.getByRole('listitem')).toHaveText([
    '30 in the copy',
    '30 restored (they were deleted)',
  ])
  await preview.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(
    a.page.getByRole('region', { name: 'Notifications' }).getByText('Restored 30 entries'),
  ).toBeVisible()

  // Back on A at once, and on B after sync: the same entries (under new ids).
  await expect.poll(() => seen(a)).toEqual(before)
  await expect.poll(() => seen(b), { timeout: 30_000 }).toEqual(before)
  const ids = (await storedRows(a.page)).map((r) => r.id)
  expect(ids.some((id) => THIRTY.some((e) => e.id === id))).toBe(false)

  // B deletes one restored entry: it stays deleted on both, sync after sync.
  const gone = THIRTY[4]?.itemName ?? ''
  await deleteEntry(b.page, gone)
  await expect.poll(() => itemNames(b.page)).not.toContain(gone)
  await expect.poll(() => itemNames(a.page), { timeout: 30_000 }).not.toContain(gone)
  await a.page.reload()
  await b.page.reload()
  await expect.poll(() => count(a), { timeout: 30_000 }).toBe(29)
  await expect.poll(() => count(b), { timeout: 30_000 }).toBe(29)
  expect(await itemNames(a.page)).not.toContain(gone)
  expect(await itemNames(b.page)).toEqual(await itemNames(a.page))
})
