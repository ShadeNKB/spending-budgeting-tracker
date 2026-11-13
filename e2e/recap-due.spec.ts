import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  dialog,
  isPhone,
  openSettings,
  row,
  seed,
  storedExpenses,
  waitForApp,
  type SeedExpense,
} from './support/a11y'

// T8b: charges due soon with a one-tap Log, a finished month in review, and how last month
// ended. Today is 18 Oct 2026 unless a test names another day. Invented data.
const monthly = (name: string, day: string, amount: number, category: string): SeedExpense[] =>
  ['07', '08', '09'].map((m) => row(`${name}-${m}`, `2026-${m}-${day}`, amount, name, category))

const ROWS = [
  ...monthly('rent', '18', 600, 'Other'),
  ...monthly('spotify', '20', 11.98, 'Subscriptions'),
  ...monthly('etf', '19', 300, 'Investment'),
  row('fl', '2026-09-22', 450, 'flight', 'Travel'),
  row('k1', '2026-10-03', 12.5, 'kopi', 'Food & Dining'),
]

const heroTotal = (page: Page) => page.locator('[class*="clamp(1.75rem"]')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-toast]').filter({ hasText: text })
/** The card under a heading: its nearest rounded card ancestor. */
const card = (page: Page, heading: string): Locator =>
  page
    .getByRole('heading', { name: heading, exact: true })
    .locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
const dueNames = async (page: Page): Promise<string[]> =>
  (await card(page, 'Due soon').getByRole('listitem').allInnerTexts()).map(
    (text) => text.split('\n')[0] ?? '',
  )

test('Insights lists what is due in the next 7 days; Log adds it for today, and Undo takes it back', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/insights')
  await waitForApp(page)
  const due = card(page, 'Due soon')
  await expect(due).toBeVisible()
  expect(await dueNames(page)).toEqual(['rent', 'etf', 'spotify'])
  const items = due.getByRole('listitem')
  await expect(items.nth(0)).toContainText('Today · Other')
  await expect(items.nth(1)).toContainText('Tomorrow · Investment')
  await expect(items.nth(2)).toContainText('Tue, Oct 20 · Subscriptions')
  await expect(due).toContainText('Nothing is added on its own.')
  // Nothing was added by showing it.
  expect(await storedExpenses(page)).toHaveLength(ROWS.length)

  await due.getByRole('button', { name: 'Log rent, S$600.00, for today' }).click()
  await expect(toast(page, 'Added "rent" · S$600.00')).toBeVisible()
  await expect(items).toHaveCount(2)
  expect(await dueNames(page)).toEqual(['etf', 'spotify'])
  const added = (await storedExpenses(page)).filter(
    (e) => e.itemName === 'rent' && e.date.startsWith('2026-10-18'),
  )
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ amount: 600, category: 'Other' })

  // A toast's action takes a press only once it has been on screen a moment (pressShield).
  await page.waitForTimeout(800)
  await toast(page, 'Added "rent"').getByRole('button', { name: 'Undo' }).click()
  await expect(items).toHaveCount(3)
  expect(await dueNames(page)).toEqual(['rent', 'etf', 'spotify'])
})

test('A double press on Log adds one entry, not the next charge too', async ({
  page,
}, testInfo) => {
  test.skip(isPhone(testInfo), 'a mouse double click')
  await seed(page, { expenses: ROWS })
  await page.goto('/insights')
  await waitForApp(page)
  const due = card(page, 'Due soon')
  // The list closes up after the first press: the second lands where the next Log now is.
  await due.getByRole('button', { name: 'Log rent, S$600.00, for today' }).dblclick()
  await expect(due.getByRole('listitem')).toHaveCount(2)
  await page.waitForTimeout(400)
  expect(await dueNames(page)).toEqual(['etf', 'spotify'])
  expect(await storedExpenses(page)).toHaveLength(ROWS.length + 1)
})

test('A charge that is not spending is still listed, says so, and stays out of the forecast', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/insights')
  await waitForApp(page)
  // Rent, the transfer and the subscription fall in the next 14 days.
  await expect(card(page, '14-day forecast')).toContainText('S$911.98')

  const settings = await openSettings(page, 'Budgets')
  await settings
    .getByRole('group', { name: 'Not spending' })
    .getByRole('button', { name: 'Investment', exact: true })
    .click()
  await page.keyboard.press('Escape')
  await expect(dialog(page, 'Settings')).toHaveCount(0)

  await expect(card(page, '14-day forecast')).toContainText('S$611.98')
  expect(await dueNames(page)).toEqual(['rent', 'etf', 'spotify'])
  const transfer = card(page, 'Due soon').getByRole('listitem').nth(1)
  await expect(transfer).toContainText('Tomorrow · Investment')
  await expect(transfer.getByText('not spending', { exact: true })).toBeVisible()
})

