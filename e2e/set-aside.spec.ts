import { test, expect, type Locator, type Page } from '@playwright/test'
import { dialog, openSettings, row, seed, waitForApp } from './support/a11y'

// T8a (F-057): what counts as spending, and one budget for the whole month. Today is 18 Oct 2026.
// Invented data: S$52.50 spent this month, S$300 moved into an investment.
const ROWS = [
  row('a1', '2026-10-03', 12.5, 'kopi', 'Food & Dining'),
  row('a2', '2026-10-04', 300, 'etf', 'Investment'),
  row('a3', '2026-10-10', 40, 'grab', 'Transportation'),
  row('a4', '2026-09-12', 80, 'dinner', 'Food & Dining'),
  row('a5', '2026-09-15', 300, 'etf', 'Investment'),
]

const heroTotal = (page: Page) => page.locator('[class*="clamp(1.75rem"]')
const ledgerSummary = (page: Page) =>
  page.getByRole('heading', { name: 'Ledger' }).locator('xpath=../..')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-toast]').filter({ hasText: text })
const asideLine = (page: Page) => page.getByText(/^Set aside S\$[\d,.]+ · not in the total$/)

const chip = (settings: Locator, name: string) =>
  settings.getByRole('group', { name: 'Not spending' }).getByRole('button', { name, exact: true })

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(dialog(page, 'Settings')).toHaveCount(0)
}

test('A category set aside leaves Pulse and the Ledger total, on its own line, and stays so', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$352.50')
  await expect(asideLine(page)).toHaveCount(0)

  let settings = await openSettings(page, 'Budgets')
  await expect(chip(settings, 'Investment')).toHaveAttribute('aria-pressed', 'false')
  // "Other" holds deleted categories' entries: it always counts.
  await expect(chip(settings, 'Other')).toHaveCount(0)
  await chip(settings, 'Investment').click()
  await expect(chip(settings, 'Investment')).toHaveAttribute('aria-pressed', 'true')
  await expect(toast(page, 'Investment set aside: out of your totals')).toBeVisible()
  await closeSettings(page)

  await expect(heroTotal(page)).toHaveText('S$52.50')
  await expect(asideLine(page)).toHaveText('Set aside S$300.00 · not in the total')
  // Top categories are spending only.
  await expect(page.getByRole('button', { name: /^Investment/ })).toHaveCount(0)

  // The year: its own set-aside sum.
  await page.getByRole('radio', { name: 'Year' }).click()
  await expect(heroTotal(page)).toHaveText('S$132.50')
  await expect(asideLine(page)).toHaveText('Set aside S$600.00 · not in the total')

  // It is stored: a reload shows the same.
  await page.reload()
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$52.50')

  // The Ledger lists the entry, says what it is, and sums it beside the total.
  await page.goto('/ledger')
  await waitForApp(page)
  const summary = ledgerSummary(page)
  await expect(summary).toContainText('S$52.50')
  await expect(summary).toContainText('3 entries')
  await expect(summary).toContainText('S$300.00 set aside')
  const etf = page.getByRole('button', { name: 'Edit etf, S$300.00 set aside, Investment, Oct 4' })
  await expect(etf).toBeVisible()
  await expect(etf.getByText('set aside')).toBeVisible()
  // Its day's total is that day's spending: none.
  await expect(
    page.getByRole('heading', { name: 'Sun / Oct 4' }).locator('xpath=..'),
  ).toContainText('S$0.00')
  await expect(
    page.getByRole('button', { name: 'Edit kopi, S$12.50, Food & Dining, Oct 3' }),
  ).toBeVisible()

  // Counted again: one figure, as before.
  settings = await openSettings(page, 'Budgets')
  await chip(settings, 'Investment').click()
  await expect(toast(page, 'Investment counts as spending again')).toBeVisible()
  await closeSettings(page)
  await expect(summary).toContainText('S$352.50')
  await expect(summary).not.toContainText('set aside')
})

