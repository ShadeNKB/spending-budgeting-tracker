import { test, expect, type Page } from '@playwright/test'

// The screen the app opens on: a lazy screen (/ledger, /insights) is loaded before React starts
// (main.tsx, app/routeScreen.ts), so it shows without the loading skeleton; a chunk that fails
// or stalls ends where a lazy route does. All data here is invented.

const LEDGER_CHUNK = '**/assets/LedgerScreen-*.js'
const AFTER_RELOAD = { timeout: 15_000 }

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('spendtrack:welcome', '1')
  })
})

/** Records whether the route's loading skeleton was ever in the page. */
async function watchSkeleton(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { skeletonSeen: boolean }
    w.skeletonSeen = false
    new MutationObserver(() => {
      const label = document.querySelector('#main [role="status"] .sr-only')
      if (label?.textContent === 'Loading screen') w.skeletonSeen = true
    }).observe(document, { childList: true, subtree: true })
  })
  return () => page.evaluate(() => (window as unknown as { skeletonSeen: boolean }).skeletonSeen)
}

for (const name of ['Ledger', 'Insights']) {
  test(`opening on /${name.toLowerCase()} shows the screen without the loading skeleton`, async ({
    page,
  }) => {
    const skeletonSeen = await watchSkeleton(page)
    await page.goto(`/${name.toLowerCase()}`)
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    expect(await skeletonSeen()).toBe(false)
  })
}

test('opening on a URL that redirects lands on Pulse', async ({ page }) => {
  await page.goto('/ledger/nope')
  await expect(page).toHaveURL(/\/pulse$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('opening on /ledger with a chunk that keeps failing: one reload, then the card in the shell', async ({
  page,
}) => {
  await page.route(LEDGER_CHUNK, (route) => route.abort())
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.goto('/ledger')
  await expect(page.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeVisible(
    AFTER_RELOAD,
  )
  expect(loads).toBe(2)
  await page.waitForTimeout(1500)
  expect(loads).toBe(2)
  await expect(page.locator('header')).toBeVisible()
  await page.getByRole('button', { name: 'Go to Pulse' }).click()
  await expect(page).toHaveURL(/\/pulse$/)
})

test('opening on /ledger with a chunk that never arrives still shows the shell', async ({
  page,
}) => {
  // The request is never answered: React stops waiting for it after BOOT_SCREEN_WAIT_MS (200 ms)
  // and the shell shows with the skeleton, as a lazy route does.
  await page.route(LEDGER_CHUNK, () => undefined)
  // WebKit holds the load event for the pending module request.
  await page.goto('/ledger', { waitUntil: 'commit' })
  await expect(page.locator('header')).toBeVisible({ timeout: 2000 })
  await expect(page.getByText('Loading screen')).toHaveCount(1)
})
