#!/usr/bin/env node
// The boot-time probe (T9; the ledger's "PR-2's boot cost, accepted" asked for it). Recorded, not
// gated: it prints numbers and never fails on them, and runs in neither `verify` nor CI. Run
// `npm run measure:boot` (it builds first), more than once: one run is one sample.
//
// Method: PR-2's stated setup (no script of it is in the repository, so its numbers are not
// comparable one to one): the production build served by `vite preview`, 2,000 rows, headless
// Chromium with the CPU throttled 4x, the service worker blocked (as in e2e). The
// rows are seeded in the v4 keys and a first load migrates them (a once-per-device cost, left
// out); then
//   - ledger first render: a new tab with the HTTP cache cleared opens /ledger; the time from
//     navigation start until the first Ledger row is in the DOM;
//   - boot blocking time: in that same load, the sum over long tasks of their time past 50 ms,
//     from navigation start until 2 s after that first row (the idle overlays mount then);
//   - warm reload: that tab reloads, cache warm; navigation start to the first Ledger row again.
import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { preview } from 'vite'

const ROWS = 2000
const CPU_SLOWDOWN = 4
const SETTLE_MS = 2000
const port = Number(process.env.BOOT_PORT ?? 4199)
const baseUrl = `http://127.0.0.1:${String(port)}`

if (!existsSync('dist/index.html')) {
  console.error('No production build in dist/: run `npm run build` first.')
  process.exit(1)
}

/** Invented rows over the last 120 days, at local noon as the app stores them. */
function rows() {
  const items = ['kopi', 'chicken rice', 'grab', 'mrt top-up', 'uniqlo tee', 'clinic', 'movie']
  const categories = ['Food & Dining', 'Food & Dining', 'Transportation', 'Transportation']
  const pad = (n) => String(n).padStart(2, '0')
  const out = []
  for (let i = 0; i < ROWS; i++) {
    const at = new Date(Date.now() - (i % 120) * 86_400_000)
    const day = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    const date = `${day}T12:00:00`
    out.push({
      id: `boot${String(i).padStart(5, '0')}`,
      itemName: `${items[i % items.length] ?? 'kopi'} ${String(i)}`,
      amount: 1 + (i % 37) + 0.25,
      category: categories[i % categories.length] ?? 'Other',
      date,
      createdAt: date,
    })
  }
  return out
}

/** In the page, before its scripts: records long tasks and when the first Ledger row appears. */
function probe() {
  const boot = { longTasks: [], firstRow: null }
  window.__boot = boot
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) boot.longTasks.push({ start: e.startTime, ms: e.duration })
  }).observe({ type: 'longtask', buffered: true })
  const seen = new MutationObserver(() => {
    if (document.querySelector('[data-row-main]') === null) return
    boot.firstRow = performance.now()
    seen.disconnect()
  })
  seen.observe(document, { childList: true, subtree: true })
}

/** Waits for the first row, lets the boot settle, and reads what the probe recorded. */
async function readBoot(page) {
  await page.waitForFunction(() => window.__boot?.firstRow !== null, null, { timeout: 120_000 })
  await page.waitForTimeout(SETTLE_MS)
  return page.evaluate((settle) => {
    const { firstRow, longTasks } = window.__boot
    const blocking = longTasks
      .filter((t) => t.start < firstRow + settle)
      .reduce((sum, t) => sum + Math.max(0, t.ms - 50), 0)
    return { firstRow, blocking }
  }, SETTLE_MS)
}

async function throttled(context) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  return { page, cdp }
}

const server = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } })
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })

  // Seed and migrate once, unthrottled: the first boot's one-off migration is not measured.
  const seeding = await context.newPage()
  await seeding.addInitScript((expenses) => {
    if (sessionStorage.getItem('boot-probe-seeded')) return
    sessionStorage.setItem('boot-probe-seeded', '1')
    localStorage.setItem('expenses', JSON.stringify(expenses))
    localStorage.setItem('categoryBudgets', '{}')
    localStorage.setItem('spendtrack:currency', 'SGD')
    localStorage.setItem('spendtrack:theme', 'dark')
  }, rows())
  await seeding.goto(`${baseUrl}/ledger`)
  await seeding.locator('[data-row-main]').first().waitFor({ timeout: 120_000 })
  await seeding.close()

  const { page, cdp } = await throttled(context)
  await page.addInitScript(probe)
  await cdp.send('Network.clearBrowserCache')
  await page.goto(`${baseUrl}/ledger`)
  const cold = await readBoot(page)
  await page.reload()
  const warm = await readBoot(page)

  const line = (label, n) => `${label.padEnd(44)} ${String(Math.round(n)).padStart(6)} ms`
  console.log(
    `boot probe: ${String(ROWS)} rows, ${String(CPU_SLOWDOWN)}x CPU, Chromium, recorded only`,
  )
  console.log(line('ledger first render (cold cache)', cold.firstRow))
  console.log(line(`boot blocking time (to first row + ${String(SETTLE_MS)} ms)`, cold.blocking))
  console.log(line('warm reload to ledger first render', warm.firstRow))
  await context.close()
} finally {
  await browser.close()
  await new Promise((resolve, reject) => {
    server.httpServer.close((err) => (err ? reject(err) : resolve(undefined)))
  })
}
