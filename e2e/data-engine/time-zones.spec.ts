import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { storedExpenses } from '../support/stored'

// F-096 / P2-2: an entry's day is the calendar day it was logged for, in every time zone. 0.10.0
// stores `day` and `date = day + 'T12:00:00'` (local noon, no zone) for new entries, and reads
// the day of an older entry the way 0.9.4 showed it. Checked at the edges: 00:30 in Kiritimati
// (UTC+14, where local noon of today is still yesterday in UTC), 23:59 on 31 Dec in Honolulu
// (UTC-10) and a Singapore morning, through the Ledger's Today range and the CSV export.
// Invented data only.

const ZONES = [
  {
    zone: 'Pacific/Kiritimati',
    now: '2026-10-18T10:30:00Z',
    today: '2026-10-19',
    yesterday: '2026-10-18',
    legacy: '2026-10-16',
  },
  {
    zone: 'Pacific/Honolulu',
    now: '2027-01-01T09:59:00Z',
    today: '2026-12-31',
    yesterday: '2026-12-30',
    legacy: '2026-12-28',
  },
  {
    zone: 'Asia/Singapore',
    now: '2026-10-18T01:00:00Z',
    today: '2026-10-18',
    yesterday: '2026-10-17',
    legacy: '2026-10-15',
  },
] as const

const LOADING = 'Loading local spending data'

const quickAdd = (page: Page) =>
  page.getByRole('textbox', { name: 'Quick add expense' }).filter({ visible: true }).first()

async function add(page: Page, phrase: string) {
  await quickAdd(page).fill(phrase)
  await quickAdd(page).press('Enter')
  await expect(quickAdd(page)).toHaveValue('')
}

/** The CSV export's Date cell per Item. */
async function csvDays(page: Page): Promise<Record<string, string>> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Backup', exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sheet.getByRole('button', { name: 'Export to CSV' }).click(),
  ])
  const text = (await readFile(await download.path(), 'utf8')).replace(/^﻿/, '')
  const out: Record<string, string> = {}
  // Every cell is quoted ("2026-10-19","kopi",…); these days and names hold no comma or quote.
  const unquote = (cell: string) => cell.replace(/^"(.*)"$/, '$1')
  for (const line of text.split('\r\n').slice(1)) {
    const [day, item] = line.split(',').map(unquote)
    if (day && item) out[item] = day
  }
  await page.keyboard.press('Escape')
  return out
}

// A pristine origin shows the first-run card above every screen (PR-4); these tests start past
// it, as after Start fresh. e2e/first-run.spec.ts covers the card itself.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('spendtrack:welcome', '1')
  })
})

for (const z of ZONES) {
  test.describe(z.zone, () => {
    test.use({ timezoneId: z.zone })

    test(`quick add today and yesterday, and a 0.9.4 entry, each land on their day`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(z.now))
      // What 0.9.4's Add sheet stored for a day: local noon of it, as a UTC instant ("Z").
      const legacyDate = await page.evaluate(
        (day) => new Date(`${day}T12:00:00`).toISOString(),
        z.legacy,
      )
      await page.addInitScript(
        (seed) => {
          if (sessionStorage.getItem('e2e-seeded') !== null) return
          sessionStorage.setItem('e2e-seeded', '1')
          localStorage.setItem(
            'expenses',
            JSON.stringify([
              {
                id: 'legacy-z',
                itemName: 'legacy noon',
                amount: 3,
                category: 'Food & Dining',
                date: seed.date,
                createdAt: seed.date,
              },
            ]),
          )
        },
        { date: legacyDate },
      )
      await page.goto('/pulse')
      await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })

      await add(page, 'kopi 2')
      await add(page, 'lunch 8 yesterday')

      // Stored as the day plus local noon with no zone; the old row keeps its own date.
      const stored = await storedExpenses(page)
      const byName = new Map(stored.map((e) => [e.itemName, e]))
      expect(byName.get('kopi')).toMatchObject({ day: z.today, date: `${z.today}T12:00:00` })
      expect(byName.get('lunch')).toMatchObject({
        day: z.yesterday,
        date: `${z.yesterday}T12:00:00`,
      })
      expect(byName.get('legacy noon')?.date).toBe(legacyDate)

      // The Ledger's Today holds only today's entry.
      await page.goto('/ledger?range=today')
      await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 })
      await expect(page.getByRole('button', { name: /^Edit kopi, / })).toBeVisible({
        timeout: 15_000,
      })
      await expect(page.getByRole('button', { name: /^Edit lunch, / })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Edit legacy noon, / })).toHaveCount(0)

      expect(await csvDays(page)).toEqual({
        kopi: z.today,
        lunch: z.yesterday,
        'legacy noon': z.legacy,
      })
    })
  })
}
