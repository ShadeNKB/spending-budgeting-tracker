import { test, expect, type Locator, type Page } from '@playwright/test'

// Quick add end to end (AC-19, AC-21, palette half of AC-15/F-020): phrases are typed into the real
// quick-add bar on a Singapore device with a fixed clock, and what reaches storage is checked.
// Invented data only.

const SUN_18_OCT_2026 = new Date('2026-10-18T09:30:00+08:00')
const SAT_2_JAN_2027 = new Date('2027-01-02T20:15:00+08:00')
// Matches CONFIRM_DELAY_MS in src/utils/amountGuard.ts, plus a margin.
const CONFIRM_WAIT_MS = 500

interface StoredExpense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  createdAt: string
}

/** History rows on September days at local noon, newest first as the store keeps them. */
function history(amounts: readonly number[]): StoredExpense[] {
  return amounts.map((amount, i) => {
    const day = String(28 - (i % 28)).padStart(2, '0')
    return {
      id: `history-${String(i)}`,
      itemName: `history ${String(i)}`,
      amount,
      category: 'Other',
      date: `2026-09-${day}T12:00:00`,
      createdAt: `2026-09-${day}T12:00:00`,
    }
  })
}

const repeat = (value: number, times: number) => Array.from({ length: times }, () => value)
// Large-amount bar: max(10 × median, 2 × p95) = max(2,000, 400) = 2,000.
const HIGH_BAR = history(repeat(200, 12))
// Median 5, p95 20: the bar is max(50, 40) = 50.
const MEDIAN_5_P95_20 = history([1, 2, 3, 4, ...repeat(5, 13), 6, 20, 20])

async function seed(page: Page, now: Date, expenses: readonly StoredExpense[]) {
  await page.clock.setFixedTime(now)
  await page.addInitScript((rows) => {
    // Init scripts run on every navigation: seed once so a reload keeps what the test added.
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('expenses', JSON.stringify(rows))
  }, expenses)
}

/** The visible quick-add bar (Pulse on a phone, the top bar on a desktop). */
const quickAdd = (page: Page) => page.getByRole('textbox', { name: 'Quick add expense' })
/** The bar's frame: the input row (with Add) and the pills under it. */
const quickAddFrame = (page: Page) => quickAdd(page).locator('xpath=../..')

async function openPulse(page: Page) {
  await page.goto('/pulse')
  await expect(quickAdd(page)).toBeVisible()
}

const storedExpenses = (page: Page): Promise<StoredExpense[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('expenses') ?? '[]') as StoredExpense[])

/** Waits for the debounced save, then returns the newest `count` rows, oldest first. */
async function newestRows(page: Page, total: number, count: number): Promise<StoredExpense[]> {
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(total)
  return (await storedExpenses(page)).slice(0, count).reverse()
}

/** How the app stores a calendar day: local noon in Singapore, as an ISO instant. */
const singaporeNoon = (day: string) => new Date(`${day}T12:00:00+08:00`).toISOString()

/** A toast on screen (screen readers hear it from a live region of their own). */
const toastText = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text, { exact: true })

async function typeAndAdd(page: Page, phrase: string, toast: string) {
  await quickAdd(page).fill(phrase)
  await quickAdd(page).press('Enter')
  await expect(quickAdd(page)).toHaveValue('')
  await expect(toastText(page, toast)).toBeVisible()
}

interface Case {
  phrase: string
  item: string
  amount: number
  day: string
  toast: string
  category?: string
}

const added = (
  phrase: string,
  item: string,
  amount: number,
  day: string,
  money: string,
  category?: string,
): Case => ({ phrase, item, amount, day, toast: `Added "${item}" · ${money}`, category })

// AC-19 on Sun 18 Oct 2026. "grab 1,200" goes first, while the large-amount bar is 2,000.
const OCT_18_CASES: Case[] = [
  added('grab 1,200', 'grab', 1200, '2026-10-18', 'S$1,200.00'),
  added('junction 8 dinner 15', 'junction 8 dinner', 15, '2026-10-18', 'S$15.00'),
  added('grab novena 12', 'grab novena', 12, '2026-10-18', 'S$12.00'),
  added('decathlon 25', 'decathlon', 25, '2026-10-18', 'S$25.00'),
  added('sephora 30', 'sephora', 30, '2026-10-18', 'S$30.00'),
  added('grab to marina 12', 'grab to marina', 12, '2026-10-18', 'S$12.00'),
  added('wet market 5', 'wet market', 5, '2026-10-18', 'S$5.00'),
  added('kopi 2 novena', 'kopi novena', 2, '2026-10-18', 'S$2.00'),
  added('grab 18 junction 8', 'grab junction 8', 18, '2026-10-18', 'S$18.00'),
  added('mala 2 pax 18', 'mala 2 pax', 18, '2026-10-18', 'S$18.00'),
  added('2 kopi 3.40', '2 kopi', 3.4, '2026-10-18', 'S$3.40'),
  added('S$12 grab', 'grab', 12, '2026-10-18', 'S$12.00'),
  added('shopee 12,50', 'shopee', 12.5, '2026-10-18', 'S$12.50'),
  added('coffee 4.5 sgd', 'coffee', 4.5, '2026-10-18', 'S$4.50'),
  added('lunch 8.5 food', 'lunch', 8.5, '2026-10-18', 'S$8.50', 'Food & Dining'),
  added('netflix 15 monthly', 'netflix', 15, '2026-10-18', 'S$15.00'),
  added('lunch 8.90 2026-05-01', 'lunch', 8.9, '2026-05-01', 'S$8.90 · May 1'),
  added('coffee 4.50 31 dec', 'coffee', 4.5, '2025-12-31', 'S$4.50 · Dec 31, 2025'),
  added('bubble tea 6.5 sat', 'bubble tea', 6.5, '2026-10-17', 'S$6.50 · Oct 17'),
  added('grab last fri 14', 'grab', 14, '2026-10-16', 'S$14.00 · Oct 16'),
]

