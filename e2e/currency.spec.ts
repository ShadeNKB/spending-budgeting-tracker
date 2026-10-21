import { test, expect, type Page } from '@playwright/test'

// Currency end to end (AC-15): the default comes from the device, a stored choice wins, and
// every amount on screen carries the selected symbol. Invented data, fixed clock.

const NOW = new Date('2026-10-18T09:00:00+08:00') // Sun 18 Oct 2026, 09:00 in Singapore
const CURRENCY_KEY = 'spendtrack:currency'

interface SeedExpense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  createdAt: string
}

const ITEMS: readonly [string, string, number][] = [
  ['kopi', 'Food & Dining', 1.8],
  ['chicken rice', 'Food & Dining', 5.5],
  ['grab', 'Transportation', 14.2],
  ['mrt top-up', 'Transportation', 20],
  ['spotify', 'Subscriptions', 10.98],
  ['uniqlo tee', 'Shopping', 29.9],
  ['movie', 'Social & Leisure', 13.5],
]

/** Two rows a day from 1 Sep to 18 Oct 2026, stored at local noon. */
function seedExpenses(): SeedExpense[] {
  const rows: SeedExpense[] = []
  for (let day = 0; day < 48; day++) {
    const key = new Date(Date.UTC(2026, 8, 1 + day)).toISOString().slice(0, 10)
    for (let j = 0; j < 2; j++) {
      const item = ITEMS[(day * 2 + j) % ITEMS.length]
      if (!item) continue
      const [itemName, category, amount] = item
      rows.push({
        id: `seed-${String(day)}-${String(j)}`,
        itemName,
        amount,
        category,
        date: `${key}T12:00:00`,
        createdAt: `${key}T12:00:00`,
      })
    }
  }
  return rows
}

async function seed(page: Page, opts: { currency?: string; expenses?: boolean; now?: Date } = {}) {
  await page.clock.setFixedTime(opts.now ?? NOW)
  await page.addInitScript(
    ({ expenses, currency, key }) => {
      // Init scripts run on every navigation: seed once so reloads keep what the test changed.
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      if (expenses.length > 0) {
        localStorage.setItem('expenses', JSON.stringify(expenses))
        localStorage.setItem('categoryBudgets', JSON.stringify({ 'Food & Dining': 300 }))
      }
      if (currency) localStorage.setItem(key, currency)
    },
    {
      expenses: opts.expenses === false ? [] : seedExpenses(),
      currency: opts.currency ?? null,
      key: CURRENCY_KEY,
    },
  )
}

/** The app has hydrated and the route's loading skeleton is gone. (The sync pill and the toast
 *  region are permanent polite live regions, so waiting for every one of them to detach would
 *  only ever time out.) */
async function waitForApp(page: Page) {
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.locator('main [role="status"][aria-live="polite"]')).toHaveCount(0)
}

const storedCurrency = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), CURRENCY_KEY)

/** Visible text plus aria-labels (chart tooltips and screen-reader totals live there). */
async function moneyText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('[aria-label]'), (el) =>
      el.getAttribute('aria-label'),
    )
    return [document.body.innerText, ...labels].join('\n')
  })
}

/** Amounts written with a bare `$` (S$, A$ and C$ have a letter before the `$`). */
const bareDollars = (text: string) => text.match(/(?<![A-Za-z])\$\s?\d[\d,.]*/g) ?? []

async function openAddSheet(page: Page) {
  const fab = page.getByRole('button', { name: 'Add expense' })
  if (await fab.isVisible()) await fab.click()
  else await page.keyboard.press('Control+n')
  const sheet = page.getByRole('dialog', { name: 'Add expense' })
  await expect(sheet).toBeVisible()
  return sheet
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Settings' })
  await expect(drawer).toBeVisible()
  return drawer
}

