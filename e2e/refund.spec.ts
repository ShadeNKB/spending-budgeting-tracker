import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  THEMES,
  axeViolations,
  dialog,
  isPhone,
  openAddSheet,
  openPalette,
  row,
  seed,
  storedExpenses,
  waitForApp,
  type SeedExpense,
} from './support/a11y'

// Refunds (F-058, second slice): money back for something paid for. A refund is added and edited
// in the sheets an expense is, keeps a category, and comes off that category and every spending
// figure. Today is 18 Oct 2026. Invented data: S$52.50 spent this month.
const ROWS = [
  row('m1', '2026-10-03', 12.5, 'kopi', 'Food & Dining'),
  row('m2', '2026-10-10', 40, 'grab', 'Transportation'),
  row('m3', '2026-09-12', 80, 'dinner', 'Food & Dining'),
]
/** A stored refund, as 0.20 writes it: the record's own `kind` field, the amount above zero. */
const refund = (
  id: string,
  day: string,
  amount: number,
  name: string,
  category: string,
): SeedExpense => ({ ...row(id, day, amount, name, category), kind: 'refund' }) as SeedExpense
const monthly = (name: string, day: string, amount: number, category: string): SeedExpense[] =>
  ['07', '08', '09'].map((m) => row(`${name}-${m}`, `2026-${m}-${day}`, amount, name, category))

const heroTotal = (page: Page) => page.locator('[class*="clamp(1.75rem"]')
const ledgerSummary = (page: Page) =>
  page.getByRole('heading', { name: 'Ledger' }).locator('xpath=../..')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-toast]').filter({ hasText: text })
const refundsLine = (page: Page) => page.getByText(/^Refunds S\$/)
const categoryGroup = (sheet: Locator) => sheet.getByRole('group', { name: /^Category/ })
const dayHeader = (page: Page, name: string) =>
  page.getByRole('heading', { name, exact: true }).locator('xpath=..')

test('A refund is added from the Add sheet and comes off the total, on Pulse and in the Ledger', async ({
  page,
}, testInfo) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$52.50')
  await expect(refundsLine(page)).toHaveCount(0)

  const sheet = await openAddSheet(page, testInfo)
  await sheet.getByRole('radio', { name: 'Refund' }).click()
  const refundSheet = dialog(page, 'Add refund')
  await expect(refundSheet).toBeVisible()
  // A refund has a category: the one it comes off.
  await expect(categoryGroup(refundSheet)).toBeVisible()
  await expect(refundSheet.getByText(/Money back for something you paid for/)).toBeVisible()
  await refundSheet.getByRole('textbox', { name: 'What' }).fill('Dinner split')
  await refundSheet.getByRole('spinbutton', { name: 'Amount' }).fill('5')
  await refundSheet.getByRole('button', { name: 'Food & Dining', exact: true }).click()
  await refundSheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(toast(page, 'Added refund "Dinner split" · S$5.00')).toBeVisible()

  // The total is net, and the line under it says what came off.
  await expect(heroTotal(page)).toHaveText('S$47.50')
  await expect(refundsLine(page)).toHaveText('Refunds S$5.00 · taken off the total')
  // Stored with the amount as typed, in its category.
  const stored = (await storedExpenses(page)).find((e) => e.itemName === 'Dinner split')
  expect(stored).toMatchObject({ amount: 5, category: 'Food & Dining', kind: 'refund' })

  await page.getByRole('radio', { name: 'Year' }).click()
  await expect(heroTotal(page)).toHaveText('S$127.50')
  await expect(refundsLine(page)).toHaveText('Refunds S$5.00 · taken off the total')

  await page.reload()
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$47.50')

  // The Ledger lists it with a minus and the word, and its total is the same net.
  await page.goto('/ledger')
  await waitForApp(page)
  const summary = ledgerSummary(page)
  await expect(summary).toContainText('S$47.50')
  await expect(summary).toContainText('3 entries')
  await expect(summary).toContainText('after S$5.00 in refunds')
  const split = page.getByRole('button', {
    name: 'Edit Dinner split, -S$5.00 refund, Food & Dining, Oct 18',
  })
  await expect(split).toBeVisible()
  await expect(split.getByText('refund', { exact: true })).toBeVisible()
  // Its day holds nothing else: the day's figure is what came back.
  await expect(dayHeader(page, 'Today')).toContainText('-S$5.00')

  // Its category lists it with the spending it comes off, and sums the two.
  await page.goto('/ledger?range=month&category=Food+%26+Dining')
  await waitForApp(page)
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(2)
  await expect(ledgerSummary(page)).toContainText('S$7.50')
})