test.describe('Quick add on a Singapore phone and laptop', () => {
  test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

  test('Singapore phrases keep their places, amounts and dates (Sun 18 Oct 2026)', async ({
    page,
  }) => {
    await seed(page, SUN_18_OCT_2026, HIGH_BAR)
    await openPulse(page)
    const frame = quickAddFrame(page)

    // Pills preview what will be saved, in the selected currency.
    await quickAdd(page).fill('junction 8 dinner 15')
    await expect(frame.getByText('junction 8 dinner', { exact: true })).toBeVisible()
    await expect(frame.getByText('S$15.00', { exact: true })).toBeVisible()
    await quickAdd(page).fill('coffee 4.50 31 dec')
    await expect(frame.getByText('Dec 31, 2025', { exact: true })).toBeVisible()

    for (const c of OCT_18_CASES) await typeAndAdd(page, c.phrase, c.toast)

    const rows = await newestRows(page, HIGH_BAR.length + OCT_18_CASES.length, OCT_18_CASES.length)
    expect(rows.map((r) => ({ item: r.itemName, amount: r.amount, date: r.date }))).toEqual(
      OCT_18_CASES.map((c) => ({ item: c.item, amount: c.amount, date: singaporeNoon(c.day) })),
    )
    // An explicit category word wins; the rest are left to the store's learned suggestions.
    OCT_18_CASES.forEach((c, i) => {
      if (c.category) expect(rows[i]?.category).toBe(c.category)
    })
  })

  test('"31 dec" typed on 2 Jan is last year, with the year in the pill', async ({ page }) => {
    await seed(page, SAT_2_JAN_2027, HIGH_BAR)
    await openPulse(page)

    await quickAdd(page).fill('nye dinner 31 dec 85')
    await expect(quickAddFrame(page).getByText('Dec 31, 2026', { exact: true })).toBeVisible()
    await quickAdd(page).press('Enter')
    await expect(toastText(page, 'Added "nye dinner" · S$85.00 · Dec 31, 2026')).toBeVisible()

    const [row] = await newestRows(page, HIGH_BAR.length + 1, 1)
    expect(row).toMatchObject({
      itemName: 'nye dinner',
      amount: 85,
      date: singaporeNoon('2026-12-31'),
    })
  })

  // The toast clips what spills out of it: a name of one long word used to push Undo and
  // Dismiss outside it, leaving no way to undo that entry on the narrowest phones.
  test('at 320 px a long one-word name wraps in its toast, Undo and Dismiss inside it', async ({
    page,
  }) => {
    const word = 'supercalifragilisticexpialidociouslylongwordwithoutspaces'
    await page.setViewportSize({ width: 320, height: 640 })
    await seed(page, SUN_18_OCT_2026, HIGH_BAR)
    await openPulse(page)
    await quickAdd(page).fill(`${word} 3`)
    await quickAdd(page).press('Enter')
    const toast = page.locator('[data-toast]').filter({ hasText: word })
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible()

    // Layout positions inside the toast (its entrance transform does not change them).
    const outside = await toast.evaluate((box) =>
      [...box.querySelectorAll<HTMLElement>('button, :scope > div')].flatMap((el) =>
        el.offsetLeft < 0 || el.offsetLeft + el.offsetWidth > box.clientWidth
          ? [el.getAttribute('aria-label') ?? el.textContent ?? '']
          : [],
      ),
    )
    expect(outside, 'what lies outside the toast').toEqual([])
    const box = await toast.boundingBox()
    expect(box && box.x + box.width, 'the toast is on screen').toBeLessThanOrEqual(320)
  })

  test('double Enter and a held Enter add one row', async ({ page }) => {
    await seed(page, SUN_18_OCT_2026, HIGH_BAR)
    await openPulse(page)
    const input = quickAdd(page)

    await input.fill('kopi 1.80')
    await input.focus()
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter') // key repeat
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await page.keyboard.press('Enter')

    await input.fill('teh peng 1.60')
    await input.press('Enter')
    await input.press('Enter')

    await quickAdd(page).fill('milo 2.10')
    await quickAddFrame(page).getByRole('button', { name: 'Add', exact: true }).dblclick()

    const rows = await newestRows(page, HIGH_BAR.length + 3, 3)
    expect(rows.map((r) => [r.itemName, r.amount, r.date])).toEqual([
      ['kopi', 1.8, singaporeNoon('2026-10-18')],
      ['teh peng', 1.6, singaporeNoon('2026-10-18')],
      ['milo', 2.1, singaporeNoon('2026-10-18')],
    ])
  })

  test('a large amount needs a second, separate Add; an everyday one adds at once', async ({
    page,
  }) => {
    await seed(page, SUN_18_OCT_2026, MEDIAN_5_P95_20)
    await openPulse(page)
    const input = quickAdd(page)
    const frame = quickAddFrame(page)
    const total = MEDIAN_5_P95_20.length

    await input.fill('groceries 45')
    await input.press('Enter')
    await expect(toastText(page, 'Added "groceries" · S$45.00')).toBeVisible()

    // A quick double Enter: the second press is the tail of the first, not a decision.
    await input.fill('coffee 4500')
    await input.press('Enter')
    await input.press('Enter')
    const confirm = frame.getByRole('button', { name: 'Confirm', exact: true })
    await expect(confirm).toBeVisible()
    await expect(frame.getByText('Large amount — confirm to add')).toBeVisible()
    await expect(input).toHaveValue('coffee 4500')
    expect((await newestRows(page, total + 1, 1))[0]?.itemName).toBe('groceries')

    // Editing the text drops the warning.
    await input.fill('coffee 450')
    await expect(frame.getByRole('button', { name: 'Add', exact: true })).toBeVisible()

    // A held Enter flags once and its key repeats never confirm, however long it is held.
    await input.fill('coffee 4500')
    await page.keyboard.down('Enter')
    await expect(confirm).toBeVisible()
    await page.waitForTimeout(CONFIRM_WAIT_MS)
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(confirm).toBeVisible()

    // A separate press confirms.
    await input.press('Enter')
    await expect(toastText(page, 'Added "coffee" · S$4,500.00')).toBeVisible()

    await input.fill('coffee 99999999')
    await expect(frame.getByText('Amount too large', { exact: true })).toBeVisible()
    const add = frame.getByRole('button', { name: 'Add', exact: true })
    await expect(add).toBeDisabled()
    await input.press('Enter')
    await expect(input).toHaveValue('coffee 99999999')

    const rows = await newestRows(page, total + 2, 2)
    expect(rows.map((r) => [r.itemName, r.amount])).toEqual([
      ['groceries', 45],
      ['coffee', 4500],
    ])
  })
})