test.describe('Currency on a Singapore device', () => {
  test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

  test('a fresh profile defaults to SGD and keeps it across reloads', async ({ page }) => {
    await seed(page, { expenses: false })
    await page.goto('/')
    await waitForApp(page)
    expect(await storedCurrency(page)).toBe('SGD')
    await page.reload()
    await waitForApp(page)
    expect(await storedCurrency(page)).toBe('SGD')
    const drawer = await openSettings(page)
    await expect(drawer.getByLabel('Currency')).toHaveValue('SGD')
    await expect(
      drawer.getByText("Changes the symbol only — amounts aren't converted."),
    ).toBeVisible()
  })

  for (const path of ['/pulse', '/ledger?range=month', '/insights']) {
    test(`every amount on ${path} shows S$`, async ({ page }) => {
      await seed(page)
      await page.goto(path)
      await waitForApp(page)
      const text = await moneyText(page)
      expect(text).toContain('S$')
      expect(bareDollars(text)).toEqual([])
    })
  }

  test('the Add sheet shows S$ and its toasts use the shared wording', async ({ page }) => {
    await seed(page)
    await page.goto('/pulse')
    await waitForApp(page)

    let sheet = await openAddSheet(page)
    await expect(sheet.getByText('S$', { exact: true })).toBeVisible()
    await sheet.getByLabel('What').fill('teh peng')
    await sheet.getByLabel('Amount').fill('1.6')
    await sheet.getByLabel('Amount').press('Enter')
    await expect(page.getByText('Added "teh peng" · S$1.60', { exact: true })).toBeVisible()
    // Wait for the closing sheet to leave, so the next lookup cannot land on it mid-exit.
    await expect(sheet).toBeHidden()

    // The limit shared with quick add is a money surface too.
    sheet = await openAddSheet(page)
    await sheet.getByLabel('What').fill('typo')
    await sheet.getByLabel('Amount').fill('99999999')
    await sheet.getByLabel('Amount').press('Enter')
    await expect(
      sheet.getByText('Amount too large — the limit is S$10,000,000.00', { exact: true }),
    ).toBeVisible()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('expenses'))).not.toContain('typo')

    sheet = await openAddSheet(page)
    await sheet.getByRole('button', { name: 'Yesterday' }).click()
    await sheet.getByLabel('What').fill('grab home')
    await sheet.getByLabel('Amount').fill('12')
    await sheet.getByRole('button', { name: 'Add for Oct 17' }).click()
    await expect(
      page.getByText('Added "grab home" · S$12.00 · Oct 17', { exact: true }),
    ).toBeVisible()
  })

  test('the Edit sheet and the budget inputs show S$', async ({ page }) => {
    await seed(page)
    await page.goto('/ledger?range=all')
    await waitForApp(page)
    await page
      .getByRole('button', { name: /^Edit kopi,/ })
      .first()
      .click()
    const sheet = page.getByRole('dialog', { name: 'Edit expense' })
    await expect(sheet.getByText('S$', { exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toBeHidden()

    const drawer = await openSettings(page)
    await drawer.getByRole('button', { name: 'Budgets' }).click()
    await expect(drawer.getByLabel('Monthly budget for Food & Dining')).toHaveValue('300')
    expect(await drawer.getByText('S$', { exact: true }).count()).toBeGreaterThan(5)
    expect(bareDollars(await drawer.innerText())).toEqual([])
  })

  test('quick add and the command palette show S$', async ({ page }) => {
    await seed(page)
    await page.goto('/pulse')
    await waitForApp(page)
    // Phones get quick add at the top of Pulse; from lg up it lives in the header.
    const quickAdd = page
      .getByRole('textbox', { name: 'Quick add expense' })
      .filter({ visible: true })
      .first()
    await quickAdd.fill('kopi 4.5')
    await expect(page.getByText('S$4.50', { exact: true }).filter({ visible: true })).toHaveCount(1)
    await quickAdd.press('Enter')
    await expect(page.getByText('Added "kopi" · S$4.50', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog')
    await palette.getByRole('combobox').or(palette.getByRole('textbox')).first().fill('coffee 4.50')
    await expect(palette.getByText(/S\$4\.50/)).toBeVisible()
    expect(bareDollars(await palette.innerText())).toEqual([])
  })

  test('switching to JPY updates every surface at once and never changes amounts', async ({
    page,
  }) => {
    await seed(page)
    await page.goto('/pulse')
    await waitForApp(page)
    const before = await page.evaluate(() => localStorage.getItem('expenses'))

    const drawer = await openSettings(page)
    await drawer.getByLabel('Currency').selectOption('JPY')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    expect(await storedCurrency(page)).toBe('JPY')
    await expect(page.getByRole('main')).toContainText('¥')
    const text = await moneyText(page)
    expect(text).not.toMatch(/\$\d/)
    expect(text).not.toMatch(/¥[\d,]+\.\d/)

    const sheet = await openAddSheet(page)
    await expect(sheet.getByText('¥', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    expect(await page.evaluate(() => localStorage.getItem('expenses'))).toBe(before)
  })

  test('a stored USD choice is kept', async ({ page }) => {
    await seed(page, { currency: 'USD' })
    await page.goto('/ledger?range=month')
    await waitForApp(page)
    expect(await storedCurrency(page)).toBe('USD')
    const text = await moneyText(page)
    expect(text).not.toContain('S$')
    expect(bareDollars(text).length).toBeGreaterThan(0)
  })
})

test.describe('Currency on a US device', () => {
  test.use({ timezoneId: 'America/New_York', locale: 'en-US' })

  test('a fresh en-US profile in New York defaults to USD', async ({ page }) => {
    await seed(page, { expenses: false })
    await page.goto('/')
    await waitForApp(page)
    expect(await storedCurrency(page)).toBe('USD')
  })

  test('the Add sheet day presets step calendar days across a DST change', async ({ page }) => {
    // Sun 8 Mar 2026 is 23 hours long in New York: 24 h before 00:30 on the 9th is still the 7th.
    await seed(page, { expenses: false, now: new Date('2026-03-09T00:30:00-04:00') })
    await page.goto('/ledger')
    await waitForApp(page)
    const sheet = await openAddSheet(page)
    await sheet.getByRole('button', { name: 'Yesterday' }).click()
    await expect(sheet.getByText('Logging for Sunday, March 8', { exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Add for Mar 8' })).toBeVisible()
    await sheet.getByRole('button', { name: '3d ago' }).click()
    await expect(sheet.getByRole('button', { name: 'Add for Mar 6' })).toBeVisible()
  })
})
