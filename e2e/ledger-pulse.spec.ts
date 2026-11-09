import { test, expect } from '@playwright/test'
import { manyRows, row, seed, settle, waitForApp } from './support/a11y'

// T7a: what only a real layout shows — headers that stick, a drill that keeps its period,
// avatar colours the browser accepts.

test('Ledger day headers stick under the app header as the page scrolls (F-081)', async ({
  page,
}) => {
  await seed(page, { expenses: manyRows(90) })
  await page.goto('/ledger')
  await waitForApp(page)
  await settle(page)
  const headerHeight = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')),
  )
  expect(headerHeight).toBeGreaterThan(0)

  await page.evaluate(() => {
    window.scrollBy(0, 1600)
  })
  await expect
    .poll(() =>
      page.evaluate((h) => {
        const tops = [...document.querySelectorAll('main section > header')].map(
          (el) => el.getBoundingClientRect().top,
        )
        return tops.some((top) => Math.abs(top - h) <= 1)
      }, headerHeight),
    )
    .toBe(true)
})

test('A category on a past Pulse month opens the Ledger over that month (F-085)', async ({
  page,
}) => {
  await seed(page, {
    expenses: [row('s1', '2026-09-10', 12, 'laksa'), row('o1', '2026-10-10', 5, 'kopi')],
  })
  await page.goto('/pulse')
  await waitForApp(page)
  await page.getByRole('button', { name: 'View previous month' }).click()
  await page
    .getByRole('button', { name: /^Food & Dining/ })
    .first()
    .click()

  await expect(page).toHaveURL(/range=custom&customStart=2026-09-01&customEnd=2026-09-30/)
  await waitForApp(page)
  await expect(page.getByRole('button', { name: /^Edit laksa, / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Edit kopi, / })).toHaveCount(0)
})

test('Ledger avatars draw their tint, and an emoji name keeps its emoji (F-117, F-112)', async ({
  page,
}) => {
  await seed(page, { expenses: [row('e1', '2026-10-17', 9, '\u{1F35C} laksa')] })
  await page.goto('/ledger')
  await waitForApp(page)
  const avatar = page
    .getByRole('button', { name: /^Edit \u{1F35C} laksa, /u })
    .locator('span')
    .first()
  await expect(avatar).toHaveText('\u{1F35C}')
  const background = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(background).not.toBe('rgba(0, 0, 0, 0)')
})
