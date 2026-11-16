import { readFile } from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  NOW,
  dialog,
  expectGone,
  openAddSheet,
  openEditSheet,
  openSettings,
  quickAdd,
  storedExpenses,
  waitForApp,
} from './support/a11y'

// One path a real person takes on a fresh profile (F-062), end to end on the build as it ships:
// the welcome card, an expense typed into quick add, a second with a category from the Add
// sheet, an edit, a delete taken back with Undo, a budget, a CSV export, and a reload that finds
// all of it still there. The other specs prove each step's edges; this one proves they hold
// together. Invented data on a fixed Singapore clock, reduced motion.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

const LAZY = { timeout: 15_000 }
const TODAY_CSV = '2026-10-18'

/** A toast on screen, by its text. */
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-toast]').filter({ hasText: text })

/**
 * Presses a control from the keyboard. A press that lands in the instant a toast or a question
 * appears is the tail of the press that raised it and is swallowed (src/ui/pressShield.ts); a
 * click from the keyboard always passes, so no fixed wait is needed before it.
 */
async function activate(page: Page, target: Locator): Promise<void> {
  await target.focus()
  await page.keyboard.press('Enter')
}

async function goToLedger(page: Page): Promise<void> {
  await page
    .getByRole('link', { name: 'Ledger', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await expect(page).toHaveURL(/\/ledger/)
  await waitForApp(page)
}

/** Minimal RFC 4180 reader: quoted cells, doubled quotes, CRLF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += ch
  }
  return rows
}

test('a fresh profile: add, categorise, edit, delete and undo, budget, export, reload', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(NOW)
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })

  // First run: the welcome card sits above Pulse.
  await page.goto('/pulse')
  await waitForApp(page)
  const welcome = page.getByRole('region', { name: 'Welcome to SpendTrack' })
  await expect(welcome).toBeVisible()

  // 1. An expense typed into quick add; the first entry takes the card away.
  await quickAdd(page).fill('kopi 1.80')
  await quickAdd(page).press('Enter')
  await expect(toast(page, 'Added "kopi"')).toBeVisible(LAZY)
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(1)
  await expect(welcome).toHaveCount(0)
  const [kopi] = await storedExpenses(page)
  expect(kopi).toMatchObject({ itemName: 'kopi', amount: 1.8 })
  // Quick add picks the category itself: whatever it chose must survive every step below.
  const kopiCategory = kopi?.category ?? ''
  expect(kopiCategory).not.toBe('')

  // 2. A second from the Add sheet, with a category picked.
  const add = await openAddSheet(page, testInfo)
  await add.getByPlaceholder(/coffee, grab, spotify/i).fill('grab home')
  await add.getByPlaceholder('0.00').fill('12.40')
  const transport = add
    .getByRole('group', { name: /^Category/ })
    .getByRole('button', { name: 'Transportation', exact: true })
  await transport.click()
  await expect(transport).toHaveAttribute('aria-pressed', 'true')
  await add.getByRole('button', { name: 'Add', exact: true }).click()
  await expectGone(dialog(page, 'Add expense'))
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(2)
  expect((await storedExpenses(page)).find((e) => e.itemName === 'grab home')).toMatchObject({
    amount: 12.4,
    category: 'Transportation',
  })

  // 3. Edit the second one's amount in the Ledger.
  await goToLedger(page)
  const edit = await openEditSheet(page, /^Edit grab home,/)
  const amount = edit.getByRole('spinbutton', { name: 'Amount', exact: true })
  await amount.fill('14.20')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expectGone(edit)
  await expect(toast(page, 'Expense updated')).toBeVisible()
  await expect
    .poll(async () => (await storedExpenses(page)).find((e) => e.itemName === 'grab home')?.amount)
    .toBe(14.2)

  // 4. Delete the first one, then take it back with the toast's Undo.
  const doomed = await openEditSheet(page, /^Edit kopi,/)
  await activate(page, doomed.getByRole('button', { name: 'Delete expense' }))
  const question = doomed.getByRole('group', { name: 'Delete "kopi"?' })
  await expect(question).toBeVisible()
  await activate(page, question.getByRole('button', { name: 'Delete', exact: true }))
  await expectGone(doomed)
  await expect
    .poll(async () => (await storedExpenses(page)).map((e) => e.itemName))
    .toEqual(['grab home'])
  await expect(page.getByRole('button', { name: /^Edit kopi,/ })).toHaveCount(0)
  const deleted = toast(page, 'Deleted "kopi"')
  await expect(deleted).toBeVisible()
  await activate(page, deleted.getByRole('button', { name: 'Undo' }))
  await expect
    .poll(async () => (await storedExpenses(page)).map((e) => e.itemName).sort())
    .toEqual(['grab home', 'kopi'])
  await expect(page.getByRole('button', { name: /^Edit kopi,/ })).toBeVisible()

  // 5. A monthly budget for Transportation.
  let settings = await openSettings(page, 'Budgets')
  const cap = settings.getByRole('spinbutton', { name: 'Monthly budget for Transportation' })
  await cap.fill('80')
  await cap.press('Enter')
  await expect(toast(page, 'Transportation: S$80.00 budget set')).toBeVisible()

  // 6. Export CSV from Settings › Backup: a header and the two entries as they stand.
  await settings.getByRole('tab', { name: 'Backup', exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    settings.getByRole('button', { name: 'Export to CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^spendtrack-\d{4}-\d{2}-\d{2}\.csv$/)
  const bytes = await readFile(await download.path())
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const [header, ...rows] = parseCsv(bytes.subarray(3).toString('utf8'))
  expect(header).toEqual(['Date', 'Item', 'Category', 'Amount', 'Notes', 'Type'])
  const byItem = new Map(rows.map((r) => [r[1], r]))
  expect(rows).toHaveLength(2)
  expect(byItem.get('grab home')).toEqual([
    TODAY_CSV,
    'grab home',
    'Transportation',
    '14.2',
    '',
    'expense',
  ])
  expect(byItem.get('kopi')).toEqual([TODAY_CSV, 'kopi', kopiCategory, '1.8', '', 'expense'])
  await page.keyboard.press('Escape')
  await expectGone(dialog(page, 'Settings'))

  // 7. A reload finds everything where it was, and no welcome card.
  await page.reload()
  await waitForApp(page)
  await expect(page.getByRole('button', { name: /^Edit grab home, S\$14\.20,/ })).toBeVisible(LAZY)
  await expect(page.getByRole('button', { name: /^Edit kopi, S\$1\.80,/ })).toBeVisible()
  await expect(welcome).toHaveCount(0)
  expect(
    (await storedExpenses(page)).map((e) => [e.itemName, e.amount, e.category]).sort(),
  ).toEqual([
    ['grab home', 14.2, 'Transportation'],
    ['kopi', 1.8, kopiCategory],
  ])
  settings = await openSettings(page, 'Budgets')
  await expect(
    settings.getByRole('spinbutton', { name: 'Monthly budget for Transportation' }),
  ).toHaveValue('80')
})
