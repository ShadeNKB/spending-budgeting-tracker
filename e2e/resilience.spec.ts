import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'

// Runtime resilience: stale-chunk recovery, the in-shell error card with the raw rescue
// download, the ?add=1 shortcut, overlays kept off the first-paint path, and iOS safe areas.
// All data here is invented.

const GUARD_KEY = 'spendtrack:chunk-reload-at'
// What follows the failure includes a full page reload, which is slow on a busy machine.
const AFTER_RELOAD = { timeout: 15_000 }
const LEDGER_CHUNK = '**/assets/LedgerScreen-*.js'

// Trailing comma: storage repairs it in memory on hydrate but leaves the stored text alone,
// so the rescue file must carry it byte for byte. Dated `day` at local noon, as the app
// stores dates.
const rawExpenses = (day: string) =>
  `[{"id":"e2e-1","itemName":"Kopi O","amount":1.8,"category":"Food","date":"${day}T12:00:00","createdAt":"${day}T12:00:00"},]`
const RAW_UNKNOWN = '{"broken": [1, 2,'
const SYNC_ID = 'e2e-sync-code-must-not-leak'

/**
 * Seeds the invented raw data once per test and returns the stored expenses text. The
 * expense is dated today on the browser's own clock (read on about:blank before the app
 * loads), because Pulse lists names only in its Today strip; a fixed date stops matching
 * the day after it was written.
 */
async function seedRawData(page: Page): Promise<string> {
  const today = await page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })
  const expenses = rawExpenses(today)
  await page.addInitScript(
    (seed) => {
      if (localStorage.getItem('spendtrack:e2e-unknown') !== null) return
      localStorage.setItem('expenses', seed.expenses)
      localStorage.setItem('spendtrack:e2e-unknown', seed.unknown)
      localStorage.setItem('syncId', seed.syncId)
    },
    { expenses, unknown: RAW_UNKNOWN, syncId: SYNC_ID },
  )
  return expenses
}

async function waitForApp(page: Page) {
  await page.waitForLoadState('load')
  await expect(page.getByText('Loading local spending data')).toHaveCount(0)
}

function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

async function tapTab(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).filter({ visible: true }).first().click()
}

