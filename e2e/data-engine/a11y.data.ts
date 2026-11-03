import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import { PORTS, SYNC_CODE, build, quickAdd, relayNames, waitForApp } from './support/devices'
import {
  RICH,
  auditTargets,
  axeViolations,
  fieldFillProblems,
  horizontalOverflow,
  isPhone,
  manyRows,
  settle,
  switchTheme,
} from '../support/a11y'

// The accessibility gate (T6) for the Backup states that only a build with sync shows: the
// synced copy line and the two different deletes, "Delete all N entries everywhere" (typed
// DELETE) and "Remove SpendTrack from this device only". axe 0 violations in both themes on a
// laptop (Chromium) and an iPhone (WebKit, with 44 px targets and no sideways scroll at 320 px).
// The main suite's build has no relay, so these states live here. Invented data.
//
// PR-3 (AC-U8) adds the Settings › Sync states and the desktop pill buttons: the linked panel
// with its devices list and masked code, the code revealed, the join preview and a code with no
// synced copy, the 0.9.2 old-device banner, the size meter from 70 %, the unlinked view with
// Reconnect, the view of a sync a newer SpendTrack set up, and the pill as a button while sync
// retries and while it is paused. The other devices in them are real: a second 0.11.0 device
// (an iPhone's user agent) and a 0.9.2 one, on the same fake relay.

let relay: Relay
let host: StaticHost
let hostOther: StaticHost
let hostOld: StaticHost

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  host = await serveBuild(PORTS.candidateA, build('candidate'))
  hostOther = await serveBuild(PORTS.candidateB, build('candidate'))
  hostOld = await serveBuild(PORTS.v092, build('v092'))
})

test.afterAll(async () => {
  await host.close()
  await hostOther.close()
  await hostOld.close()
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

// ─── PR-3: Settings › Sync and the pill (AC-U8) ──────────────────────────────────────────────

/** A code of its own per state, so no state sees another's relay copy. */
const codeFor = (n: number) =>
  `5e5e5e5e-0e2e-4e2e-8e2e-0000000a11${n.toString(16).padStart(2, '0')}`
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const NEWER_CONFIG = JSON.stringify({
  kind: 'e2e',
  code: 'ST5-e2e-newer',
  rowId: 'e2e',
  joinedAt: 1,
})

/**
 * Another device on `code`: it opens linked, adds an entry and leaves once the relay holds it
 * (its registry entry, or its 0.9.2 writer stamp, with it).
 */
async function otherDevice(
  browser: Browser,
  origin: string,
  code: string,
  userAgent?: string,
): Promise<void> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    timezoneId: 'Asia/Singapore',
    ...(userAgent === undefined ? {} : { userAgent }),
  })
  try {
    await context.addInitScript((c) => {
      if (localStorage.getItem('e2e:seeded') !== null) return
      localStorage.setItem('syncId', c)
      localStorage.setItem('e2e:seeded', '1')
    }, code)
    const page = await context.newPage()
    await page.goto(`${origin}/ledger`)
    await waitForApp(page)
    await quickAdd(page, 'from the other device 1.50')
    await expect
      .poll(() => relayNames(relay, code), { timeout: 30_000 })
      .toContain('from the other device')
  } finally {
    await context.close()
  }
}

/** The app on this build, dark theme and reduced motion, after seeding `keys`. */
async function openApp(page: Page, testInfo: TestInfo, keys: Record<string, string>) {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript((seed) => {
    if (localStorage.getItem('e2e:seeded') !== null) return
    localStorage.setItem('e2e:seeded', '1')
    localStorage.setItem('spendtrack:theme', 'system')
    localStorage.setItem('spendtrack:currency', 'SGD')
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
  }, keys)
  await page.goto(`${host.origin}/pulse`)
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
}

/** Settings › Sync, after seeding `keys` (sync code, entries, slots). */
async function openSync(page: Page, testInfo: TestInfo, keys: Record<string, string>) {
  await openApp(page, testInfo, keys)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Sync', exact: true }).click()
  return sheet
}

