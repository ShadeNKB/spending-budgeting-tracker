import { test, expect, type Page, type TestInfo } from '@playwright/test'
import {
  CATEGORIES,
  auditTargets,
  axeViolations,
  dialog,
  horizontalOverflow,
  isPhone,
  openSettings,
  row,
  seed,
  settle,
  storedExpenses,
  switchTheme,
  waitForApp,
  type SeedExpense,
} from './support/a11y'
import { rawStorage } from './support/stored'

// Settings › Backup › Recovery (PR-4, F-004, F-014, F-050), in the production build on Chromium
// at 1280 px and WebKit (iPhone) at 375 px: a Delete all brought back from its snapshot; rows
// that could not be read fixed and discarded; a change from the other device put back. Each new
// state passes axe in both themes and, on the phone, the 44 px target audit and a 320 px reflow.
// Invented data, Singapore clock, reduced motion.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

/** Every check is reported, not only the first that fails. */
const softly = expect.configure({ soft: true })

const pad = (n: number) => String(n).padStart(2, '0')

const TWELVE: SeedExpense[] = Array.from({ length: 12 }, (_, i) =>
  row(
    `rc-${pad(i + 1)}`,
    `2026-10-${pad(i + 1)}`,
    2 + i + 0.5,
    `lunch ${pad(i + 1)}`,
    CATEGORIES[i % 4] ?? 'Other',
  ),
)

/** What the owner sees of an entry: name, amount, category, day. */
const shown = (e: { itemName: string; amount: number; category: string; date: string }) =>
  `${e.itemName}|${String(e.amount)}|${e.category}|${e.date.slice(0, 10)}`

const notifications = (page: Page) => page.getByRole('region', { name: 'Notifications' })

/**
 * The state on screen: axe in both themes (the stored theme is `system`); on the phone also the
 * 44 px audit and, at 320 px, nothing scrolling sideways.
 */
async function audit(page: Page, testInfo: TestInfo, what: string): Promise<void> {
  await settle(page)
  softly(await axeViolations(page), `${what}: axe, dark`).toEqual([])
  await switchTheme(page, 'light')
  softly(await axeViolations(page), `${what}: axe, light`).toEqual([])
  await switchTheme(page, 'dark')
  if (!isPhone(testInfo)) return
  const targets = await auditTargets(page)
  softly(targets.checked, `${what}: controls in reach`).toBeGreaterThan(0)
  softly(targets.problems, `${what}: 44 px touch targets`).toEqual([])
  await page.setViewportSize({ width: 320, height: 720 })
  await settle(page)
  softly(await horizontalOverflow(page, 320), `${what}: 320 px, no sideways scrolling`).toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
  await settle(page)
}

/**
 * Every stored key once nothing has been written for over a second (the rollback mirror follows
 * the envelope after 1 s of quiet).
 */
async function settledStorage(page: Page): Promise<Record<string, string>> {
  let last = await rawStorage(page)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1200)
    const now = await rawStorage(page)
    if (JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
  }
  throw new Error('storage kept changing')
}

/** Opens Recovery from Backup; its heading takes focus. */
async function openRecovery(page: Page, row = /^Recovery/) {
  const sheet = await openSettings(page, 'Backup')
  await sheet.getByRole('button', { name: row }).click()
  const heading = sheet.getByRole('heading', { name: 'Recovery', level: 3 })
  await expect(heading).toBeFocused()
  return sheet
}

