import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  THEMES,
  axeViolations,
  dialog,
  isPhone,
  openAddSheet,
  row,
  seed,
  storedExpenses,
  waitForApp,
  type SeedExpense,
} from './support/a11y'

// T8c (F-058): money in. An income is added and edited in the sheets an expense is, listed in the
// Ledger with its sign, summed on its own line, and in no spending figure. Today is 18 Oct 2026.
// Invented data: S$52.50 spent this month.
const ROWS = [
  row('m1', '2026-10-03', 12.5, 'kopi', 'Food & Dining'),
  row('m2', '2026-10-10', 40, 'grab', 'Transportation'),
  row('m3', '2026-09-12', 80, 'dinner', 'Food & Dining'),
]
/** A stored income, as 0.19 writes it: the record's own `kind` field. */
const income = (id: string, day: string, amount: number, name: string): SeedExpense =>
  ({ ...row(id, day, amount, name, 'Other'), kind: 'income' }) as SeedExpense
const monthly = (name: string, day: string, amount: number, category: string): SeedExpense[] =>
  ['07', '08', '09'].map((m) => row(`${name}-${m}`, `2026-${m}-${day}`, amount, name, category))

const heroTotal = (page: Page) => page.locator('[class*="clamp(1.75rem"]')
const ledgerSummary = (page: Page) =>
  page.getByRole('heading', { name: 'Ledger' }).locator('xpath=../..')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-toast]').filter({ hasText: text })
const moneyIn = (page: Page) => page.getByText(/^Money in S\$/)
const categoryGroup = (sheet: Locator) => sheet.getByRole('group', { name: /^Category/ })

test('An income is added from the Add sheet, said on Pulse and in the Ledger, and stays out of spending', async ({
  page,
}, testInfo) => {
  await seed(page, { expenses: ROWS })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$52.50')
  await expect(moneyIn(page)).toHaveCount(0)

  const sheet = await openAddSheet(page, testInfo)
  await expect(sheet.getByRole('radio', { name: 'Expense' })).toBeChecked()
  await expect(categoryGroup(sheet)).toBeVisible()
  await sheet.getByRole('radio', { name: 'Income' }).click()
  const incomeSheet = dialog(page, 'Add income')
  await expect(incomeSheet).toBeVisible()
  await expect(categoryGroup(incomeSheet)).toHaveCount(0)
  await incomeSheet.getByRole('textbox', { name: 'What' }).fill('Allowance')
  await incomeSheet.getByRole('spinbutton', { name: 'Amount' }).fill('790')
  await incomeSheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(toast(page, 'Added income "Allowance" · S$790.00')).toBeVisible()

  // Spending is what it was; the money in has its own line, with what it leaves.
  await expect(heroTotal(page)).toHaveText('S$52.50')
  await expect(moneyIn(page)).toHaveText('Money in S$790.00 · S$737.50 more than spent')
  // It is stored as an income, under no category of its own.
  const stored = (await storedExpenses(page)).find((e) => e.itemName === 'Allowance')
  expect(stored).toMatchObject({ amount: 790, category: 'Other', kind: 'income' })

  // The year sums its own.
  await page.getByRole('radio', { name: 'Year' }).click()
  await expect(heroTotal(page)).toHaveText('S$132.50')
  await expect(moneyIn(page)).toHaveText('Money in S$790.00 · S$657.50 more than spent')

  await page.reload()
  await waitForApp(page)
  await expect(heroTotal(page)).toHaveText('S$52.50')
  await expect(moneyIn(page)).toHaveText('Money in S$790.00 · S$737.50 more than spent')

  // The Ledger lists it with its sign and the word, and sums it beside the spending.
  await page.goto('/ledger')
  await waitForApp(page)
  const summary = ledgerSummary(page)
  await expect(summary).toContainText('S$52.50')
  await expect(summary).toContainText('3 entries')
  await expect(summary).toContainText('+S$790.00 money in')
  const allowance = page.getByRole('button', {
    name: 'Edit Allowance, +S$790.00 income, Oct 18',
  })
  await expect(allowance).toBeVisible()
  await expect(allowance.getByText('income', { exact: true })).toBeVisible()
  // Its day's total is that day's spending: none.
  await expect(page.getByRole('heading', { name: 'Today' }).locator('xpath=..')).toContainText(
    'S$0.00',
  )

  // A search for the word finds it, and only it.
  await page.getByRole('textbox', { name: 'Search expenses' }).fill('income')
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(1)
  await expect(allowance).toBeVisible()
})

test('Spending more than came in says by how much', async ({ page }) => {
  await seed(page, { expenses: [...ROWS, income('i1', '2026-10-05', 20, 'sold a book')] })
  await page.goto('/pulse')
  await waitForApp(page)
  await expect(moneyIn(page)).toHaveText('Money in S$20.00 · S$32.50 less than spent')
})

