import { test, expect, type Page } from '@playwright/test'
import {
  dialog,
  isPhone,
  manyRows,
  openAddSheet,
  openSettings,
  row,
  seed,
  settle,
  waitForApp,
} from './support/a11y'

// T7c: what only a real browser shows: a sheet standing on the on-screen keyboard (F-071), a
// merge question that the key which raised it does not answer (F-076), the
// Ledger's first rows higher on a phone (F-077), and the Insights link to Other (F-056).

/**
 * Stands in for the browser's visual viewport, as an on-screen keyboard changes it: an iPhone
 * keyboard covers the bottom of the page and leaves the layout viewport whole. Playwright's
 * devices have no keyboard to raise.
 */
async function fakeKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      width: window.innerWidth,
    })
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.assign(window, {
      raiseKeyboard: (px: number) => {
        viewport.height = window.innerHeight - px
        viewport.dispatchEvent(new Event('resize'))
      },
    })
  })
}

const raiseKeyboard = (page: Page, px: number) =>
  page.evaluate((cover) => {
    ;(window as unknown as { raiseKeyboard: (px: number) => void }).raiseKeyboard(cover)
  }, px)

test('The Add sheet stands on the on-screen keyboard, with Add in sight (F-071)', async ({
  page,
}, testInfo) => {
  await seed(page)
  await page.goto('/pulse')
  await waitForApp(page)
  await fakeKeyboard(page)
  const sheet = await openAddSheet(page, testInfo)
  await settle(page)
  const add = sheet.getByRole('button', { name: 'Add', exact: true })
  const before = await add.boundingBox()
  expect(before).not.toBeNull()

  // A keyboard taller than the space under the What field, as on an iPhone 13 (about 334 px).
  const cover = 334
  await raiseKeyboard(page, cover)
  const visibleBottom = await page.evaluate((px) => window.innerHeight - px, cover)
  await expect
    .poll(async () => {
      const box = await add.boundingBox()
      return box === null ? Infinity : box.y + box.height
    })
    .toBeLessThanOrEqual(visibleBottom)
  const panel = await sheet.boundingBox()
  expect(panel?.y ?? -1).toBeGreaterThanOrEqual(0)
  // What stays in sight above the keys, and typing then Add still adds.
  await sheet.getByPlaceholder(/coffee, grab, spotify/i).fill('Kopi')
  await sheet.getByPlaceholder('0.00').fill('1.80')
  await add.click()
  await expect(dialog(page, 'Add expense')).toHaveCount(0)

  // The keyboard goes: a sheet opened then sits on the bottom edge again.
  await raiseKeyboard(page, 0)
  const again = await openAddSheet(page, testInfo)
  await settle(page)
  const box = await again.boundingBox()
  const bottom = await page.evaluate(() => window.innerHeight)
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(bottom)

  // Notes, the last field, takes focus before the keyboard is up: as the sheet gets shorter
  // around it, it stays in sight, above the footer.
  const notes = again.getByRole('textbox', { name: 'Notes (optional)' })
  await notes.focus()
  await raiseKeyboard(page, cover)
  await expect
    .poll(async () => {
      const [field, footer] = await Promise.all([
        notes.boundingBox(),
        again.getByRole('button', { name: 'Add', exact: true }).boundingBox(),
      ])
      if (!field || !footer) return false
      return field.y >= 0 && field.y + field.height <= footer.y
    })
    .toBe(true)
})

test('The Ledger shows its first entry higher on a phone (F-077)', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'a phone layout')
  await seed(page, { expenses: manyRows(40) })
  await page.goto('/ledger')
  await waitForApp(page)
  await settle(page)
  // The range sits under the heading, not on a row of its own.
  const heading = page.getByRole('heading', { level: 1, name: 'Ledger' })
  const range = page.getByText('October 2026', { exact: true })
  const [h, r] = await Promise.all([heading.boundingBox(), range.boundingBox()])
  expect(r?.y ?? 0).toBeGreaterThan(h?.y ?? 0)
  expect((r?.y ?? 0) - ((h?.y ?? 0) + (h?.height ?? 0))).toBeLessThan(8)
  const first = page.locator('main [data-ledger-row]').first()
  const top = (await first.boundingBox())?.y ?? Infinity
  const viewport = page.viewportSize()?.height ?? 0
  testInfo.annotations.push({
    type: 'first row top',
    description: `${String(top)} of ${String(viewport)}`,
  })
  // 0.13.0 put it at 385 px here (the range on its own row, 16 px gaps).
  expect(top).toBeLessThan(366)
})

test('A rename onto a listed category asks before merging, by Return and by a tap elsewhere (F-076)', async ({
  page,
}) => {
  await seed(page, { expenses: [row('g1', '2026-10-17', 89, 'controller', 'Gaming')] })
  await page.goto('/ledger')
  await waitForApp(page)
  const settings = await openSettings(page, 'Categories')
  const field = settings.getByRole('textbox', { name: 'Rename category Gaming' })
  const question = settings.getByText('Merge into Shopping?')

  // Return: the question shows and stays. Its Keep takes focus as it shows, and the browser's
  // own Enter (cancelled) would press it at once, the question gone before it was read.
  await field.fill('Shopping')
  await field.press('Enter')
  const keep = settings.getByRole('button', { name: 'Keep Gaming' })
  await expect(keep).toBeFocused()
  await page.waitForTimeout(500)
  await expect(question).toBeVisible()
  await expect(settings.getByText('1 expense moves to Shopping')).toBeVisible()
  await keep.click()
  await expect(question).toHaveCount(0)
  await expect(field).toHaveValue('Gaming')
  await expect(field).toBeFocused()

  // A tap elsewhere used to merge the two at once: it asks too, and nothing has moved.
  await page.waitForTimeout(600)
  await field.fill('Shopping')
  await settings.getByRole('textbox', { name: 'Add category' }).click()
  await expect(question).toBeVisible()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Merged' })).toHaveCount(0)

  // Confirmed, it merges, says so with an Undo, and focus goes to the row it merged into.
  await page.waitForTimeout(600)
  await settings.getByRole('button', { name: 'Merge Gaming into Shopping' }).click()
  await expect(
    page.locator('[data-toast]').filter({ hasText: 'Merged "Gaming" into "Shopping"' }),
  ).toBeVisible()
  await expect(field).toHaveCount(0)
  await expect(settings.getByRole('textbox', { name: 'Rename category Shopping' })).toBeFocused()
})

test('Insights links "need a category" to those entries in the Ledger (F-056)', async ({
  page,
}) => {
  await seed(page, {
    expenses: [
      ...manyRows(12),
      row('o1', '2026-10-16', 3, 'mystery 1', 'Other'),
      row('o2', '2026-10-15', 4, 'mystery 2', 'Other'),
      row('o3', '2026-10-14', 5, 'mystery 3', 'Other'),
    ],
  })
  await page.goto('/insights')
  await waitForApp(page)
  await page.getByRole('link', { name: 'Review them' }).click()
  await expect(page).toHaveURL(/\/ledger\?range=all&category=Other$/)
  await expect(page.getByRole('combobox', { name: 'Filter by category' })).toHaveValue('Other')
  await expect(page.getByText('mystery 1')).toBeVisible()
})