test.describe('Command palette quick add', () => {
  test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

  async function openPalette(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    return palette
  }

  test('shows S$ and stores today at local noon', async ({ page }) => {
    await seed(page, SUN_18_OCT_2026, MEDIAN_5_P95_20)
    await openPulse(page)
    const palette = await openPalette(page)

    await palette.getByPlaceholder('Search actions, expenses, or quick-add...').fill('kopi 2.40')
    await expect(palette.getByRole('option', { name: /^Add "kopi" · S\$2\.40/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(toastText(page, 'Added "kopi" · S$2.40')).toBeVisible()
    await expect(palette).toBeHidden()

    const [row] = await newestRows(page, MEDIAN_5_P95_20.length + 1, 1)
    expect(row).toMatchObject({ itemName: 'kopi', amount: 2.4, date: singaporeNoon('2026-10-18') })
  })

  test('asks again for a large amount before adding it', async ({ page }) => {
    await seed(page, SUN_18_OCT_2026, MEDIAN_5_P95_20)
    await openPulse(page)
    const palette = await openPalette(page)
    const search = palette.getByPlaceholder('Search actions, expenses, or quick-add...')

    await search.fill('tv 4500 yesterday')
    await page.keyboard.press('Enter')
    const confirm = palette.getByRole('option', {
      name: /^Confirm large amount: add "tv" · S\$4,500\.00 · Oct 17/,
    })
    await expect(confirm).toBeVisible()
    await page.keyboard.press('Enter') // too soon after the warning: ignored
    await expect(palette).toBeVisible()
    await page.waitForTimeout(CONFIRM_WAIT_MS)
    await page.keyboard.press('Enter')
    await expect(toastText(page, 'Added "tv" · S$4,500.00 · Oct 17')).toBeVisible()
    await expect(palette).toBeHidden()

    const [row] = await newestRows(page, MEDIAN_5_P95_20.length + 1, 1)
    expect(row).toMatchObject({ itemName: 'tv', amount: 4500, date: singaporeNoon('2026-10-17') })
  })
})