test('The Edit sheet turns an income into an expense, which then counts, and Undo takes that back', async ({
  page,
}) => {
  await seed(page, { expenses: [...ROWS, income('i1', '2026-10-05', 200, 'sold bike')] })
  await page.goto('/ledger')
  await waitForApp(page)
  await expect(ledgerSummary(page)).toContainText('S$52.50')

  await page.getByRole('button', { name: /^Edit sold bike, \+S\$200\.00 income/ }).click()
  const sheet = dialog(page, 'Edit income')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('radio', { name: 'Income' })).toBeChecked()
  await expect(categoryGroup(sheet)).toHaveCount(0)
  await sheet.getByRole('radio', { name: 'Expense' }).click()
  const expenseSheet = dialog(page, 'Edit expense')
  await expect(categoryGroup(expenseSheet)).toBeVisible()
  await expenseSheet.getByRole('button', { name: 'Shopping', exact: true }).click()
  await expenseSheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(toast(page, 'Expense updated')).toBeVisible()

  await expect(ledgerSummary(page)).toContainText('S$252.50')
  await expect(ledgerSummary(page)).not.toContainText('money in')
  await expect(
    page.getByRole('button', { name: 'Edit sold bike, S$200.00, Shopping, Oct 5' }),
  ).toBeVisible()
  expect((await storedExpenses(page)).find((e) => e.id === 'i1')).not.toHaveProperty('kind')

  // A toast's action takes a press only once it has been on screen a moment (pressShield).
  await page.waitForTimeout(800)
  await toast(page, 'Expense updated').getByRole('button', { name: 'Undo' }).click()
  await expect(ledgerSummary(page)).toContainText('S$52.50')
  await expect(ledgerSummary(page)).toContainText('+S$200.00 money in')
})

test('A monthly income is in no Insights figure and is never offered as a charge due', async ({
  page,
}) => {
  const allowance = ['07', '08', '09'].map((m) =>
    income(`pay-${m}`, `2026-${m}-19`, 790, 'allowance'),
  )
  await seed(page, { expenses: [...ROWS, ...monthly('rent', '18', 600, 'Other'), ...allowance] })
  await page.goto('/insights')
  await waitForApp(page)
  const due = page
    .getByRole('heading', { name: 'Due soon', exact: true })
    .locator('xpath=ancestor::*[contains(@class,"rounded-2xl")][1]')
  await expect(due).toBeVisible()
  await expect(due.getByRole('listitem')).toHaveCount(1)
  await expect(due.getByRole('listitem')).toContainText('rent')
  await expect(page.getByText('allowance')).toHaveCount(0)
})

test('At 320 px the Add sheet for an income and an income row fit', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone')
  await page.setViewportSize({ width: 320, height: 568 })
  const LONG = 'Sold the old phone on Carousell to a buyer in Tampines'
  await seed(page, { expenses: [...ROWS, income('i1', '2026-10-16', 1234.56, LONG)] })
  await page.goto('/ledger')
  await waitForApp(page)
  const rowButton = page.getByRole('button', {
    name: new RegExp(`^Edit ${LONG}, \\+S\\$1,234\\.56 income`),
  })
  await expect(rowButton).toBeVisible()
  const cut = await rowButton.evaluate((el) => {
    const amount = [...el.querySelectorAll('span')].find((s) =>
      (s.textContent ?? '').startsWith('+S$'),
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

  const sheet = await openAddSheet(page, testInfo)
  await sheet.getByRole('radio', { name: 'Income' }).click()
  const incomeSheet = dialog(page, 'Add income')
  await expect(incomeSheet).toBeVisible()
  const box = await incomeSheet.evaluate((el) => {
    const group = el.querySelector('[role="radiogroup"]')?.getBoundingClientRect()
    return {
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      left: group?.left ?? -1,
      right: group?.right ?? 9999,
    }
  })
  expect(box.pageScrolls).toBe(false)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(320)
  await expect(incomeSheet.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
})

for (const theme of THEMES) {
  test(`Money in passes axe in the ${theme} theme: the Ledger rows, Pulse's line and both sheets`, async ({
    page,
  }, testInfo) => {
    const newer = { ...row('n1', '2026-10-17', 25, 'shopee', 'Shopping'), kind: 'refund' }
    await seed(page, {
      theme,
      expenses: [...ROWS, income('i1', '2026-10-16', 790, 'allowance'), newer as SeedExpense],
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(moneyIn(page)).toBeVisible()
    expect.soft(await axeViolations(page), 'Pulse').toEqual([])

    await page.goto('/ledger')
    await waitForApp(page)
    await expect(page.getByRole('button', { name: /^Edit allowance, / })).toBeVisible()
    await expect(
      page.getByRole('button', { name: /^Edit shopee, S\$25\.00 not counted/ }),
    ).toBeVisible()
    expect.soft(await axeViolations(page), 'Ledger').toEqual([])

    await page.getByRole('button', { name: /^Edit allowance, / }).click()
    await expect(dialog(page, 'Edit income')).toBeVisible()
    expect.soft(await axeViolations(page), 'Edit income').toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog(page, 'Edit income')).toHaveCount(0)

    await page.getByRole('button', { name: /^Edit shopee, / }).click()
    await expect(dialog(page, 'Edit entry')).toBeVisible()
    expect.soft(await axeViolations(page), 'Edit entry').toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog(page, 'Edit entry')).toHaveCount(0)

    const sheet = await openAddSheet(page, testInfo)
    await sheet.getByRole('radio', { name: 'Income' }).click()
    await expect(dialog(page, 'Add income')).toBeVisible()
    expect.soft(await axeViolations(page), 'Add income').toEqual([])
  })
}