test('Delete all, then Recovery › Snapshots › "Before Delete all" brings every entry back (acceptance 2, 3, 5)', async ({
  page,
}, testInfo) => {
  test.slow(isPhone(testInfo), 'two axe scans, the touch target audit and a reflow in WebKit')
  await seed(page, { expenses: TWELVE, theme: 'system' })
  await page.goto('/pulse')
  await waitForApp(page)
  const before = (await storedExpenses(page)).map(shown).sort()
  expect(before).toHaveLength(12)

  const sheet = await openSettings(page, 'Backup')
  await sheet.getByRole('button', { name: 'Delete all entries', exact: true }).click()
  await sheet
    .getByRole('group', { name: 'Delete all 12 entries?' })
    .getByRole('button', { name: 'Delete all', exact: true })
    .click()
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(0)
  // Past its Undo: the toast is gone (the snapshot does not depend on it).
  await notifications(page).getByRole('button', { name: 'Dismiss' }).first().click()
  await expect(notifications(page).getByText('All entries deleted')).toHaveCount(0)

  await sheet.getByRole('button', { name: /^Recovery/ }).click()
  await expect(sheet.getByRole('heading', { name: 'Recovery', level: 3 })).toBeFocused()
  const snapshots = sheet.getByRole('list', { name: 'Snapshots' })
  await expect(snapshots.getByRole('listitem').first()).toContainText('Before Delete all')
  await expect(snapshots.getByRole('listitem').first()).toContainText('12 entries')
  await snapshots.getByRole('button', { name: /^Restore Before Delete all, / }).click()
  const preview = sheet.getByRole('region', { name: 'Restore from this copy?' })
  await expect(preview.getByRole('listitem')).toHaveText([
    '12 in the copy',
    '12 restored (they were deleted)',
  ])
  await expect(preview).toContainText('Nothing here is removed or changed.')
  await expect(preview.getByRole('button', { name: /Replace/ })).toHaveCount(0)
  await audit(page, testInfo, 'snapshot preview')

  await preview.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(notifications(page).getByText('Restored 12 entries')).toBeVisible()
  await expect.poll(async () => (await storedExpenses(page)).length).toBe(12)
  // the same entries, under new ids (the old ones stay deleted)
  const after = await storedExpenses(page)
  expect(after.map(shown).sort()).toEqual(before)
  expect(after.some((e) => TWELVE.some((t) => t.id === e.id))).toBe(false)
  // a pre-restore safety copy was kept
  await expect(snapshots.getByRole('listitem').first()).toContainText('Before an import or restore')

  // Back returns to the row; Escape still closes Settings; it opens again on Backup's main view.
  await sheet.getByRole('button', { name: 'Back to Backup' }).click()
  await expect(sheet.getByRole('button', { name: /^Recovery/ })).toBeFocused()
  await sheet.getByRole('button', { name: /^Recovery/ }).click()
  await expect(sheet.getByRole('heading', { name: 'Recovery', level: 3 })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog(page, 'Settings')).toHaveCount(0, { timeout: 15_000 })
  const again = await openSettings(page, 'Backup')
  await expect(again.getByRole('heading', { name: 'Recovery', level: 3 })).toHaveCount(0)
  await expect(again.getByRole('button', { name: /^Recovery/ })).toBeVisible()
})

const BAD_AMOUNT = {
  id: 'bad-amount-1',
  itemName: 'chicken rice',
  amount: 'abc',
  category: 'Food & Dining',
  date: '2026-10-12T12:00:00',
  createdAt: '2026-10-12T12:00:00',
  notes: 'extra egg',
}
const BAD_DATE = {
  id: 'bad-date-1',
  itemName: 'taxi',
  amount: 18.4,
  category: 'Transportation',
  date: 'last tuesday',
  createdAt: '2026-10-13T12:00:00',
}