test('A finished month on Pulse is in review: its biggest expense opens in the Ledger', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/pulse')
  await waitForApp(page)
  // The month in progress is not reviewed yet.
  await expect(page.getByRole('heading', { name: 'Month in review' })).toHaveCount(0)

  await page.getByRole('button', { name: 'View previous month' }).click()
  await expect(heroTotal(page)).toHaveText('S$1,361.98')
  const review = card(page, 'Month in review')
  await expect(review).toContainText('September 2026')
  await expect(review).toContainText('S$600.00 · Sep 18')
  // The busiest day: rent's.
  await expect(review.getByRole('link', { name: 'Sep 18' })).toHaveAttribute(
    'href',
    '/ledger?date=2026-09-18',
  )
  // Four entries, on four of September's 30 days.
  await expect(review).toContainText('on 4 of 30 days')

  await review.getByRole('link', { name: 'rent', exact: true }).click()
  await expect(page).toHaveURL(/\/ledger\?date=2026-09-18/)
  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByLabel('Item')).toHaveValue('rent')
})

test('In the first days of a month Pulse says how the last one ended, once', async ({ page }) => {
  await seed(page, { expenses: ROWS, now: new Date('2026-11-02T10:00:00+08:00') })
  await page.goto('/pulse')
  await waitForApp(page)
  const closed = page.getByRole('region', { name: 'October closed' })
  await expect(closed).toContainText('October closed at S$12.50')
  await expect(closed).toContainText('99.1% less than September.')

  await closed.getByRole('button', { name: 'See October' }).click()
  await expect(closed).toHaveCount(0)
  await expect(heroTotal(page)).toHaveText('S$12.50')
  await expect(card(page, 'Month in review')).toContainText('October 2026')

  // Seen on this device: a reload does not say it again.
  await page.reload()
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$0.00')
  await expect(closed).toHaveCount(0)
})

test('From the 4th of the month the card is not shown; the month is still there to page to', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS, now: new Date('2026-11-04T10:00:00+08:00') })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$0.00')
  await expect(page.getByRole('region', { name: 'October closed' })).toHaveCount(0)
  await page.getByRole('button', { name: 'View previous month' }).click()
  await expect(card(page, 'Month in review')).toContainText('October 2026')
})

/** Whether `locator` and its buttons sit inside a 320 px screen that does not scroll sideways. */
const fits = (locator: Locator) =>
  locator.evaluate((el) => {
    const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
    return {
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      right: Math.max(el.getBoundingClientRect().right, ...buttons.map((r) => r.right)),
      left: Math.min(el.getBoundingClientRect().left, ...buttons.map((r) => r.left)),
    }
  })

test('At 320 px the month card fits: nothing is cut or scrolls sideways', async ({
  page,
}, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  await seed(page, { expenses: ROWS, now: new Date('2026-11-02T10:00:00+08:00') })
  await page.goto('/pulse')
  await waitForApp(page)
  const closed = page.getByRole('region', { name: 'October closed' })
  await expect(closed).toBeVisible()
  const box = await fits(closed)
  expect(box.pageScrolls).toBe(false)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(320)
  await expect(closed.getByRole('button', { name: 'See October' })).toBeVisible()
})

test('At 320 px a Due soon row with a long name keeps its amount and its Log on screen', async ({
  page,
}, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  const LONG = 'a subscription with a rather long name'
  await seed(page, { expenses: [...ROWS, ...monthly(LONG, '21', 1234.56, 'Subscriptions')] })
  await page.goto('/insights')
  await waitForApp(page)
  const due = card(page, 'Due soon')
  await expect(due.getByRole('listitem')).toHaveCount(4)
  const box = await fits(due)
  expect(box.pageScrolls).toBe(false)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(320)
  const long = due.getByRole('listitem').nth(3)
  await expect(long).toContainText('S$1,234.56')
  const log = long.getByRole('button', { name: `Log ${LONG}, S$1,234.56, for today` })
  await expect(log).toBeVisible()
  // The amount is whole: it does not give way to the name.
  const cut = await long.evaluate((el) => {
    const amount = [...el.querySelectorAll('span')].find((s) =>
      (s.textContent ?? '').startsWith('S$'),
    )
    return amount ? amount.scrollWidth > amount.clientWidth : true
  })
  expect(cut).toBe(false)
})
