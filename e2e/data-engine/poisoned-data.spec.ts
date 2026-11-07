import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { storedExpenses } from '../support/stored'

// T-005-3 (F-005): one bad record, from a file or from storage, never takes the app down.
// Rows that cannot be read are kept aside (Needs attention, downloadable) and everything else
// works; when even the data engine cannot load, the shell still offers the raw data.
// Invented data only.

// A pristine origin shows the first-run card above every screen (PR-4); these tests start past
// it, as after Start fresh. e2e/first-run.spec.ts covers the card itself.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('spendtrack:welcome', '1')
  })
})

test.use({ timezoneId: 'Asia/Singapore' })

const LOADING = 'Loading local spending data'
const good = (id: string, itemName: string, day: string) => ({
  id,
  itemName,
  amount: 4.5,
  category: 'Food & Dining',
  date: `${day}T12:00:00`,
  createdAt: `${day}T12:00:00`,
})

/**
 * What the auditors fed the app: each of these crashed 0.8.x somewhere. All are kept aside but
 * the object note, which is dropped from an entry that is otherwise fine (a repair).
 */
const POISON: readonly unknown[] = [
  { ...good('bad-date-1', 'last tuesday kopi', '2026-10-12'), date: 'last tuesday' },
  { ...good('bad-date-2', 'slashed date', '2026-10-12'), date: '18/10/2026' },
  { ...good('bad-amount', 'nan amount', '2026-10-12'), amount: 'abc' },
  { ...good('bad-notes', 'object notes', '2026-10-12'), notes: { x: 1 } },
  { id: 'no-name', amount: 3, date: '2026-10-12T12:00:00', createdAt: '2026-10-12T12:00:00' },
  null,
]

async function waitForApp(page: Page) {
  await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole('main')).toBeVisible({ timeout: 15_000 })
}

async function openBackup(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Backup', exact: true }).click()
  return sheet
}

/** Every screen still opens, and no error card took one over. */
async function expectShellAlive(page: Page) {
  for (const path of ['/pulse', '/ledger?range=all', '/insights']) {
    await page.goto(path)
    await waitForApp(page)
    await expect(page.getByText('Unexpected Application Error')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /went wrong|couldn't/i })).toHaveCount(0)
  }
}

test('a poisoned import lists the rows it cannot read and restores the rest', async ({ page }) => {
  await page.goto('/pulse')
  await waitForApp(page)
  const sheet = await openBackup(page)
  const file = {
    version: '4.0',
    exportDate: '2026-10-12T04:00:00.000Z',
    categories: ['Food & Dining', 'Other'],
    categoryMappings: {},
    expenses: [
      good('ok-1', 'good laksa', '2026-10-10'),
      good('ok-2', 'good kopi', '2026-10-11'),
      ...POISON,
    ],
  }
  await sheet.locator('input[type="file"]').setInputFiles({
    name: 'poisoned.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  })
  const preview = sheet.getByRole('region', { name: 'Import poisoned.json?' })
  // every row of the file is counted once: 3 that read, the other 5 that can't be read
  const rows = 2 + POISON.length
  await expect(preview.getByRole('listitem')).toHaveText([
    `${String(rows)} in the file`,
    '3 new',
    `${String(rows - 3)} can't be read`,
  ])
  await preview.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Imported · 3 added'),
  ).toBeVisible()
  expect((await storedExpenses(page)).map((e) => e.itemName).sort()).toEqual([
    'good kopi',
    'good laksa',
    'object notes',
  ])
  await expectShellAlive(page)
})

test('a poisoned row in storage leaves the shell up and is downloadable as it was', async ({
  page,
}) => {
  await page.addInitScript(
    (rows) => {
      if (sessionStorage.getItem('e2e-seeded') !== null) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem('expenses', JSON.stringify(rows))
    },
    [good('ok-1', 'good laksa', '2026-10-10'), ...POISON],
  )
  await expectShellAlive(page)
  expect((await storedExpenses(page)).map((e) => e.itemName).sort()).toEqual([
    'good laksa',
    'object notes',
  ])

  const sheet = await openBackup(page)
  const card = sheet.getByRole('region', { name: 'Needs attention' })
  await expect(card).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: /^Download (them|it)$/ }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(
    /^spendtrack-needs-attention-\d{4}-\d{2}-\d{2}\.json$/,
  )
  const text = await readFile(await download.path(), 'utf8')
  for (const piece of ['last tuesday', '18/10/2026', 'abc', 'no-name'])
    expect(text).toContain(piece)
})

test('when the data engine cannot load, the shell offers Reload and the raw data', async ({
  page,
}) => {
  // The one-shot stale-chunk reload is held, so the failure shows at once.
  await page.addInitScript(
    (rows) => {
      sessionStorage.setItem('spendtrack:chunk-reload-at', String(Date.now()))
      if (sessionStorage.getItem('e2e-seeded') !== null) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem('expenses', JSON.stringify(rows))
    },
    [good('ok-1', 'good laksa', '2026-10-10'), ...POISON],
  )
  await page.route('**/assets/engine-*.js', (route) => route.abort())
  await page.goto('/pulse')
  await expect(page.getByText("SpendTrack couldn't start.")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download my data', exact: true }).click(),
  ])
  const file = JSON.parse(await readFile(await download.path(), 'utf8')) as {
    kind: string
    keys: Record<string, string>
  }
  expect(file.kind).toBe('raw-browser-backup')
  expect(file.keys.expenses).toContain('good laksa')
  expect(file.keys.expenses).toContain('last tuesday')
})