test.describe('stale chunk after a deploy', () => {
  test('reloads exactly once, then the screen renders', async ({ page, browserName }) => {
    // WebKit keeps a module URL that failed in a tab failed for the life of that tab, across
    // reloads (measured with a real server: location.reload/replace/assign and a user reload
    // never re-request it; a new tab does). A real deploy changes the chunk URL, so the reload
    // still recovers there; this test can only fake a same-URL hiccup. WebKit's one reload and
    // its error card are covered by the next test.
    test.skip(
      browserName === 'webkit',
      'WebKit never re-requests a module URL that failed in this tab',
    )
    let aborted = 0
    await page.route(LEDGER_CHUNK, async (route) => {
      if (aborted === 0) {
        aborted += 1
        await route.abort()
      } else {
        await route.continue()
      }
    })
    const loads = countLoads(page)
    await page.goto('/pulse')
    await waitForApp(page)
    expect(loads()).toBe(1)

    await tapTab(page, 'Ledger')
    await expect(page.getByRole('heading', { name: 'Ledger', level: 1 })).toBeVisible(AFTER_RELOAD)
    await expect(page).toHaveURL(/\/ledger$/)
    expect(aborted).toBe(1)
    expect(loads()).toBe(2)
    const guard = await page.evaluate((key) => sessionStorage.getItem(key), GUARD_KEY)
    expect(Number(guard)).toBeGreaterThan(0)
    await expect(page.getByText(/something went wrong|just updated/i)).toHaveCount(0)
  })

  test('a chunk that keeps failing shows the error card inside the shell, with recovery', async ({
    page,
  }) => {
    await seedRawData(page)
    await page.route(LEDGER_CHUNK, (route) => route.abort())
    const loads = countLoads(page)
    await page.goto('/pulse')
    await waitForApp(page)

    await tapTab(page, 'Ledger')
    const heading = page.getByRole('heading', { name: 'SpendTrack was just updated' })
    await expect(heading).toBeVisible(AFTER_RELOAD)
    await expect(heading).toBeFocused()
    expect(loads()).toBe(2)
    // No reload loop: the guard holds for 60 s.
    await page.waitForTimeout(1500)
    expect(loads()).toBe(2)

    // The shell survives: header and navigation still work.
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Insights', exact: true }).filter({ visible: true }),
    ).toHaveCount(1)
    await expect(page.getByText(/Hey developer|Unexpected Application Error/)).toHaveCount(0)

    // Go to Pulse recovers inside the app (no reload).
    await page.getByRole('button', { name: 'Go to Pulse' }).click()
    await expect(page).toHaveURL(/\/pulse$/)
    await expect(heading).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
    await expect(page.getByText('Kopi O').first()).toBeVisible()
    await expect(
      page.getByRole('textbox', { name: 'Quick add expense' }).filter({ visible: true }).first(),
    ).toBeVisible()
    expect(loads()).toBe(2)
  })

  // Without service-worker coverage a reload offline opens the browser's offline page, a dead
  // end in an installed app: no automatic reload, and the card says to reconnect first.
  test('offline, a screen that never loaded says to reconnect and never reloads', async ({
    page,
    context,
  }) => {
    const loads = countLoads(page)
    await page.goto('/pulse')
    await waitForApp(page)
    await context.setOffline(true)

    await tapTab(page, 'Ledger')
    const heading = page.getByRole('heading', { name: "You're offline" })
    await expect(heading).toBeVisible()
    await expect(
      page.getByText("This part of SpendTrack isn't saved on this device yet.", { exact: false }),
    ).toBeVisible()
    await expect(page.getByText(/just updated/)).toHaveCount(0)
    await page.waitForTimeout(1000)
    expect(loads()).toBe(1)

    // Back online, the card says what Reload will now fix.
    await context.setOffline(false)
    await expect(page.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeVisible()
  })

  test('Download my data on the error card saves every raw value, without the sync code', async ({
    page,
  }) => {
    const storedExpenses = await seedRawData(page)
    await page.route(LEDGER_CHUNK, (route) => route.abort())
    await page.goto('/pulse')
    await waitForApp(page)
    await tapTab(page, 'Ledger')
    await expect(page.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeVisible(
      AFTER_RELOAD,
    )

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download my data' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(
      /^spendtrack-backup-raw-\d{4}-\d{2}-\d{2}-\d{4}\.json$/,
    )
    const path = await download.path()
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(SYNC_ID)
    const file = JSON.parse(text) as { kind: string; keys: Record<string, string> }
    expect(file.kind).toBe('raw-browser-backup')
    expect(file.keys.expenses).toBe(storedExpenses)
    expect(file.keys['spendtrack:e2e-unknown']).toBe(RAW_UNKNOWN)
    expect(Object.keys(file.keys)).not.toContain('syncId')
    await expect(
      page.getByText(`Saving ${download.suggestedFilename()}… Check your Downloads.`),
    ).toBeVisible()
  })
})

test.describe('Add expense shortcut', () => {
  test('/pulse?add=1 opens the add sheet once and cleans the URL', async ({ page }) => {
    await page.goto('/pulse?add=1')
    const sheet = page.getByRole('dialog', { name: 'Add expense' })
    const what = sheet.getByPlaceholder(/coffee, grab, spotify/i)
    await expect(what).toBeVisible()
    // Ready to type, exactly as when it is opened with the + button.
    await expect(what).toBeFocused()
    await expect(page).toHaveURL(/\/pulse$/)

    await page.keyboard.press('Escape')
    await expect(what).toHaveCount(0)
    await page.waitForTimeout(800)
    await expect(what).toHaveCount(0)

    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await expect(what).toHaveCount(0)
  })
})

// usePresence: the overlays' shared runtime (presence, motion helpers, press shield).
const OVERLAY_CHUNKS = [
  'usePresence',
  'SettingsDrawer',
  'CommandPalette',
  'AddExpenseSheet',
  'ToastHost',
  'HotkeyHints',
]

const OVERLAY_CHUNK =
  /\/assets\/(usePresence|SettingsDrawer|CommandPalette|AddExpenseSheet|ToastHost|HotkeyHints|Sheet|DatePicker)-[\w-]+\.js$/

