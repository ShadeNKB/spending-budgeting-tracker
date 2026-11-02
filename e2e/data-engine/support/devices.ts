// Devices for the data-engine release gate: one browser context per device, each on its own
// origin (so its own localStorage), all on one sync code through the fake relay.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { BuildToServe } from './relayServer'

const CACHE = resolve(
  process.env.ST5_E2E_CACHE ?? join(process.cwd(), 'node_modules/.cache/st5-e2e'),
)

export const PORTS = {
  relay: 4219,
  candidateA: 4220,
  candidateB: 4221,
  v092: 4222,
  rollback: 4223,
} as const
/** One invented sync code for the suite. */
export const SYNC_CODE = '5e5e5e5e-0e2e-4e2e-8e2e-000000000092'

/** A build made by scripts/build-mixed.mjs. */
export function build(name: 'candidate' | 'v092'): BuildToServe {
  const dir = join(CACHE, name)
  try {
    return { dir, csp: readFileSync(join(CACHE, `${name}.csp`), 'utf8') }
  } catch {
    throw new Error(`No ${name} build in ${CACHE}: run node scripts/build-mixed.mjs first.`)
  }
}

export interface Device {
  readonly context: BrowserContext
  readonly page: Page
  readonly origin: string
}

/**
 * A device on `origin`. Its storage is seeded once (before the first load) with `seed` keys,
 * and the sync code unless `syncCode` is null; a reload keeps what the device wrote since.
 */
export async function openDevice(
  browser: Browser,
  origin: string,
  opts: { syncCode?: string | null; seed?: Record<string, string>; path?: string } = {},
): Promise<Device> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    timezoneId: 'Asia/Singapore',
  })
  const keys: Record<string, string> = { ...opts.seed }
  const code = opts.syncCode === undefined ? SYNC_CODE : opts.syncCode
  if (code !== null) keys.syncId = code
  await context.addInitScript((seed) => {
    if (localStorage.getItem('e2e:seeded') !== null) return
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
    localStorage.setItem('e2e:seeded', '1')
  }, keys)
  const page = await context.newPage()
  await page.goto(`${origin}${opts.path ?? '/ledger'}`)
  await waitForApp(page)
  return { context, page, origin }
}

/**
 * The device being used is the one in front, as in a person's hand. Headless Chromium can hold
 * the animation frames of a page that is not in front, so a sheet's exit fade there may wait for
 * seconds; real devices in use do not.
 */
async function inHand(page: Page): Promise<void> {
  await page.bringToFront()
}

export async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('load')
  await expect(page.getByText('Loading local spending data')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Quick add expense' }).first()).toBeVisible()
}

/** Adds through the real quick-add bar and waits for its toast. */
export async function quickAdd(page: Page, phrase: string): Promise<void> {
  await inHand(page)
  const field = page.getByRole('textbox', { name: 'Quick add expense' }).first()
  await field.fill(phrase)
  await field.press('Enter')
  await expect(field).toHaveValue('')
}

interface StoredRow {
  readonly id: string
  readonly itemName: string
  readonly amount: number
  readonly category: string
  readonly date: string
}

/**
 * The live entries a device holds, from what it stored: the v5 envelope (`st5:db`) when there
 * is one, else the v4 `expenses` key (0.9.2). Sorted by id.
 */
export async function storedRows(page: Page): Promise<StoredRow[]> {
  const rows = await page.evaluate(() => {
    const envelope = localStorage.getItem('st5:db')
    if (envelope !== null) {
      const body: unknown = JSON.parse(envelope.slice(envelope.indexOf('|', 2) + 1))
      if (typeof body === 'object' && body !== null && 'doc' in body) {
        const doc: unknown = body.doc
        if (typeof doc === 'object' && doc !== null && 'expenses' in doc) return doc.expenses
      }
      return []
    }
    return JSON.parse(localStorage.getItem('expenses') ?? '[]') as unknown
  })
  const list = Array.isArray(rows) ? rows : []
  return list
    .filter(
      (r): r is StoredRow =>
        typeof r === 'object' && r !== null && 'id' in r && typeof r.id === 'string',
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The item names a device holds, sorted. */
export async function itemNames(page: Page): Promise<string[]> {
  return (await storedRows(page)).map((r) => r.itemName).sort()
}

export async function closeAll(devices: readonly (Device | undefined)[]): Promise<void> {
  for (const d of devices) await d?.context.close()
}

// ─── Actions both builds offer under the same names (0.9.2 and 0.10.0) ──────────────────────

/** Settings, on one of its tabs. */
export async function openSettingsTab(page: Page, tab: 'Budgets' | 'Backup' | 'Sync') {
  await inHand(page)
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  if (!(await sheet.isVisible()))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // 0.9.3 made the sections a tablist; 0.9.2 has plain buttons of the same names.
  await sheet
    .getByRole('tab', { name: tab, exact: true })
    .or(sheet.getByRole('button', { name: tab, exact: true }))
    .click()
  return sheet
}

export async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
}

/**
 * The Ledger, every entry listed, searched for `item` when given: both builds list a long history
 * virtually, so an older row is only in the page once a search brings it into view.
 */
export async function openLedger(page: Page, item?: string) {
  await inHand(page)
  if (!page.url().includes('/ledger'))
    await page.goto(new URL('/ledger?range=all', page.url()).href)
  await expect(page.getByText('Loading local spending data')).toHaveCount(0)
  if (item !== undefined) await page.getByLabel('Search expenses', { exact: true }).fill(item)
}

/**
 * Deletes an entry from its Ledger row. Both builds name the button "Delete <item>…"; it shows
 * on hover or a swipe, so it is pressed directly.
 */
export async function deleteEntry(page: Page, item: string) {
  await openLedger(page, item)
  const button = page.getByRole('button', { name: new RegExp(`^Delete ${item}(,|$)`) }).first()
  await expect(button).toBeAttached()
  await button.dispatchEvent('click')
}

/** Changes an entry's amount in the Edit sheet. */
export async function editAmount(page: Page, item: string, amount: string) {
  await openLedger(page, item)
  await page
    .getByRole('button', { name: new RegExp(`^Edit ${item}, `) })
    .first()
    .click()
  const sheet = page.getByRole('dialog', { name: 'Edit expense' })
  await sheet.getByLabel('Amount', { exact: true }).fill(amount)
  await sheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(sheet).toHaveCount(0)
}

/** Presses Undo on the newest toast that offers it. */
export async function undoLast(page: Page) {
  await inHand(page)
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).last()
  await expect(undo).toBeVisible()
  // A person reads the toast before pressing it. A press within a double tap's time of the toast
  // appearing counts as part of the gesture that made it, and the press shield (T6) drops it.
  await page.waitForTimeout(600)
  await undo.click()
}

/** Sets a category's monthly budget in Settings › Budgets. */
export async function setBudget(page: Page, category: string, amount: string) {
  const sheet = await openSettingsTab(page, 'Budgets')
  const field = sheet.getByRole('spinbutton', { name: `Monthly budget for ${category}` })
  await field.fill(amount)
  await field.press('Enter')
  await closeSettings(page)
}