test('Sync, linked: the devices list and the masked code, then the code shown', async ({
  page,
  browser,
}, testInfo) => {
  const code = codeFor(1)
  await otherDevice(browser, hostOther.origin, code, IPHONE_UA)
  const sheet = await openSync(page, testInfo, { syncId: code, expenses: JSON.stringify(RICH) })
  await expect(sheet.getByText('This device', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(sheet.getByText('Other device', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(sheet.getByText(/^Sync code, hidden, ends in /)).toBeAttached()
  await expect(sheet.getByText(code)).toHaveCount(0)
  await gate(page, testInfo)
  await sheet.getByRole('button', { name: 'Show code' }).click()
  await expect(sheet.getByRole('button', { name: 'Hide code' })).toBeVisible()
  await expect(sheet.getByText(code)).toBeVisible()
  await gate(page, testInfo)
})

test('Sync, unlinked: the join preview, then a code with no synced copy', async ({
  page,
  browser,
}, testInfo) => {
  const code = codeFor(2)
  await otherDevice(browser, hostOther.origin, code)
  const sheet = await openSync(page, testInfo, { expenses: JSON.stringify(RICH) })
  const field = sheet.getByRole('textbox', { name: 'Sync code' })
  await field.fill(code)
  await sheet.getByRole('button', { name: 'Join', exact: true }).click()
  const ask = sheet.getByRole('group', { name: 'Join this sync?' })
  await expect(ask).toContainText('Synced: 1 entry')
  await gate(page, testInfo)
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click()
  await field.fill(codeFor(250))
  await sheet.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(
    sheet.getByText('No synced data found for this code. Check it on your other device.'),
  ).toBeVisible()
  await gate(page, testInfo)
})

test('Sync, linked beside 0.9.2: the old-device banner', async ({ page, browser }, testInfo) => {
  const code = codeFor(3)
  await otherDevice(browser, hostOld.origin, code)
  const sheet = await openSync(page, testInfo, { syncId: code })
  // a banner says it twice: once for the eye, once as the description a screen reader hears
  await expect(
    sheet
      .getByText('Your other device runs SpendTrack 0.9.2. Open it and reload to update.')
      .first(),
  ).toBeVisible({ timeout: 20_000 })
  // the devices list names it by the release the banner names (its stamp says 0.8.5, the
  // writer version inside 0.9.2), never by a version the owner never installed
  const devices = sheet.getByRole('list', { name: 'Devices' })
  await expect(devices.getByText('Older SpendTrack (0.9.2)')).toBeVisible()
  await expect(devices.getByText(/SpendTrack 0\.9\.2 · seen .* · update it/)).toBeVisible()
  await expect(devices).not.toContainText('0.8.5')
  await gate(page, testInfo)
})

test('Sync, linked with a long history: the size meter from 70 %', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const sheet = await openSync(page, testInfo, {
    syncId: codeFor(4),
    expenses: JSON.stringify(manyRows(2400)),
  })
  await expect(sheet.getByText(/^Sync uses \d+ % of the relay limit\./).first()).toBeVisible({
    timeout: 60_000,
  })
  await gate(page, testInfo)
})

test('Sync, unlinked with a remembered code: Reconnect', async ({ page }, testInfo) => {
  const sheet = await openSync(page, testInfo, {
    'st5:synckey:prev': JSON.stringify({ code: codeFor(5), until: Date.now() + 10 * 86_400_000 }),
  })
  await expect(
    sheet.getByRole('button', { name: /^Reconnect to the code ending in / }),
  ).toBeVisible()
  await gate(page, testInfo)
})

test('Sync set up by a newer SpendTrack: the update view, with no Generate or Join', async ({
  page,
}, testInfo) => {
  const sheet = await openSync(page, testInfo, { 'st5:sync': NEWER_CONFIG })
  await expect(
    sheet
      .getByText(
        'Sync on this device was set up by a newer SpendTrack. Reload SpendTrack to update. Your data is safe here.',
      )
      .first(),
  ).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Generate/ })).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: 'Sync code' })).toHaveCount(0)
  await gate(page, testInfo)
})

test('the pill as a button (desktop): while sync retries, and while it is paused', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(isPhone(testInfo), 'the pill shows from 1280 px; a phone has the status region only')
  relay.fault(503)
  try {
    await openApp(page, testInfo, { syncId: codeFor(7) })
    await expect(
      page.getByRole('button', { name: /^Sync retrying.*Opens Settings, Sync\.$/ }),
    ).toBeVisible({ timeout: 20_000 })
    await gate(page, testInfo)
  } finally {
    relay.fault(null)
  }

  const context = await browser.newContext({
    serviceWorkers: 'block',
    timezoneId: 'Asia/Singapore',
  })
  try {
    const paused = await context.newPage()
    await openApp(paused, testInfo, { 'st5:sync': NEWER_CONFIG })
    const pill = paused.getByRole('button', { name: /^Sync paused.*Opens Settings, Sync\.$/ })
    await expect(pill).toBeVisible({ timeout: 20_000 })
    await gate(paused, testInfo)
    await pill.click()
    await expect(paused.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  } finally {
    await context.close()
  }
})
