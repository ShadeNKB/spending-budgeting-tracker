import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { storedExpenses } from '../support/stored'

// T-003-2 (F-003): the app open twice on one device (two tabs, or a tab beside the installed
// app) shares one storage. 0.9.x wrote whole arrays, so the tab that saved last erased what the
// other had added; 0.10.0 reads, merges and writes on every save and listens to the other tab.
// Port of the auditors' multitab.cjs / b1-two-tabs.cjs probes. Invented data.

test.use({ timezoneId: 'Asia/Singapore' })

const quickAdd = (page: Page) =>
  page.getByRole('textbox', { name: 'Quick add expense' }).filter({ visible: true }).first()

async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/pulse')
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  await expect(quickAdd(page)).toBeVisible({ timeout: 15_000 })
  return page
}

async function add(page: Page, phrase: string) {
  await quickAdd(page).fill(phrase)
  await quickAdd(page).press('Enter')
  await expect(quickAdd(page)).toHaveValue('')
}

const names = async (page: Page) => (await storedExpenses(page)).map((e) => e.itemName).sort()

test.beforeEach(async ({ context }) => {
  // Once per device (localStorage is shared by its tabs): an invented entry from before.
  await context.addInitScript(() => {
    if (localStorage.getItem('e2e:seeded') !== null) return
    localStorage.setItem('e2e:seeded', '1')
    localStorage.setItem(
      'expenses',
      JSON.stringify([
        {
          id: 'seed-1',
          itemName: 'old kopi',
          amount: 1.8,
          category: 'Food & Dining',
          date: '2026-10-01T12:00:00',
          createdAt: '2026-10-01T12:00:00',
        },
      ]),
    )
  })
})

test('adds made in two tabs are all kept, in both tabs and after a reload', async ({ context }) => {
  const one = await openTab(context)
  const two = await openTab(context)

  await add(one, 'tab one coffee 3')
  await add(two, 'tab two lunch 8')
  await add(one, 'tab one taxi 2')

  const all = ['old kopi', 'tab one coffee', 'tab one taxi', 'tab two lunch']
  await expect.poll(() => names(one)).toEqual(all)
  // The other tab took them in as well: its next save cannot drop them.
  await add(two, 'tab two dinner 12')
  await expect.poll(() => names(one)).toEqual([...all, 'tab two dinner'].sort())

  await one.reload()
  await expect(one.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  await one.goto('/ledger?range=all')
  for (const item of ['tab one coffee', 'tab two lunch', 'tab one taxi', 'tab two dinner']) {
    await expect(one.getByRole('button', { name: new RegExp(`^Edit ${item}, `) })).toHaveCount(1)
  }
})

test('a delete in one tab is not undone by a save in the other', async ({ context }) => {
  const one = await openTab(context)
  const two = await openTab(context)
  await add(one, 'to delete 4')
  await expect.poll(() => names(two)).toContain('to delete')

  await one.goto('/ledger?range=all')
  const row = one.getByRole('button', { name: /^Delete to delete, / })
  await row.first().dispatchEvent('click')
  await expect.poll(() => names(one)).not.toContain('to delete')

  // The other tab saves something of its own; the deleted entry stays deleted.
  await add(two, 'tab two tea 2')
  await expect.poll(() => names(one)).toEqual(['old kopi', 'tab two tea'])
  await two.reload()
  await expect(two.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  expect(await names(two)).toEqual(['old kopi', 'tab two tea'])
})
