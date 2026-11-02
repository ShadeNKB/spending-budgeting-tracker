import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import { PORTS, SYNC_CODE, build } from './support/devices'
import {
  RICH,
  auditTargets,
  axeViolations,
  fieldFillProblems,
  horizontalOverflow,
  isPhone,
  settle,
  switchTheme,
} from '../support/a11y'

// The accessibility gate (T6) for the Backup states that only a build with sync shows: the
// synced copy line and the two different deletes, "Delete all N entries everywhere" (typed
// DELETE) and "Remove SpendTrack from this device only". axe 0 violations in both themes on a
// laptop (Chromium) and an iPhone (WebKit, with 44 px targets and no sideways scroll at 320 px).
// The main suite's build has no relay, so these states live here. Invented data.

let relay: Relay
let host: StaticHost

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  host = await serveBuild(PORTS.candidateA, build('candidate'))
})

test.afterAll(async () => {
  await host.close()
  await relay.close()
})

const softly = expect.configure({ soft: true })

async function openBackupSynced(page: Page, testInfo: TestInfo) {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(
    (seed) => {
      if (localStorage.getItem('e2e:seeded') !== null) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('expenses', seed.expenses)
      localStorage.setItem('syncId', seed.code)
      localStorage.setItem('spendtrack:theme', 'system')
      localStorage.setItem('spendtrack:currency', 'SGD')
    },
    { expenses: JSON.stringify(RICH), code: SYNC_CODE },
  )
  await page.goto(`${host.origin}/pulse`)
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Backup', exact: true }).click()
  await expect(
    sheet.getByText(/^Synced through your relay: every linked device has a full copy\./),
  ).toBeVisible()
  return sheet
}

/** axe in both themes, and on the phone the target audit and 320 px. */
async function gate(page: Page, testInfo: TestInfo) {
  await settle(page)
  softly(await axeViolations(page), 'axe, dark theme').toEqual([])
  await switchTheme(page, 'light')
  softly(await axeViolations(page), 'axe, light theme').toEqual([])
  if (!isPhone(testInfo)) return
  const targets = await auditTargets(page)
  softly(targets.problems, '44 px touch targets').toEqual([])
  softly(await fieldFillProblems(page), 'fields fill their boxes').toEqual([])
  await page.setViewportSize({ width: 320, height: 720 })
  await settle(page)
  softly(await horizontalOverflow(page, 320), '320 px: no sideways scrolling').toEqual([])
}

test('Backup with sync on: the delete-everywhere question (typed DELETE)', async ({
  page,
}, testInfo) => {
  const sheet = await openBackupSynced(page, testInfo)
  await sheet
    .getByRole('button', { name: `Delete all ${String(RICH.length)} entries everywhere` })
    .click()
  const field = sheet.getByRole('textbox', { name: 'Type DELETE to confirm' })
  await expect(field).toBeFocused()
  await field.fill('DELETE')
  await expect(sheet.getByRole('button', { name: 'Delete everywhere', exact: true })).toBeEnabled()
  await gate(page, testInfo)
})

test('Backup with sync on: the remove-from-this-device question', async ({ page }, testInfo) => {
  const sheet = await openBackupSynced(page, testInfo)
  await sheet.getByRole('button', { name: 'Remove SpendTrack from this device only' }).click()
  const ask = sheet.getByRole('group', { name: 'Remove SpendTrack data from this device?' })
  await expect(ask.getByRole('checkbox', { name: 'Download a backup first' })).toBeChecked()
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await gate(page, testInfo)
})

// WebKit (the owner's iPhone) drops a download when the page reloads in the same task, so the
// backup is a tap of its own: its download is under way before the next tap wipes and reloads.
test('Backup with sync on: the backup downloads on its own tap, then the device is removed', async ({
  page,
}, testInfo) => {
  const sheet = await openBackupSynced(page, testInfo)
  await sheet.getByRole('button', { name: 'Remove SpendTrack from this device only' }).click()
  const ask = sheet.getByRole('group', { name: 'Remove SpendTrack data from this device?' })
  const downloading = page.waitForEvent('download')
  await ask.getByRole('button', { name: 'Download backup', exact: true }).click()
  const backup = await downloading
  expect(backup.suggestedFilename()).toMatch(/^spendtrack-backup-\d{4}-\d{2}-\d{2}\.json$/)
  await expect(ask).toContainText('Backup downloaded.')
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  // the second question, with its amber confirm, passes the gate in both themes too
  await gate(page, testInfo)

  let downloadsAfter = 0
  page.on('download', () => {
    downloadsAfter++
  })
  const reloaded = page.waitForEvent('load')
  await ask.getByRole('button', { name: 'Remove from this device', exact: true }).click()
  await reloaded
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  const left = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k !== 'e2e:seeded'),
  )
  expect(left.filter((k) => ['expenses', 'syncId', 'st5:db', 'st5:sync'].includes(k))).toEqual([])
  expect(downloadsAfter).toBe(0)
})
