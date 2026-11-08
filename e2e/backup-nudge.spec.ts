import { test, expect, type Page } from '@playwright/test'
import {
  NOW,
  addDays,
  auditTargets,
  axeViolations,
  horizontalOverflow,
  isPhone,
  openSettings,
  row,
  seed,
  settle,
  switchTheme,
  waitForApp,
} from './support/a11y'

// "Time for a backup" (PR-4, F-050, acceptance 22-23): the owner's own entries have gone 30 local
// calendar days without a backup file. Download a backup records "Last backup" and hides it;
// Later keeps it away for 7 days, across reloads. This build has no relay, so the 60-day line of
// healthy sync is unit-tested (BackupNudge.test.tsx). Invented data on a fixed Singapore clock
// (Sun 18 Oct 2026), reduced motion.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

const TITLE = 'Time for a backup'
const TODAY = '2026-10-18'
const DAY_MS = 86_400_000
const nudge = (page: Page) => page.getByRole('region', { name: TITLE })

/** Three entries, the oldest `oldest` calendar days before today; never backed up. */
async function seedEntries(
  page: Page,
  oldest: number,
  theme: 'dark' | 'system' = 'dark',
): Promise<void> {
  await seed(page, {
    theme,
    expenses: [
      row('n-1', TODAY, 1.8, 'kopi'),
      row('n-2', addDays(TODAY, -3), 12, 'grab', 'Transportation'),
      row('n-3', addDays(TODAY, -oldest), 5.5, 'chicken rice'),
    ],
  })
}

async function open(page: Page): Promise<void> {
  await page.goto('/pulse')
  await waitForApp(page)
}

/** Nothing shows: the card chunk has loaded and decided. */
async function expectNoNudge(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await expect(nudge(page)).toHaveCount(0)
}

test('29 local calendar days without a backup show no card', async ({ page }) => {
  await seedEntries(page, 29)
  await open(page)
  await expectNoNudge(page)
})

test('30 local calendar days without a backup show the card', async ({ page }) => {
  await seedEntries(page, 30)
  await open(page)
  const card = nudge(page)
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { level: 2, name: TITLE })).toBeVisible()
  await expect(card.getByText("You haven't downloaded a backup yet.")).toBeVisible()
  await expect(card.getByText('This device holds the only copy of your entries.')).toBeVisible()
  // Never a live region: it is seen, not announced at boot.
  await expect(card).not.toHaveAttribute('aria-live')
})

test('Download a backup downloads, sets "Last backup: today" and hides the card', async ({
  page,
}) => {
  await seedEntries(page, 45)
  await open(page)
  const download = page.waitForEvent('download')
  await nudge(page).getByRole('button', { name: 'Download a backup' }).click()
  expect((await download).suggestedFilename()).toBe(`spendtrack-backup-${TODAY}.json`)
  await expect(nudge(page)).toHaveCount(0)
  await expect(page.locator('#main')).toBeFocused()

  const settings = await openSettings(page, 'Backup')
  await expect(settings.getByText('Last backup: today')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await waitForApp(page)
  await expectNoNudge(page)
})

test('Later hides it for 7 days, also across reloads', async ({ page }) => {
  await seedEntries(page, 45)
  await open(page)
  await nudge(page).getByRole('button', { name: 'Later' }).click()
  await expect(nudge(page)).toHaveCount(0)
  await expect(page.locator('#main')).toBeFocused()

  await page.reload()
  await waitForApp(page)
  await expectNoNudge(page)

  // Six days on: still away.
  await page.clock.setFixedTime(NOW.getTime() + 6 * DAY_MS)
  await page.reload()
  await waitForApp(page)
  await expectNoNudge(page)

  // Seven days on: back.
  await page.clock.setFixedTime(NOW.getTime() + 7 * DAY_MS)
  await page.reload()
  await waitForApp(page)
  await expect(nudge(page)).toBeVisible()
})

test('the backup card: no axe violations, 44 px, 320 px', async ({ page }, testInfo) => {
  test.slow(isPhone(testInfo), 'two scans, the target audit and a reflow in WebKit')
  const softly = expect.configure({ soft: true })
  await seedEntries(page, 45, 'system')
  await open(page)
  await expect(nudge(page)).toBeVisible()
  await settle(page)
  softly(await axeViolations(page), 'axe, dark').toEqual([])
  await switchTheme(page, 'light')
  softly(await axeViolations(page), 'axe, light').toEqual([])
  if (!isPhone(testInfo)) return
  const targets = await auditTargets(page)
  softly(targets.checked, 'controls in reach').toBeGreaterThan(0)
  softly(targets.problems, '44 px touch targets').toEqual([])
  await page.setViewportSize({ width: 320, height: 720 })
  await settle(page)
  softly(await horizontalOverflow(page, 320), '320 px, nothing sideways').toEqual([])
})