test('rows that could not be read: Review, Fix and Discard (acceptance 10–13)', async ({
  page,
}, testInfo) => {
  test.slow(isPhone(testInfo), 'two axe scans per state, the touch target audit and a reflow')
  await seed(page, {
    theme: 'system',
    raw: { expenses: JSON.stringify([...TWELVE.slice(0, 3), BAD_AMOUNT, BAD_DATE, 42]) },
  })
  await page.goto('/pulse')
  await waitForApp(page)

  // The upgrade's toast (this first boot moves the v4 keys): Review opens Recovery on the list.
  const toast = notifications(page)
  await expect(
    toast.getByText('Your data was upgraded: 3 entries · 3 need attention'),
  ).toBeVisible()
  // A person reads the toast first: a press as it appears belongs to what was there before.
  await page.waitForTimeout(600)
  await toast.getByRole('button', { name: 'Review' }).click()
  const sheet = dialog(page, 'Settings')
  await expect(sheet.getByRole('heading', { name: 'Needs attention (3)' })).toBeFocused()
  const list = sheet.getByRole('list', { name: 'Needs attention' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  const amountRow = list.getByRole('listitem').filter({ hasText: 'chicken rice' })
  await expect(amountRow).toContainText("The amount isn't a number above 0")
  await expect(amountRow).toContainText('Found on this device')
  await expect(list.getByRole('listitem').filter({ hasText: 'taxi' })).toContainText(
    "The date can't be read",
  )
  await expect(list.getByRole('listitem').filter({ hasText: 'Unnamed entry' })).toContainText(
    "It isn't an entry",
  )
  await audit(page, testInfo, 'needs attention')

  // Fix: the Add sheet, prefilled with what still reads; the amount is typed.
  await list.getByRole('button', { name: 'Fix chicken rice' }).click()
  const add = dialog(page, 'Add expense')
  await expect(add).toBeVisible()
  await expect(add.getByRole('textbox', { name: 'Notes (optional)' })).toHaveValue('extra egg')
  await expect(add.getByLabel('What', { exact: true })).toHaveValue('chicken rice')
  await expect(add.getByLabel('Amount', { exact: true })).toHaveValue('')
  await add.getByLabel('Amount', { exact: true }).fill('5.5')
  await add.getByRole('button', { name: /^Add for / }).click()
  await expect(add).toHaveCount(0, { timeout: 15_000 })
  await expect(
    toast.getByText(/^Added "chicken rice" · S\$5\.50.*The unreadable original stays/),
  ).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Needs attention (2)' })).toBeVisible()
  const fixed = (await storedExpenses(page)).find((e) => e.itemName === 'chicken rice')
  expect(fixed).toMatchObject({ amount: 5.5, category: 'Food & Dining', notes: 'extra egg' })
  expect(fixed?.date.slice(0, 10)).toBe('2026-10-12')
  // the unreadable original stays on the device (and in the raw download)
  expect((await rawStorage(page))['st5:q']).toContain('abc')

  // Discard: asked first, downloaded first; then only that row leaves, from the log alone.
  const kept = await settledStorage(page)
  await list.getByRole('button', { name: 'Discard taxi' }).click()
  const ask = sheet.getByRole('group', { name: 'Discard this for good?' })
  await expect(ask.getByRole('checkbox', { name: 'Download it first' })).toBeChecked()
  await audit(page, testInfo, 'discard question')
  const download = page.waitForEvent('download')
  await ask.getByRole('button', { name: 'Discard', exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(
    /^spendtrack-needs-attention-\d{4}-\d{2}-\d{2}\.json$/,
  )
  await expect(sheet.getByRole('heading', { name: 'Needs attention (1)' })).toBeFocused()
  const now = await settledStorage(page)
  expect(Object.keys(now).sort()).toEqual(Object.keys(kept).sort())
  const changed = Object.keys(now).filter((k) => now[k] !== kept[k])
  for (const k of changed) expect(['st5:q', 'st5:db', 'st5:gen']).toContain(k)
  expect(now['st5:q']).not.toContain('last tuesday')
  expect(now['st5:q']).toContain('abc')

  // Raw data: everything stored, never the sync code.
  const raw = page.waitForEvent('download')
  await sheet.getByRole('button', { name: 'Download raw data' }).click()
  const file = await raw
  const text = await (await file.createReadStream()).toArray()
  expect(Buffer.concat(text).toString('utf8')).not.toContain('"syncId"')
})

test('a change from the other device, put back from Recovery (acceptance 1, 7)', async ({
  page,
}, testInfo) => {
  test.slow(isPhone(testInfo), 'two axe scans, the touch target audit and a reflow in WebKit')
  await seed(page, { expenses: TWELVE, theme: 'system' })
  await page.goto('/pulse')
  await waitForApp(page)
  // What a sync merge journals (§9.8), written as this device keeps it: a quiet removal of an
  // entry, and an edit of another one made while it was being edited here.
  await page.evaluate(
    ({ at, gone, live }) => {
      localStorage.setItem(
        'st5:journal',
        JSON.stringify([
          {
            id: 'j-removed',
            at: at - 3_600_000,
            seen: false,
            kind: 'removed',
            rec: gone.id,
            before: gone,
          },
          {
            id: 'j-conflict',
            at: at - 7_200_000,
            seen: false,
            kind: 'conflict',
            rec: live.id,
            before: live,
            after: { ...live, amount: 45 },
          },
        ]),
      )
    },
    {
      at: Date.now(),
      gone: row('gone-1', '2026-10-09', 6.8, 'mee pok', 'Food & Dining'),
      live: TWELVE[0] ?? row('x', '2026-10-01', 1, 'x'),
    },
  )
  await page.reload()
  await waitForApp(page)

  const sheet = await openRecovery(page, /^Recovery, 1 new$/)
  const changes = sheet.getByRole('list', { name: 'Changes from your other device' })
  const conflict = changes.getByRole('listitem').first()
  await expect(conflict).toContainText(
    'Changed on your other device while you were editing it here',
  )
  await expect(conflict).toContainText('Amount: S$2.50 → S$45.00')
  await expect(conflict.getByText('New', { exact: true })).toBeVisible()
  const removed = changes.getByRole('listitem').filter({ hasText: 'mee pok' })
  await expect(removed).toContainText('Deleted on your other device')
  await audit(page, testInfo, 'changes from the other device')

  await removed.getByRole('button', { name: 'Restore mee pok' }).click()
  await expect(notifications(page).getByText('Restored', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await storedExpenses(page)).map((e) => e.itemName))
    .toContain('mee pok')
  // again (from the keyboard: a second tap this soon on the same spot is the same gesture)
  await removed.getByRole('button', { name: 'Restore mee pok' }).press('Enter')
  await expect(notifications(page).getByText("It's already back.")).toBeVisible()

  await sheet.getByRole('button', { name: 'Mark all seen' }).click()
  await expect(conflict.getByText('New', { exact: true })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Back to Backup' }).click()
  await expect(sheet.getByRole('button', { name: 'Recovery', exact: true })).toBeFocused()
})
