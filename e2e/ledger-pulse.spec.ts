import { test, expect } from '@playwright/test'
import { dialog, manyRows, openPalette, row, seed, settle, waitForApp } from './support/a11y'

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

  // To 100 px inside the fourth day, where its header is the one that sticks. A fixed distance
  // can land where one header hands over to the next, and neither is at the top just then.
  await page.evaluate((h) => {
    const day = document.querySelectorAll('main section')[3]
    if (!day) throw new Error('no fourth day')
    window.scrollBy(0, day.getBoundingClientRect().top - h + 100)
  }, headerHeight)
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

test('A Today row on Pulse opens its entry to edit in the Ledger (F-116)', async ({ page }) => {
  await seed(page, {
    expenses: [row('t1', '2026-10-18', 4.5, 'kopi'), row('t2', '2026-10-18', 6, 'laksa')],
  })
  await page.goto('/pulse')
  await waitForApp(page)
  await page.getByRole('button', { name: /^Edit kopi, / }).click()

  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByLabel('Item')).toHaveValue('kopi')
  // Opened once: the request leaves the URL, so Back or a reload never opens it again.
  await expect(page).toHaveURL(/\/ledger\?date=2026-10-18&q=kopi$/)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: /^Edit kopi, / })).toBeFocused()
})

test('An expense picked in the palette opens to edit (F-080)', async ({ page }) => {
  await seed(page, {
    expenses: [row('s1', '2026-10-12', 12, 'laksa'), row('o1', '2026-10-10', 5, 'kopi')],
  })
  await page.goto('/pulse')
  await waitForApp(page)
  const palette = await openPalette(page)
  await palette.getByRole('combobox').fill('laksa')
  await palette.getByRole('option', { name: /laksa/ }).click()

  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByLabel('Item')).toHaveValue('laksa')
  await expect(page).toHaveURL(/\/ledger\?date=2026-10-12&q=laksa$/)
})
