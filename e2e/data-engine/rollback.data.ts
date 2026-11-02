import { test, expect, type Page } from '@playwright/test'
import { serveBuild, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  deleteEntry,
  editAmount,
  openDevice,
  quickAdd,
  storedRows,
  waitForApp,
  type Device,
} from './support/devices'
import { ownerShapedV4 } from './support/owner'

// §18.3 rollback proof: if 0.10.0 has to be pulled, the owner's devices go back to 0.9.2 on the
// same origin and keep everything. This build migrates an owner-shaped v4 dataset, changes it,
// and keeps the v4 keys as a mirror; 0.9.2 then boots from that mirror and shows every live
// entry, item pick and budget, and none of the deleted; an entry added on 0.9.2 is folded back
// in when this build returns, with nothing lost. No sync here: the mirror alone carries it.
// Invented data.

let host: StaticHost
let device: Device | undefined

test.beforeAll(async () => {
  host = await serveBuild(PORTS.rollback, build('candidate'))
})

test.afterAll(async () => {
  await closeAll([device])
  await host.close()
})

/** In the page: a v4 key as 0.9.2 reads it. */
const v4 = (page: Page, key: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as unknown, key)

/** In the page: the doc of the v5 envelope. */
const envelopeDoc = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem('st5:db') ?? ''
    const body = JSON.parse(raw.slice(raw.indexOf('|', 2) + 1)) as { doc: Record<string, unknown> }
    return body.doc
  })

test('0.9.2 boots from the mirror with every live entry, pick and budget, and back again', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const owner = ownerShapedV4()
  const d = await openDevice(browser, host.origin, {
    syncCode: null,
    seed: owner.keys,
    path: '/ledger?range=all',
  })
  device = d
  const page = d.page
  await expect.poll(() => page.evaluate(() => localStorage.getItem('st5:db') !== null)).toBe(true)

  // Changes on this build: an add, an edit, a delete.
  await quickAdd(page, 'rollback add 3.30')
  const edited = 'kopi 0007'
  const deleted = (await storedRows(page)).find((r) => r.id === 'owner-0002')?.itemName ?? ''
  await editAmount(
    page,
    (await storedRows(page)).find((r) => r.id === 'owner-0007')?.itemName ?? edited,
    '7.70',
  )
  await deleteEntry(page, deleted)
  // The mirror is written on hide: leave the page as the owner would.
  await page.goto('about:blank')

  await page.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(page)
  const live = await storedRows(page)
  const doc = await envelopeDoc(page)
  expect(live.map((r) => r.id)).not.toContain('owner-0002')
  expect(live.find((r) => r.id === 'owner-0007')?.amount).toBe(7.7)
  expect(live).toHaveLength(700)
  await page.goto('about:blank')

  // Rolled back: 0.9.2 on the same origin.
  host.serve(build('v092'))
  await page.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(page)
  const v4Rows = (
    (await v4(page, 'expenses')) as { id: string; amount: number; itemName: string }[]
  )
    .map((r) => [r.id, r.itemName, r.amount] as const)
    .sort()
  expect(v4Rows).toEqual(live.map((r) => [r.id, r.itemName, r.amount] as const).sort())
  expect(await v4(page, 'categoryMappings')).toEqual(doc.categoryMappings)
  expect(await v4(page, 'categoryMappingUpdatedAt')).toEqual(doc.mappingUpdatedAt)
  expect(await v4(page, 'categoryBudgets')).toEqual(doc.budgets)
  await expect(page.getByText('700 entries', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(`^Edit ${deleted}, `) })).toHaveCount(0)

  // An entry added while rolled back.
  await quickAdd(page, 'added on old 4.40')
  await expect
    .poll(async () => JSON.stringify(await v4(page, 'expenses')))
    .toContain('added on old')
  await page.goto('about:blank')

  // Forward again: this build folds the old one's change in, nothing lost.
  host.serve(build('candidate'))
  await page.goto(`${host.origin}/ledger?range=all`)
  await waitForApp(page)
  const back = await storedRows(page)
  expect(back.map((r) => r.itemName)).toContain('added on old')
  expect(back).toHaveLength(701)
  expect(back.map((r) => r.id)).not.toContain('owner-0002')
  for (const r of live) expect(back.find((x) => x.id === r.id)?.amount, r.id).toBe(r.amount)
})
