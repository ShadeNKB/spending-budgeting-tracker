import { test, expect } from '@playwright/test'
import { storedExpenses } from '../support/stored'

// T-017-2 (F-017): the renderer is killed (CDP Page.crash: no unload event of any kind, as when
// a phone's OS reclaims a suspended app) 200 ms after Enter. 0.9.x saved on a 400 ms debounce and
// lost the entry; 0.10.0 writes it through on the next microtask. Chromium only (CDP). Invented.

test.use({ timezoneId: 'Asia/Singapore' })

test('an entry added 200 ms before the renderer dies is there after a relaunch', async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Page.crash is a Chromium DevTools command')
  const page = await context.newPage()
  await page.goto('/pulse')
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  const field = page
    .getByRole('textbox', { name: 'Quick add expense' })
    .filter({ visible: true })
    .first()
  await field.fill('crash test kopi 2.2')

  const cdp = await context.newCDPSession(page)
  await field.press('Enter')
  await page.waitForTimeout(200)
  // Listening before the command: it does not answer (the page is gone) and the event may come
  // first.
  const crashed = page.waitForEvent('crash', { timeout: 15_000 })
  void cdp.send('Page.crash').catch(() => undefined)
  await crashed

  const relaunched = await context.newPage()
  await relaunched.goto('/ledger?range=all')
  await expect(relaunched.getByText('Loading local spending data')).toHaveCount(0, {
    timeout: 15_000,
  })
  expect((await storedExpenses(relaunched)).map((e) => e.itemName)).toEqual(['crash test kopi'])
  await expect(relaunched.getByRole('button', { name: /^Edit crash test kopi, / })).toBeVisible()
})
