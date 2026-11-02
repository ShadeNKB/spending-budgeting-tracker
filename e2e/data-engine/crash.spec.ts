import { test, expect } from '@playwright/test'
import { storedExpenses } from '../support/stored'

// T-017-2 (F-017): the renderer is killed 200 ms after Enter, with no unload event of any kind,
// as when a phone's OS reclaims a suspended app. 0.9.x saved on a 400 ms debounce and lost the
// entry; 0.10.0 writes it through on the next microtask. The renderer processes are killed from
// outside, as the OS does: CDP Page.crash raised no crash event on Linux CI, and chrome://crash
// missed about one run in four on Windows. A lifecycle mark proves the save did not ride on a
// hide or unload flush. Chromium only (the process list is a Chromium DevTools command). Invented.

const LIFECYCLE_MARK = 'e2e:lifecycle'

test.use({ timezoneId: 'Asia/Singapore' })

test('an entry added 200 ms before the renderer dies is there after a relaunch', async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'SystemInfo.getProcessInfo is a Chromium DevTools command')
  const browser = context.browser()
  if (browser === null) throw new Error('the test context has no browser')
  const page = await context.newPage()
  await page.addInitScript((mark) => {
    const note = (type: string) => () => {
      localStorage.setItem(mark, type)
    }
    window.addEventListener('pagehide', note('pagehide'))
    window.addEventListener('beforeunload', note('beforeunload'))
    document.addEventListener('freeze', note('freeze'))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') localStorage.setItem(mark, 'visibilitychange')
    })
  }, LIFECYCLE_MARK)
  await page.goto('/pulse')
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  const field = page
    .getByRole('textbox', { name: 'Quick add expense' })
    .filter({ visible: true })
    .first()
  await field.fill('crash test kopi 2.2')
  // Only this test's context is open in this worker's browser, so its renderers are this page's
  // (and at most a spare one).
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  const renderers = processInfo.filter((p) => p.type === 'renderer').map((p) => p.id)
  expect(renderers.length).toBeGreaterThan(0)

  await field.press('Enter')
  await page.waitForTimeout(200)
  const crashed = page.waitForEvent('crash', { timeout: 15_000 })
  for (const pid of renderers) process.kill(pid, 'SIGKILL')
  await crashed
  await cdp.detach()

  const relaunched = await context.newPage()
  await relaunched.goto('/ledger?range=all')
  await expect(relaunched.getByText('Loading local spending data')).toHaveCount(0, {
    timeout: 15_000,
  })
  expect(await relaunched.evaluate((mark) => localStorage.getItem(mark), LIFECYCLE_MARK)).toBeNull()
  expect((await storedExpenses(relaunched)).map((e) => e.itemName)).toEqual(['crash test kopi'])
  await expect(relaunched.getByRole('button', { name: /^Edit crash test kopi, / })).toBeVisible()
})
