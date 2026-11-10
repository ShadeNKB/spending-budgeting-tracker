import { test, expect, type Page } from '@playwright/test'
import {
  dialog,
  isPhone,
  manyRows,
  openAddSheet,
  openSettings,
  seed,
  settle,
  waitForApp,
} from './support/a11y'

// T7d: a bottom sheet pulled down by its handle (F-113), one Settings button on a phone (F-111),
// Theme and Currency folded on a phone (F-109), and a bottom sheet as a column from 768 px (F-086).

/**
 * A pull on the open sheet's handle, as pointer events dispatched in the page (WebKit here has
 * no touch input to drive): a press, a move to each offset of `path` (px below the press)
 * `stepMs` apart, a rest of `restMs`, and the release where the last move left off.
 */
async function pull(
  page: Page,
  opts: { path: readonly number[]; stepMs: number; restMs: number },
): Promise<void> {
  await page.evaluate(async ({ path, stepMs, restMs }) => {
    const handle = document.querySelector('[role="dialog"] [data-sheet-handle]')
    if (!handle) throw new Error('no sheet handle')
    const r = handle.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y0 = r.top + r.height / 2
    const pointer = (type: string, y: number, buttons: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: type === 'pointermove' ? -1 : 0,
        buttons,
        clientX: x,
        clientY: y,
      })
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    handle.dispatchEvent(pointer('pointerdown', y0, 1))
    for (const dy of path) {
      await wait(stepMs)
      handle.dispatchEvent(pointer('pointermove', y0 + dy, 1))
    }
    await wait(restMs)
    handle.dispatchEvent(pointer('pointerup', y0 + (path.at(-1) ?? 0), 0))
  }, opts)
}

const panelTop = async (page: Page, name: string) => (await dialog(page, name).boundingBox())?.y

test.describe('A bottom sheet pulled down by its handle (F-113)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'a phone: from 768 px the sheet has no handle')
    await seed(page, { expenses: manyRows(12) })
    await page.goto('/ledger')
    await waitForApp(page)
  })

  test('a long pull closes the Add sheet, and nothing is added', async ({ page }, testInfo) => {
    const sheet = await openAddSheet(page, testInfo)
    await sheet.getByPlaceholder(/coffee, grab, spotify/i).fill('Kopi')
    await settle(page)
    await pull(page, { path: [40, 90, 150, 210], stepMs: 60, restMs: 150 })
    await expect(dialog(page, 'Add expense')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Edit Kopi,/ })).toHaveCount(0)
    await expect(page).toHaveURL(/\/ledger$/)
  })

  test('a short pull springs back: the sheet stays where it was, with what was typed', async ({
    page,
  }, testInfo) => {
    const sheet = await openAddSheet(page, testInfo)
    const what = sheet.getByPlaceholder(/coffee, grab, spotify/i)
    await what.fill('Kopi')
    await settle(page)
    const top = await panelTop(page, 'Add expense')
    await pull(page, { path: [20, 40, 50], stepMs: 80, restMs: 200 })
    await settle(page)
    await expect(sheet).toBeVisible()
    expect(await panelTop(page, 'Add expense')).toBe(top)
    await expect(what).toHaveValue('Kopi')
  })

  test('held, the sheet follows the finger', async ({ page }, testInfo) => {
    const sheet = await openAddSheet(page, testInfo)
    await settle(page)
    const top = (await panelTop(page, 'Add expense')) ?? 0
    // Pressed and moved 70 px, read before the release (a long rest).
    const held = pull(page, { path: [35, 70], stepMs: 60, restMs: 900 })
    await page.waitForTimeout(400)
    const during = (await panelTop(page, 'Add expense')) ?? 0
    expect(Math.round(during - top)).toBe(70)
    await held
    await settle(page)
    await expect(sheet).toBeVisible()
  })

  test('Settings and the Edit sheet close the same way', async ({ page }) => {
    await openSettings(page)
    await settle(page)
    await pull(page, { path: [60, 130, 220], stepMs: 60, restMs: 150 })
    await expect(dialog(page, 'Settings')).toHaveCount(0)

    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /^Edit row 0003,/ }).click()
    await expect(dialog(page, 'Edit expense')).toBeVisible()
    await settle(page)
    await pull(page, { path: [60, 130, 220], stepMs: 60, restMs: 150 })
    await expect(dialog(page, 'Edit expense')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Edit row 0003,/ })).toHaveCount(1)
  })
})

test('On a phone Settings is in the tab bar only (F-111)', async ({ page }, testInfo) => {
  await seed(page)
  await page.goto('/pulse')
  await waitForApp(page)
  const buttons = page.getByRole('button', { name: 'Settings', exact: true })
  await expect(buttons).toHaveCount(1)
  const inTabBar = await buttons.evaluate((el) => el.closest('header') === null)
  expect(inTabBar).toBe(isPhone(testInfo))
  await buttons.click()
  await expect(dialog(page, 'Settings')).toBeVisible()
})

test('On a phone Theme and Currency fold into one Display row (F-109)', async ({
  page,
}, testInfo) => {
  await seed(page, { expenses: manyRows(3) })
  await page.goto('/pulse')
  await waitForApp(page)
  const settings = await openSettings(page, 'Categories')
  const row = settings.getByRole('button', { name: /^Display/ })
  const theme = settings.getByRole('radiogroup', { name: 'Theme' })
  const currency = settings.getByRole('combobox', { name: 'Currency' })
  if (!isPhone(testInfo)) {
    await expect(row).toHaveCount(0)
    await expect(theme).toBeVisible()
    await expect(currency).toBeVisible()
    return
  }
  await expect(row).toContainText('Dark · SGD')
  await expect(theme).toBeHidden()
  // The section starts in the top half of the screen now (it began at 60 % of it).
  const add = await settings.getByRole('textbox', { name: 'Add category' }).boundingBox()
  expect(add?.y ?? Infinity).toBeLessThan((page.viewportSize()?.height ?? 0) * 0.55)

  await row.click()
  await expect(theme).toBeVisible()
  await currency.selectOption('USD')
  await expect(row).toContainText('Dark · USD')
})

test('From 768 px a bottom sheet is a column in the middle, not the whole width (F-086)', async ({
  page,
}, testInfo) => {
  test.skip(isPhone(testInfo), 'a laptop')
  await seed(page)
  await page.goto('/pulse')
  await waitForApp(page)
  const sheet = await openAddSheet(page, testInfo)
  await settle(page)
  const box = await sheet.boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(box?.width).toBe(560)
  expect(Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)).toBe(width / 2)
  // No handle to pull: Close, Escape and the backdrop close it.
  await expect(sheet.locator('[data-sheet-handle]')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(dialog(page, 'Add expense')).toHaveCount(0)
})
