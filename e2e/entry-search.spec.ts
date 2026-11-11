import { test, expect } from '@playwright/test'
import {
  dialog,
  isPhone,
  manyRows,
  openPalette,
  quickAdd,
  seed,
  settle,
  waitForApp,
} from './support/a11y'

// T7e: one category matcher behind every way in (F-044), palette actions found by typing
// (F-055), and what only a real layout shows of the phone fixes (F-110, the backup card).

test('The quick bar and the Add sheet suggest the same category, through a typo (F-044)', async ({
  page,
}) => {
  await seed(page)
  await page.goto('/pulse')
  await waitForApp(page)
  // Taught once: a category word after the amount files it, and the app learns the name.
  await quickAdd(page).fill('Grab home 12 transportation')
  await quickAdd(page).press('Enter')
  await expect(page.locator('[data-toast]').filter({ hasText: 'Added "Grab home"' })).toBeVisible()

  // The quick bar's own preview, for a misspelt name...
  await page.waitForTimeout(600)
  await quickAdd(page).fill('grab hme 9.50')
  const preview = page.getByText('Transportation', { exact: true }).filter({ visible: true })
  await expect(preview.first()).toBeVisible()

  // ...and the full form, opened on the same text, marks the same pick.
  await page.getByRole('button', { name: 'Full entry form' }).filter({ visible: true }).click()
  const sheet = dialog(page, 'Add expense')
  await expect(sheet.getByPlaceholder(/coffee, grab, spotify/i)).toHaveValue('grab hme')
  await expect(sheet.getByRole('button', { name: 'Transportation, suggested' })).toBeVisible()
})

test('The palette finds a Settings section and a Ledger view by typing (F-055)', async ({
  page,
}) => {
  await seed(page, { expenses: manyRows(6) })
  await page.goto('/pulse')
  await waitForApp(page)
  let palette = await openPalette(page)
  await expect(palette.getByRole('option')).toHaveCount(6)
  await palette.getByRole('combobox').fill('budg')
  await palette.getByRole('option', { name: /Budgets/ }).click()
  const settings = dialog(page, 'Settings')
  await expect(settings.getByRole('tab', { name: 'Budgets', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  await page.waitForTimeout(600)
  palette = await openPalette(page)
  await palette.getByRole('combobox').fill('all time')
  await palette.getByRole('option', { name: /Ledger: all time/ }).click()
  await expect(page).toHaveURL(/\/ledger\?range=all$/)
  await expect(page.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
})

test('At 320 px the six Ledger ranges show whole, with nothing to scroll (F-110)', async ({
  page,
}, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  await seed(page, { expenses: manyRows(6) })
  await page.goto('/ledger')
  await waitForApp(page)
  await settle(page)
  const group = page.getByRole('radiogroup', { name: 'Date range' })
  const fits = await group.evaluate((el) => {
    const scroller = el.parentElement
    const radios = [...el.querySelectorAll('[role="radio"]')].map((r) => r.getBoundingClientRect())
    return {
      scrolls: scroller ? scroller.scrollWidth > scroller.clientWidth : true,
      left: Math.min(...radios.map((r) => r.left)),
      right: Math.max(...radios.map((r) => r.right)),
      narrowest: Math.min(...radios.map((r) => r.width)),
      count: radios.length,
    }
  })
  expect(fits.count).toBe(6)
  expect(fits.scrolls).toBe(false)
  expect(fits.left).toBeGreaterThanOrEqual(0)
  expect(fits.right).toBeLessThanOrEqual(320)
  // Each still as wide as a finger needs.
  expect(fits.narrowest).toBeGreaterThanOrEqual(44)
  await page.getByRole('radio', { name: 'Custom' }).click()
  await expect(page.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true')
})

test("On a phone the backup card's two buttons share a row", async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await seed(page, { expenses: manyRows(30) })
  await page.goto('/ledger')
  await waitForApp(page)
  const download = page.getByRole('button', { name: 'Download a backup' })
  test.skip((await download.count()) === 0, 'no backup card for this seed')
  const [a, b] = await Promise.all([
    download.boundingBox(),
    page.getByRole('button', { name: 'Later' }).boundingBox(),
  ])
  expect(a?.y).toBe(b?.y)
  expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0)
})
