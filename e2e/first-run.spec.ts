import { test, expect, type Page, type TestInfo } from '@playwright/test'
import {
  CATEGORIES,
  NOW,
  auditTargets,
  axeViolations,
  horizontalOverflow,
  isPhone,
  quickAdd,
  row,
  settle,
  storedExpenses,
  switchTheme,
  waitForApp,
} from './support/a11y'

// The first-run card (PR-4, F-050, acceptance 17-21): "Welcome to SpendTrack" on a pristine
// origin, which is also what a browser that cleared the site's data leaves. It sits above the
// screen without blocking it; Start fresh, an import or the first entry take it away for good.
// This build has no relay, so Restore from sync is not offered (its relay half is unit-tested).
// Invented data on a fixed Singapore clock, reduced motion.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

const TITLE = 'Welcome to SpendTrack'
const welcome = (page: Page) => page.getByRole('region', { name: TITLE })

/** A backup file with two invented entries, as an older SpendTrack wrote it. */
const BACKUP = {
  name: 'spendtrack-backup-2026-10-01.json',
  mimeType: 'application/json',
  buffer: Buffer.from(
    JSON.stringify({
      version: '4.0',
      exportDate: '2026-10-01T04:00:00.000Z',
      categories: [...CATEGORIES],
      categoryMappings: {},
      expenses: [
        row('old-phone-1', '2026-09-30', 4.5, 'old phone laksa'),
        row('old-phone-2', '2026-09-29', 12, 'old phone grab', 'Transportation'),
      ],
    }),
  ),
}

/**
 * A fresh origin on the fixed clock. `system` stores only the theme preference (still a fresh
 * origin: no data), so the OS scheme can flip the app between dark and light in place.
 */
async function freshOrigin(page: Page, opts: { theme?: 'system' } = {}): Promise<void> {
  await page.clock.setFixedTime(NOW)
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  if (opts.theme)
    await page.addInitScript((theme) => {
      localStorage.setItem('spendtrack:theme', theme)
    }, opts.theme)
}

async function open(page: Page, path = '/pulse'): Promise<void> {
  await page.goto(path)
  await waitForApp(page)
}

async function chooseFile(page: Page, file: typeof BACKUP): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await welcome(page).getByRole('button', { name: 'Import a backup file' }).click()
  await (await chooser).setFiles(file)
}

/** axe in both themes; on the phone also 44 px targets and nothing sideways at 320 px. */
async function auditBothThemes(page: Page, testInfo: TestInfo, what: string): Promise<void> {
  const softly = expect.configure({ soft: true })
  await settle(page)
  softly(await axeViolations(page), `${what}: axe, dark`).toEqual([])
  await switchTheme(page, 'light')
  softly(await axeViolations(page), `${what}: axe, light`).toEqual([])
  if (!isPhone(testInfo)) return
  const targets = await auditTargets(page)
  softly(targets.checked, `${what}: controls in reach`).toBeGreaterThan(0)
  softly(targets.problems, `${what}: 44 px touch targets`).toEqual([])
  await page.setViewportSize({ width: 320, height: 720 })
  await settle(page)
  softly(await horizontalOverflow(page, 320), `${what}: 320 px, nothing sideways`).toEqual([])
}

test('a fresh origin is welcomed above Pulse, Ledger and Insights; the screen stays usable', async ({
  page,
}) => {
  await freshOrigin(page)
  for (const path of ['/pulse', '/ledger', '/insights']) {
    await open(page, path)
    const card = welcome(page)
    await expect(card).toBeVisible()
    await expect(card.getByRole('heading', { level: 2, name: TITLE })).toBeVisible()
    // In main, first: above the screen's own headings, not over them.
    await expect(page.getByRole('main').getByRole('heading').first()).toHaveText(TITLE)
    await expect(page.getByRole('main').getByRole('heading')).not.toHaveCount(1)
    // This build has no relay: no Restore from sync.
    await expect(card.getByRole('button', { name: 'Restore from sync' })).toHaveCount(0)
  }

  // The screen under it works: the first entry, added while the card is up, takes it away.
  await open(page, '/pulse')
  await quickAdd(page).fill('kopi 1.80')
  await quickAdd(page).press('Enter')
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(1)
  await expect(welcome(page)).toHaveCount(0)
  await page.reload()
  await waitForApp(page)
  await expect(page.getByRole('main')).toBeVisible()
  await expect(welcome(page)).toHaveCount(0)
})

test('Start fresh hides it, and it stays hidden after a reload with zero entries', async ({
  page,
}) => {
  await freshOrigin(page)
  await open(page)
  await welcome(page).getByRole('button', { name: 'Start fresh' }).click()
  await expect(welcome(page)).toHaveCount(0)
  await expect(page.locator('#main')).toBeFocused()
  expect(await page.evaluate(() => localStorage.getItem('spendtrack:welcome'))).toBe('1')

  await page.reload()
  await waitForApp(page)
  await page.waitForLoadState('networkidle')
  await expect(welcome(page)).toHaveCount(0)
  expect(await storedExpenses(page)).toEqual([])
})

test('Import a backup file previews it in the card; Restore imports and the card goes', async ({
  page,
}) => {
  await freshOrigin(page)
  await open(page)
  await chooseFile(page, BACKUP)
  const preview = welcome(page).getByRole('region', { name: `Import ${BACKUP.name}?` })
  await expect(preview).toBeVisible()
  // The question takes the buttons' place, the safe choice first under the next key.
  await expect(welcome(page).getByRole('button', { name: 'Start fresh' })).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Restore', exact: true })).toBeFocused()

  await preview.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Imported · 2 added').first()).toBeVisible()
  await expect(welcome(page)).toHaveCount(0)
  const stored = await storedExpenses(page)
  expect(stored.map((e) => e.itemName).sort()).toEqual(['old phone grab', 'old phone laksa'])
})

test('a file that is not a backup says why, and the card stays', async ({ page }) => {
  await freshOrigin(page)
  await open(page)
  await chooseFile(page, {
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from('my shopping list, not JSON'),
  })
  await expect(
    page.getByText("This file isn't a SpendTrack backup (it isn't JSON).").first(),
  ).toBeVisible()
  await expect(welcome(page).getByRole('button', { name: 'Import a backup file' })).toBeVisible()
  expect(await storedExpenses(page)).toEqual([])
})

test('never shows where SpendTrack data is stored already (a v4 key, an envelope)', async ({
  page,
}) => {
  await freshOrigin(page)
  // The public v4 format: 0.10.0 migrates it on its first boot, so this is not a first run.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('expenses', '[]')
  })
  await open(page)
  await page.waitForLoadState('networkidle')
  await expect(welcome(page)).toHaveCount(0)
  // Now an envelope is stored: a reload is no first run either.
  await page.reload()
  await waitForApp(page)
  await page.waitForLoadState('networkidle')
  await expect(welcome(page)).toHaveCount(0)
})

test('the welcome card and its import preview: no axe violations, 44 px, 320 px', async ({
  page,
}, testInfo) => {
  test.slow(isPhone(testInfo), 'two scans per state, the target audit and a reflow in WebKit')
  await freshOrigin(page, { theme: 'system' })
  await open(page)
  await expect(welcome(page)).toBeVisible()
  await auditBothThemes(page, testInfo, 'welcome card')

  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
  await switchTheme(page, 'dark')
  await chooseFile(page, BACKUP)
  await expect(welcome(page).getByRole('region', { name: `Import ${BACKUP.name}?` })).toBeVisible()
  await auditBothThemes(page, testInfo, 'import preview in the card')
})
