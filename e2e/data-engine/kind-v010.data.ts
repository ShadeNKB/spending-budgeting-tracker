import { test, expect, type Page } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  editAmount,
  openDevice,
  storedRows,
  waitForApp,
  type Device,
} from './support/devices'

// T8c (money in): the kind of an entry rides in its record's extras, the fields a v5 release
// keeps without knowing them. 0.10.0 is the first v5 release, so what holds for it holds for
// every release since. An income made by this build, then listed, edited and pushed by 0.10.0 on
// the same storage and the same sync code, is still an income: on the relay, in what 0.10.0
// stored, and on this build again, with the amount 0.10.0 gave it. Invented data.

let relay: Relay
let host: StaticHost
let device: Device | undefined

test.beforeAll(async () => {
  relay = await startRelay(PORTS.relay)
  host = await serveBuild(PORTS.rollback, build('candidate'))
})

test.afterAll(async () => {
  await closeAll([device])
  await host.close()
  await relay.close()
})

/** The page leaves (the mirror and envelope are flushed on hide), then the origin's build loads. */
async function reopen(page: Page): Promise<void> {
  await page.goto('about:blank')
  await page.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(page)
}

/** One field of the relay's copy of the record named `item` (undefined: no such record or field). */
function onRelay(item: string, field: string): unknown {
  const payload = relay.row(SYNC_CODE)?.payload
  const list: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'expenses') : null
  if (!Array.isArray(list)) return undefined
  const record: unknown = list.find(
    (r: unknown) => typeof r === 'object' && r !== null && Reflect.get(r, 'itemName') === item,
  )
  return typeof record === 'object' && record !== null ? Reflect.get(record, field) : undefined
}

const stored = async (page: Page, item: string): Promise<Record<string, unknown> | undefined> =>
  (await storedRows(page)).find((r) => r.itemName === item) as Record<string, unknown> | undefined

test('an income survives 0.10.0: listed, edited and pushed there, it comes back an income', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const d = await openDevice(browser, host.origin, { path: '/ledger?range=all' })
  device = d
  const page = d.page

  await page.keyboard.press('Control+n')
  await page
    .getByRole('dialog', { name: 'Add expense' })
    .getByRole('radio', { name: 'Income' })
    .click()
  const sheet = page.getByRole('dialog', { name: 'Add income' })
  await sheet.getByRole('textbox', { name: 'What' }).fill('allowance')
  await sheet.getByRole('spinbutton', { name: 'Amount' }).fill('790')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    page.getByRole('button', { name: /^Edit allowance, \+.*790\.00 income, / }),
  ).toBeVisible()
  await expect.poll(() => onRelay('allowance', 'kind'), { timeout: 30_000 }).toBe('income')
  expect(onRelay('allowance', 'amount')).toBe(790)
  expect(await stored(page, 'allowance')).toMatchObject({ amount: 790, kind: 'income' })

  // Rolled back: 0.10.0 on the same origin, the same storage, the same code. It knows no kinds:
  // the entry is a row like any other there, and an edit of its amount is an edit like any other.
  host.serve(build('v010'))
  await reopen(page)
  await editAmount(page, 'allowance', '800')
  await expect.poll(() => onRelay('allowance', 'amount'), { timeout: 30_000 }).toBe(800)
  expect(relay.pushes(host.origin).at(-1)?.writer).toBe('v5')
  // What 0.10.0 pushed, and what it stored, still say what the entry is.
  expect(onRelay('allowance', 'kind')).toBe('income')
  expect(await stored(page, 'allowance')).toMatchObject({ amount: 800, kind: 'income' })

  // Forward again: an income, with 0.10.0's amount, and in no spending total.
  host.serve(build('candidate'))
  await reopen(page)
  await expect(
    page.getByRole('button', { name: /^Edit allowance, \+.*800\.00 income, / }),
  ).toBeVisible()
  await expect(page.getByText(/800\.00 money in$/)).toBeVisible()
  expect(await stored(page, 'allowance')).toMatchObject({ amount: 800, kind: 'income' })
  expect(onRelay('allowance', 'kind')).toBe('income')
})