test('A category budget measures what was spent less what came back', async ({ page }) => {
  await seed(page, {
    expenses: [...ROWS, refund('r1', '2026-10-12', 5, 'dinner split', 'Food & Dining')],
    budgets: { 'Food & Dining': 20 },
  })
  await page.goto('/pulse')
  await waitForApp(page)
  // 12.50 spent, 5.00 back: 7.50 of 20.
  await expect(page.getByText('38% used · S$12.50 left')).toBeVisible()
})

test('The Edit sheet makes an expense a refund, the total follows below zero, and Undo takes it back', async ({
  page,
}) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/ledger')
  await waitForApp(page)
  await expect(ledgerSummary(page)).toContainText('S$52.50')

  await page.getByRole('button', { name: 'Edit grab, S$40.00, Transportation, Oct 10' }).click()
  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  await sheet.getByRole('radio', { name: 'Refund' }).click()
  const refundSheet = dialog(page, 'Edit refund')
  // It keeps the category it had.
  await expect(
    categoryGroup(refundSheet).getByRole('button', { name: 'Transportation', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(refundSheet.getByRole('button', { name: 'Delete refund' })).toBeVisible()
  await refundSheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(toast(page, 'Refund updated')).toBeVisible()

  // 12.50 spent, 40.00 back.
  await expect(ledgerSummary(page)).toContainText('-S$27.50')
  await expect(ledgerSummary(page)).toContainText('after S$40.00 in refunds')
  await expect(
    page.getByRole('button', { name: 'Edit grab, -S$40.00 refund, Transportation, Oct 10' }),
  ).toBeVisible()
  expect((await storedExpenses(page)).find((e) => e.id === 'm2')).toMatchObject({
    amount: 40,
    category: 'Transportation',
    kind: 'refund',
  })

  // A toast's action takes a press only once it has been on screen a moment (pressShield).
  await page.waitForTimeout(800)
  await toast(page, 'Refund updated').getByRole('button', { name: 'Undo' }).click()
  await expect(ledgerSummary(page)).toContainText('S$52.50')
  await expect(ledgerSummary(page)).not.toContainText('refunds')
  expect((await storedExpenses(page)).find((e) => e.id === 'm2')).not.toHaveProperty('kind')
})

test('The palette lists a refund with its minus, under its category', async ({ page }) => {
  await seed(page, {
    expenses: [...ROWS, refund('r1', '2026-10-05', 5, 'dinner split', 'Food & Dining')],
  })
  await page.goto('/pulse')
  await waitForApp(page)
  const palette = await openPalette(page)
  await palette.getByRole('combobox').fill('split')
  const hit = palette.getByRole('group', { name: 'Entries' }).getByRole('option')
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText('Food & Dining / Oct 5')
  await expect(hit).toContainText('-S$5.00')
})

test('A monthly refund is never offered as a charge due', async ({ page }) => {
  const cashback = ['07', '08', '09'].map((m) =>
    refund(`cb-${m}`, `2026-${m}-19`, 8, 'card cashback', 'Shopping'),
  )
  await seed(page, { expenses: [...ROWS, ...monthly('rent', '18', 600, 'Other'), ...cashback] })
  await page.goto('/insights')
  await waitForApp(page)
  const due = page
    .getByRole('heading', { name: 'Due soon', exact: true })
    .locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
  await expect(due).toBeVisible()
  await expect(due.getByRole('listitem')).toHaveCount(1)
  await expect(due.getByRole('listitem')).toContainText('rent')
  await expect(page.getByText('card cashback')).toHaveCount(0)
})

test('At 320 px the three kinds, a refund row and the Ledger’s sums fit', async ({
  page,
}, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  const LONG = 'Refund for the mechanical keyboard returned to the shop in Sim Lim'
  await seed(page, { expenses: [...ROWS, refund('r1', '2026-10-16', 1234.56, LONG, 'Shopping')] })
  await page.goto('/ledger')
  await waitForApp(page)
  const rowButton = page.getByRole('button', {
    name: new RegExp(`^Edit ${LONG}, -S\\$1,234\\.56 refund`),
  })
  await expect(rowButton).toBeVisible()
  const cut = await rowButton.evaluate((el) => {
    const amount = [...el.querySelectorAll('span')].find((s) =>
      (s.textContent ?? '').startsWith('-S$'),
    )
    return {
      amountCut: amount ? amount.scrollWidth > amount.clientWidth : true,
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      right: el.getBoundingClientRect().right,
    }
  })
  expect(cut.amountCut).toBe(false)
  expect(cut.pageScrolls).toBe(false)
  expect(cut.right).toBeLessThanOrEqual(320)
  await expect(ledgerSummary(page)).toContainText('after S$1,234.56 in refunds')

  const sheet = await openAddSheet(page, testInfo)
  await sheet.getByRole('radio', { name: 'Refund' }).click()
  const refundSheet = dialog(page, 'Add refund')
  await expect(refundSheet).toBeVisible()
  const box = await refundSheet.evaluate((el) => {
    const group = el.querySelector('[role="radiogroup"]')
    const radios = [...(group?.querySelectorAll('[role="radio"]') ?? [])]
    const rect = group?.getBoundingClientRect()
    return {
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      left: rect?.left ?? -1,
      right: rect?.right ?? 9999,
      // no label of the switch is cut
      cut: radios.some((r) => r.scrollWidth > r.clientWidth),
      count: radios.length,
    }
  })
  expect(box.pageScrolls).toBe(false)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(320)
  expect(box.count).toBe(3)
  expect(box.cut).toBe(false)
  await expect(refundSheet.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
})

for (const theme of THEMES) {
  test(`Refunds pass axe in the ${theme} theme: Pulse's line, the Ledger row and both sheets`, async ({
    page,
  }, testInfo) => {
    await seed(page, {
      theme,
      expenses: [
        ...ROWS,
        refund('r1', '2026-10-16', 5, 'dinner split', 'Food & Dining'),
        row('m4', '2026-10-18', 3.2, 'teh', 'Food & Dining'),
        refund('r2', '2026-10-18', 20, 'returned cable', 'Shopping'),
      ],
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(refundsLine(page)).toBeVisible()
    // Today lists the refund with the day's spending.
    await expect(
      page.getByRole('button', { name: 'Edit returned cable, -S$20.00 refund, Shopping' }),
    ).toBeVisible()
    expect.soft(await axeViolations(page), 'Pulse').toEqual([])

    await page.goto('/ledger')
    await waitForApp(page)
    await expect(page.getByRole('button', { name: /^Edit dinner split, / })).toBeVisible()
    expect.soft(await axeViolations(page), 'Ledger').toEqual([])
    // A hovered row is a lighter ground under the same green.
    await page.getByRole('button', { name: /^Edit dinner split, / }).hover()
    expect.soft(await axeViolations(page), 'Ledger, row hovered').toEqual([])

    await page.getByRole('button', { name: /^Edit dinner split, / }).click()
    await expect(dialog(page, 'Edit refund')).toBeVisible()
    expect.soft(await axeViolations(page), 'Edit refund').toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog(page, 'Edit refund')).toHaveCount(0)

    const sheet = await openAddSheet(page, testInfo)
    await sheet.getByRole('radio', { name: 'Refund' }).click()
    await expect(dialog(page, 'Add refund')).toBeVisible()
    expect.soft(await axeViolations(page), 'Add refund').toEqual([])
  })
}
