import { test, expect, type Browser, type Page } from '@playwright/test'
import { hasEnvelope, rawStorage, storedExpenses } from '../support/stored'

// F-014: damaged storage never blanks the app or deletes anything. A cut-off envelope comes
// back from the rollback copy and the snapshots, with the recovered banner; a cut-off v4 key
// before the first v5 boot gives up only the row it cut, keeps the original text, and lists
// what it could not read under Needs attention. Invented data.

test.use({ timezoneId: 'Asia/Singapore' })

const LOADING = 'Loading local spending data'

/** `count` invented entries, one a day back from 1 Oct 2026, at local noon. */
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2026, 9, 1 - i)).toISOString().slice(0, 10)
    return {
      id: `row-${String(i).padStart(4, '0')}`,
      itemName: `row ${String(i).padStart(4, '0')}`,
      amount: 1 + (i % 17),
      category: 'Food & Dining',
      date: `${day}T12:00:00`,
      createdAt: `${day}T12:00:00`,
    }
  })
}

/** A fresh device whose storage is exactly `keys` before the first load. */
async function deviceWith(browser: Browser, keys: Record<string, string>): Promise<Page> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    timezoneId: 'Asia/Singapore',
  })
  await context.addInitScript((seed) => {
    if (sessionStorage.getItem('e2e-seeded') !== null) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.clear()
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value)
  }, keys)
  return context.newPage()
}

test('a cut-off envelope is recovered from the rollback copy, with the recovered banner', async ({
  browser,
  baseURL,
}) => {
  // A device that has run 0.10.0: its envelope and its rollback copy are written.
  const first = await deviceWith(browser, { expenses: JSON.stringify(rows(50)) })
  await first.goto(`${baseURL ?? ''}/pulse`)
  await expect(first.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => first.evaluate(() => localStorage.getItem('spendtrack:app'))).toBe('5')
  const saved = await rawStorage(first)
  await first.context().close()
  const envelope = saved['st5:db'] ?? ''
  expect(envelope.startsWith('5|')).toBe(true)

  // The same storage with the envelope cut 37 characters short, as a torn write leaves it.
  const page = await deviceWith(browser, { ...saved, 'st5:db': envelope.slice(0, -37) })
  await page.goto(`${baseURL ?? ''}/pulse`)
  await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
  // The banner (a screen reader also hears it once, from the announcer).
  const banner = page.getByRole('region', { name: 'Data recovered' })
  await expect(banner).toHaveText(
    /We couldn't read part of your saved data\. We recovered 50 entries from backup copies\./,
  )
  await expect(banner.getByRole('button', { name: 'Download damaged data' })).toBeVisible()
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(50)
  // The damaged text is kept, never deleted.
  const after = await rawStorage(page)
  expect(Object.values(after)).toContain(envelope.slice(0, -37))
  await page.context().close()
})

test('a cut-off v4 key before the first v5 boot gives up only its last row (299 of 300)', async ({
  browser,
  baseURL,
}) => {
  const text = JSON.stringify(rows(300))
  const cut = text.slice(0, -37)
  const page = await deviceWith(browser, { expenses: cut })
  await page.goto(`${baseURL ?? ''}/ledger?range=all`)
  await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
  // The upgrade has run once its envelope is there: until then the cut v4 key is what is stored
  // (a loaded phone can be read before the app has even shown its loading state).
  await expect.poll(() => hasEnvelope(page), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(299)
  await expect(page.getByText('299 entries', { exact: true })).toBeVisible()

  // The original text is kept byte for byte, and the damage is listed for the owner.
  const after = await rawStorage(page)
  const copies = Object.entries(after).filter(([key]) => key.startsWith('st5:q:expenses:'))
  expect(copies.map(([, value]) => value)).toEqual([cut])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Backup', exact: true }).click()
  await expect(sheet.getByRole('region', { name: 'Needs attention' })).toBeVisible()
  await page.context().close()
})

// walk5: an unreadable envelope with no room for its safety copy runs in memory only. Each add
// used to say "Added … · Undo" with a tick, beside a red toast to "clear old data", and was gone
// after the next reload. Now the strip says new entries are not kept, an add says so too, and
// the quota advice stays away.
test('memory only: the strip and every add say that new entries are not kept', async ({
  browser,
  baseURL,
}) => {
  const page = await deviceWith(browser, {
    expenses: JSON.stringify(rows(5)),
    'st5:db': '5|0000000|{"f":1,"doc":this envelope was cut',
  })
  // storage refuses every SpendTrack write from the first load: no room for the safety copy
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key.startsWith('st5:')) throw new DOMException('full', 'QuotaExceededError')
      write.call(this, key, value)
    }
  })
  await page.goto(`${baseURL ?? ''}/pulse`)
  await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole('region', { name: 'Saved data unreadable' })).toContainText(
    "New entries won't be kept after you close SpendTrack: download your raw data first.",
  )
  const input = page
    .getByRole('textbox', { name: /quick add/i })
    .filter({ visible: true })
    .first()
  await input.fill('memory kopi 1.80')
  await input.press('Enter')
  const toasts = page.getByRole('region', { name: 'Notifications' })
  await expect(
    toasts.getByText('Added "memory kopi" · S$1.80 · Kept only until you close SpendTrack'),
  ).toBeVisible()
  await expect(toasts.getByText(/clear old data/)).toHaveCount(0)
  await page.context().close()
})