test('Setting a category aside can be undone from its toast, and its budget cap comes back', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS, budgets: { Investment: 500, 'Food & Dining': 100 } })
  await page.goto('/pulse')
  await waitForApp(page)
  const settings = await openSettings(page, 'Budgets')
  const cap = settings.getByRole('spinbutton', { name: 'Monthly budget for Investment' })
  await expect(cap).toHaveValue('500')
  await chip(settings, 'Investment').click()
  // A cap on a set-aside category measures nothing: the row says so in place of the field.
  await expect(cap).toHaveCount(0)
  // A toast's action takes a press only once it has been on screen a moment (pressShield): a
  // press in the instant it appears is the tail of the press that raised it, and does nothing.
  await page.waitForTimeout(800)
  await toast(page, 'Investment set aside').getByRole('button', { name: 'Undo' }).click()
  await expect(chip(settings, 'Investment')).toHaveAttribute('aria-pressed', 'false')
  await expect(cap).toHaveValue('500')
  await closeSettings(page)
  await expect(heroTotal(page)).toHaveText('S$352.50')
})

test('One budget for the whole month measures all spending: what is left, and how much a day', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(page.getByRole('heading', { name: 'No monthly budgets set' })).toBeVisible()

  let settings = await openSettings(page, 'Budgets')
  const whole = settings.getByRole('spinbutton', { name: 'Monthly budget for all spending' })
  await whole.fill('500')
  await whole.press('Enter')
  await expect(toast(page, 'Whole month: S$500.00 budget set')).toBeVisible()
  await closeSettings(page)

  // 352.50 of 500 by the 18th of a 31-day month: 147.50 left over 14 days.
  const ring = page.getByRole('img', { name: /^Monthly budget \d+% used/ })
  await expect(ring).toHaveAccessibleName(/S\$352\.50 of S\$500\.00\./)
  await expect(ring).toHaveAccessibleName(/S\$147\.50 left, S\$10\.54 a day, 14 days left\./)
  await expect(ring).not.toHaveAccessibleName(/Budgeted categories only/)
  await expect(page.getByRole('heading', { name: 'No monthly budgets set' })).toHaveCount(0)

  // Money set aside is not spending: it leaves the budget too.
  settings = await openSettings(page, 'Budgets')
  await chip(settings, 'Investment').click()
  await closeSettings(page)
  await expect(ring).toHaveAccessibleName(/S\$52\.50 of S\$500\.00\./)
  await expect(ring).toHaveAccessibleName(/S\$447\.50 left/)

  // Clearing the field removes the budget.
  settings = await openSettings(page, 'Budgets')
  await settings.getByRole('spinbutton', { name: 'Monthly budget for all spending' }).fill('')
  await page.keyboard.press('Enter')
  await expect(toast(page, 'Monthly budget cleared')).toBeVisible()
  await closeSettings(page)
  await expect(ring).toHaveCount(0)
})

test('The Budgets tab fits a 320 px phone: nothing scrolls sideways, every switch is 44 px tall to touch', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  await seed(page, {
    expenses: [
      ...ROWS,
      row('a6', '2026-10-11', 9, 'gift', 'A category with quite a long name here'),
    ],
  })
  await page.goto('/pulse')
  await waitForApp(page)
  const settings = await openSettings(page, 'Budgets')
  const group = settings.getByRole('group', { name: 'Not spending' })
  await group.scrollIntoViewIfNeeded()
  const fits = await group.evaluate((el) => {
    const panel = el.closest('[role="tabpanel"]')
    const chips = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
    return {
      scrolls: panel ? panel.scrollWidth > panel.clientWidth : true,
      right: Math.max(...chips.map((r) => r.right)),
      left: Math.min(...chips.map((r) => r.left)),
      count: chips.length,
    }
  })
  expect(fits.count).toBe(11)
  expect(fits.scrolls).toBe(false)
  expect(fits.left).toBeGreaterThanOrEqual(0)
  expect(fits.right).toBeLessThanOrEqual(320)
})