/** Overlay chunks requested so far, by name (hash stripped). */
async function overlayChunksRequested(page: Page): Promise<string[]> {
  const names = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name),
  )
  return names
    .filter((name) => OVERLAY_CHUNK.test(name))
    .map((name) => name.replace(/^.*\/assets\//, '').replace(/-[\w-]{8}\.js$/, ''))
}

// Service workers are blocked in this suite, which is the private-mode / unsupported path of
// the update controller: it must stay silent, with no uncaught error or unhandled rejection
// (WebKit resolves register() with nothing usable there).
test('boot and every screen raise no page errors with service workers blocked', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const path of ['/pulse', '/ledger', '/insights']) {
    await page.goto(path)
    await waitForApp(page)
    await page.waitForTimeout(500)
  }
  expect(errors).toEqual([])
})

test.describe('first paint', () => {
  test('cold /pulse loads no overlay or motion code until idle or a tap', async ({ page }) => {
    // The app never goes idle here, so anything that loads was pulled in by boot itself (a
    // lazy component rendered at mount), or by the taps below.
    await page.addInitScript(() => {
      window.requestIdleCallback = () => 0
      window.cancelIdleCallback = () => undefined
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await page.waitForTimeout(3000)
    expect(await overlayChunksRequested(page)).toEqual([])

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible()
    expect(await overlayChunksRequested(page)).toEqual(
      expect.arrayContaining(['CommandPalette', 'usePresence']),
    )
    expect(await overlayChunksRequested(page)).not.toContain('AddExpenseSheet')
    await page.keyboard.press('Escape')

    // The quick add's own full-entry sheet loads on its first tap.
    await page.getByRole('button', { name: 'Full entry form' }).filter({ visible: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add expense' })).toBeVisible()
    expect(await overlayChunksRequested(page)).toContain('AddExpenseSheet')
  })

  test('the overlays still arrive once the app is idle, after window load', async ({ page }) => {
    await page.addInitScript(() => {
      addEventListener('load', () => {
        document.documentElement.dataset.e2eLoadAt = String(performance.now())
      })
    })
    await page.goto('/pulse')
    await waitForApp(page)

    await page.waitForFunction(
      (names) =>
        names.every((name) =>
          performance.getEntriesByType('resource').some((e) => e.name.includes(`/assets/${name}-`)),
        ),
      OVERLAY_CHUNKS,
      { timeout: 10_000 },
    )
    const { loadAt, resources } = await page.evaluate(() => ({
      loadAt: Number(document.documentElement.dataset.e2eLoadAt),
      resources: performance
        .getEntriesByType('resource')
        .map((e) => ({ name: e.name, start: e.startTime })),
    }))
    expect(loadAt).toBeGreaterThan(0)
    const late = resources.filter((r) => OVERLAY_CHUNK.test(r.name))
    expect(late.filter((r) => r.start < loadAt)).toEqual([])
  })
})

test.describe('a failed add-sheet chunk', () => {
  // SmartInput (header + Pulse) has its own full-entry sheet. It must never take the shell
  // down: nothing shows until the sheet is wanted, and then only the panel recovery card.
  for (const width of [375, 1280]) {
    test(`keeps the shell and stays silent until the sheet is opened (${String(width)} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.route('**/assets/AddExpenseSheet-*.js', (route) => route.abort())
      const loads = countLoads(page)
      await page.goto('/pulse')
      await waitForApp(page)
      // The idle-mounted shell sheet fails first: one automatic reload, then quiet.
      await expect.poll(loads, { timeout: 15_000 }).toBe(2)
      await waitForApp(page)
      await page.waitForTimeout(3000)
      expect(loads()).toBe(2)

      const errorCopy = /something went wrong|just updated|couldn't open|ran into a problem/i
      await expect(page.getByText(errorCopy)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
      await expect(
        page.getByRole('link', { name: 'Insights', exact: true }).filter({ visible: true }),
      ).toHaveCount(1)
      const quickAdd = page
        .getByRole('textbox', { name: 'Quick add expense' })
        .filter({ visible: true })
      await expect(quickAdd).toHaveCount(1)

      await page.getByRole('button', { name: 'Full entry form' }).filter({ visible: true }).click()
      // The app's own live regions are alerts too, empty until something is announced.
      const card = page.getByRole('alert').filter({ hasText: /./ })
      await expect(card).toHaveText(
        "This panel couldn't open because a new version was just released.",
      )
      await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(card).toHaveCount(0)
      await expect(quickAdd).toHaveCount(1)
      await expect(page.getByText(errorCopy)).toHaveCount(0)
      expect(loads()).toBe(2)
    })
  }
})

test.describe('overlays opened before the idle mount', () => {
  // Phone width in both projects: SettingsDrawer picks a bottom sheet in a mount effect, so a
  // Settings tap right after load used to slide a side sheet in and leave it off-screen.
  test.use({ viewport: { width: 390, height: 844 } })

  test('Settings tapped right after load opens fully on screen as a bottom sheet', async ({
    page,
  }) => {
    await page.goto('/pulse')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Settings' })
    await expect(sheet).toBeVisible()
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox()
        return box && { x: Math.round(box.x), bottom: Math.round(box.y + box.height) }
      })
      .toEqual({ x: 0, bottom: 844 })
    await page.getByRole('tab', { name: 'Backup', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Export to CSV' })).toBeVisible()
  })
})

test.describe('iOS safe area (Chromium CDP inset override)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'needs the Chromium DevTools Protocol')

  async function overrideInsets(
    page: Page,
    insets: { top?: number; left?: number; right?: number },
  ) {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets })
    } catch {
      test.skip(true, 'this Chromium has no Emulation.setSafeAreaInsetsOverride')
    }
  }

  async function cssInset(page: Page, side: 'top' | 'left' | 'right'): Promise<string> {
    return page.evaluate((s) => {
      const probe = document.createElement('div')
      probe.style.paddingTop = `env(safe-area-inset-${s})`
      document.body.append(probe)
      const value = getComputedStyle(probe).paddingTop
      probe.remove()
      return value
    }, side)
  }

  test('portrait: the header content starts below a 47 px status bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await overrideInsets(page, { top: 47 })
    await page.goto('/pulse')
    await waitForApp(page)
    expect(await cssInset(page, 'top')).toBe('47px')

    const header = page.locator('header')
    const targets = [
      header.getByRole('link', { name: 'SpendTrack' }),
      header.getByRole('button', { name: 'Search', exact: true }),
      header.getByRole('button', { name: 'Settings' }),
    ]
    for (const target of targets) {
      const box = await target.boundingBox()
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(47)
    }
    // The header background still reaches the top edge behind the status bar.
    expect((await header.boundingBox())?.y).toBe(0)
  })

  test('landscape: header and content clear 47 px side notches', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await overrideInsets(page, { left: 47, right: 47 })
    await page.goto('/pulse')
    await waitForApp(page)
    expect(await cssInset(page, 'left')).toBe('47px')

    const header = page.locator('header')
    const logo = await header.getByRole('link', { name: 'SpendTrack' }).boundingBox()
    const settings = await header.getByRole('button', { name: 'Settings' }).boundingBox()
    expect(logo?.x ?? -1).toBeGreaterThanOrEqual(47)
    expect((settings?.x ?? 9999) + (settings?.width ?? 0)).toBeLessThanOrEqual(844 - 47)

    const content = await page.locator('main > :not(.sr-only)').first().boundingBox()
    expect(content?.x ?? -1).toBeGreaterThanOrEqual(47)
    expect((content?.x ?? 9999) + (content?.width ?? 0)).toBeLessThanOrEqual(844 - 47)
  })

  test('landscape: sheets keep their fields and Close clear of the side notches', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await overrideInsets(page, { left: 47, right: 47 })
    await page.goto('/pulse')
    await waitForApp(page)
    const clear = async (where: string, box: { x: number; width: number } | null) => {
      expect(box, where).not.toBeNull()
      expect(box?.x ?? -1, where).toBeGreaterThanOrEqual(47)
      expect((box?.x ?? 9999) + (box?.width ?? 0), where).toBeLessThanOrEqual(844 - 47)
    }

    // The add sheet spans the full width from the bottom.
    await page
      .getByRole('button', { name: 'Full entry form' })
      .filter({ visible: true })
      .first()
      .click()
    const add = page.getByRole('dialog', { name: 'Add expense' })
    await expect(add).toBeVisible()
    await page.waitForTimeout(600)
    await clear('add: Close', await add.getByRole('button', { name: 'Close' }).boundingBox())
    await clear('add: What', await add.getByPlaceholder(/coffee, grab, spotify/i).boundingBox())
    await page.keyboard.press('Escape')
    await expect(add).toHaveCount(0)

    // Settings slides in from the right edge.
    await page.locator('header').getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog')
    await expect(settings).toBeVisible()
    await page.waitForTimeout(600)
    await clear(
      'settings: Close',
      await settings.getByRole('button', { name: 'Close' }).boundingBox(),
    )
  })
})
