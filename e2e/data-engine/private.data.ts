import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  closeSettings,
  itemNames,
  openDevice,
  openSettingsTab,
  quickAdd,
  syncState,
  waitForApp,
  type Device,
} from './support/devices'
import {
  RICH,
  auditTargets,
  axeViolations,
  fieldFillProblems,
  horizontalOverflow,
  isPhone,
  settle,
  switchTheme,
} from '../support/a11y'

// PRIVATE-SYNC release 1 in real browsers, on the build whose relay can keep a private sync safe
// (the flags build: VITE_SYNC_RELAY=auto, with the relay's sync functions applied).
//
// AC-P17: a private sync is generated on one device and joined on the other by its typed code;
//   edits flow both ways; the relay only ever holds an envelope under a derived row id, and no
//   request, row or topic carries the code or an entry's name. On Chromium and on WebKit.
// AC-P18: the real 0.20.0 build refuses a typed private code, and on a device that already
//   syncs privately it says a newer SpendTrack set sync up, sends nothing and keeps the code.
// 3.2: with two tabs open, the one left on a plain code follows the device going private in the
//   other, and sends the plain row nothing more.
// AC-P19: the new states pass axe in both themes, with 44 px targets and no sideways scroll at
//   320 px on the phone. 3.9: the owner replaces a copy marked newer, in the real panel.
// Invented data; the seeded code is the codec's known-answer vector, never a real one.

/** The secret of bytes 00..0f (core/codes.test.ts), and what it derives (core/e2e.test.ts). */
const KAT = 'ST5-0004106-1050R3G-G28A1C6-0T3GFS3'
const KAT_ROW = 'e4555323-21f5-8f92-8c6a-97e208c0967b'
const PRIVATE_CODE = /^ST5(-[0-9A-HJKMNP-TV-Z]{7}){4}$/
/** A row id made from the code's secret: a version 8 UUID, never one a person could have typed. */
const DERIVED_ROW = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DERIVED_TOPIC = /^st:[A-Za-z0-9_-]{22}$/
const ENVELOPE_KEYS = ['ct', 'iv', 'k', 'r', 'st', 'z']
/** A copy marked as a newer format: read off its header, before anything is opened. */
const NEWER = { st: 6, k: 1, r: 'B'.repeat(22), iv: 'A'.repeat(16), z: 0, ct: 'AAAA' }
const PLAIN_CODE = '5e5e5e5e-0e2e-4e2e-8e2e-0000000b0001'

let relay: Relay
let hostA: StaticHost
let hostB: StaticHost
let hostOld: StaticHost
let devices: Device[] = []

const entry = (id: string, itemName: string, day: string) => ({
  id,
  itemName,
  amount: 4.2,
  category: 'Food & Dining',
  date: `${day}T12:00:00`,
  createdAt: `${day}T12:00:00`,
})
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const keysOf = (payload: unknown): string[] =>
  isRecord(payload) ? Object.keys(payload).sort() : []
const privateKey = (page: Page) => page.evaluate(() => localStorage.getItem('st5:synckey'))
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' })

test.beforeAll(async () => {
  hostA = await serveBuild(PORTS.candidateA, build('candidate-flags'))
  hostB = await serveBuild(PORTS.candidateB, build('candidate-flags'))
  hostOld = await serveBuild(PORTS.v020, build('v020'))
})

test.beforeEach(async () => {
  relay = await startRelay(PORTS.relay)
  // migration 004: the sync functions a private sync needs (compare-and-set writes)
  relay.enableRpc()
})

test.afterEach(async () => {
  await closeAll(devices)
  devices = []
  hostA.serve(build('candidate-flags'))
  await relay.close()
})

test.afterAll(async () => {
  await hostA.close()
  await hostB.close()
  await hostOld.close()
})

/** Generates a private sync through the real panel; resolves to the code read off the screen. */
async function generatePrivate(d: Device): Promise<string> {
  const sheet = await openSettingsTab(d.page, 'Sync')
  await expect(sheet.getByText(/A sync started here is private/)).toBeVisible()
  await sheet.getByRole('button', { name: 'Generate sync code for this device' }).click()
  await expect(
    toasts(d.page).getByText('Private sync code created. Enter it on your other device.'),
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    sheet.getByText(/^Private sync: what this device sends is encrypted here first\./),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Show code' }).click()
  const shown = await sheet.locator('span.select-all').innerText()
  await sheet.getByRole('button', { name: 'Hide code' }).click()
  const code = shown.replace(/[^0-9A-Z-]/g, '')
  expect(code).toMatch(PRIVATE_CODE)
  return code
}

/** Joins `typed` through the real panel, answering the preview. */
async function joinPrivate(d: Device, typed: string, preview: string): Promise<void> {
  const sheet = await openSettingsTab(d.page, 'Sync')
  await sheet.getByRole('textbox', { name: 'Sync code' }).fill(typed)
  await sheet.getByRole('button', { name: 'Join', exact: true }).click()
  const ask = sheet.getByRole('group', { name: 'Join this sync?' })
  await expect(ask).toContainText(preview)
  await ask.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(toasts(d.page).getByText('Joined. This device is synced.')).toBeVisible({
    timeout: 30_000,
  })
}

test('AC-P17: a private sync made on one device, joined on the other by its typed code', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const a = await openDevice(browser, hostA.origin, {
    syncCode: null,
    seed: {
      expenses: JSON.stringify([
        entry('p-a1', 'laptop kopi', '2026-11-10'),
        entry('p-a2', 'laptop lunch', '2026-11-11'),
      ]),
    },
  })
  devices.push(a)
  const code = await generatePrivate(a)

  // the code sits in its own key: not in `syncId`, not in the setup the old builds read
  const stateA = await syncState(a.page)
  expect(stateA.code).toBeNull()
  expect(stateA.config).toMatchObject({ kind: 'e2e' })
  expect(JSON.stringify(stateA.config)).not.toContain('ST5')
  expect(await privateKey(a.page)).toContain(code)

  // the relay: one row under a derived id, holding an envelope and nothing else
  const rowOf = () => relay.writes(a.origin).at(-1)?.syncId ?? ''
  await expect.poll(rowOf, { timeout: 30_000 }).toMatch(DERIVED_ROW)
  const row = rowOf()
  expect(keysOf(relay.row(row)?.payload)).toEqual(ENVELOPE_KEYS)

  const b = await openDevice(browser, hostB.origin, {
    syncCode: null,
    seed: { expenses: JSON.stringify([entry('p-b1', 'phone taxi', '2026-11-12')]) },
  })
  devices.push(b)
  const sheetB = await openSettingsTab(b.page, 'Sync')
  const field = sheetB.getByRole('textbox', { name: 'Sync code' })
  // one character wrong: the code's own check catches it, and the relay is asked nothing
  const quiet = relay.log.filter((q) => q.origin === b.origin).length
  await field.fill(`${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`)
  await sheetB.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(
    sheetB.getByText('One character of that code looks wrong. Check it against your other device.'),
  ).toBeVisible()
  expect(relay.log.filter((q) => q.origin === b.origin)).toHaveLength(quiet)
  expect(await privateKey(b.page)).toBeNull()

  // typed as a person types it: lower case, spaces between the groups
  await joinPrivate(
    b,
    code.toLowerCase().replaceAll('-', ' '),
    'This device: 1 entry · Synced: 2 entries · After joining: about 3 entries.',
  )
  const all = ['laptop kopi', 'laptop lunch', 'phone taxi']
  await expect.poll(() => itemNames(b.page), { timeout: 30_000 }).toEqual(all)
  await expect.poll(() => itemNames(a.page), { timeout: 30_000 }).toEqual(all)

  // edits flow both ways
  await closeSettings(b.page)
  await quickAdd(b.page, 'phone teh 1.80')
  await expect.poll(() => itemNames(a.page), { timeout: 30_000 }).toContain('phone teh')
  await closeSettings(a.page)
  await quickAdd(a.page, 'laptop bao 2.40')
  await expect.poll(() => itemNames(b.page), { timeout: 30_000 }).toContain('laptop bao')

  // what the relay was sent: envelopes only, through the sync functions, on the derived row,
  // each naming the copy it was merged from (never forced); no row events; a derived topic
  const pushes = relay.pushes()
  expect(pushes.length).toBeGreaterThan(2)
  expect(
    pushes.filter(
      (q) =>
        q.syncId !== row ||
        q.kind !== 'rpc' ||
        q.fn !== 'st_sync_push' ||
        q.writer !== 'e2e' ||
        q.force === true,
    ),
  ).toEqual([])
  expect(keysOf(relay.row(row)?.payload)).toEqual(ENVELOPE_KEYS)
  expect(relay.channels(row)).toBe(0)
  expect(relay.topics().length).toBeGreaterThan(0)
  expect(relay.topics().filter((t) => !DERIVED_TOPIC.test(t))).toEqual([])
  const seen = JSON.stringify([relay.log, relay.row(row), relay.topics()])
  for (const secret of [
    code,
    code.replaceAll('-', ''),
    'laptop kopi',
    'laptop lunch',
    'phone taxi',
    'phone teh',
    'laptop bao',
  ]) {
    expect(seen, `the relay never sees "${secret}"`).not.toContain(secret)
  }
})

test('AC-P18: 0.20.0 refuses a typed private code, and keeps a private setup it cannot read', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  // typed into 0.20.0's Join: refused in words, nothing saved, nothing asked of the row
  const old = await openDevice(browser, hostOld.origin, { syncCode: null })
  devices.push(old)
  const sheetOld = await openSettingsTab(old.page, 'Sync')
  await sheetOld.getByRole('textbox', { name: 'Sync code' }).fill(KAT)
  await sheetOld.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(
    sheetOld.getByText("That's a private sync code. Update SpendTrack on this device to use it."),
  ).toBeVisible()
  expect((await syncState(old.page)).config).toBeNull()
  expect((await syncState(old.page)).code).toBeNull()
  expect(relay.pushes(old.origin)).toEqual([])

  // a device that syncs privately, then runs 0.20.0 again (a page cached before the update)
  const d = await openDevice(browser, hostA.origin, {
    syncCode: null,
    seed: { expenses: JSON.stringify([entry('m-1', 'new build kopi', '2026-11-10')]) },
  })
  devices.push(d)
  const code = await generatePrivate(d)
  await expect.poll(() => relay.writes(d.origin).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const key = await privateKey(d.page)
  expect(key).toContain(code)
  await closeSettings(d.page)

  hostA.serve(build('v020'))
  await d.page.reload()
  await waitForApp(d.page)
  const sheet = await openSettingsTab(d.page, 'Sync')
  await expect(sheet.getByText('This device runs SpendTrack 0.20.0')).toBeVisible()
  await expect(
    sheet
      .getByText(
        'Sync on this device was set up by a newer SpendTrack. Reload SpendTrack to update. Your data is safe here.',
      )
      .first(),
  ).toBeVisible()
  await expect(sheet.getByRole('button', { name: /Generate/ })).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: 'Sync code' })).toHaveCount(0)
  // an entry made meanwhile stays on the device: the old build sends nothing
  const sent = relay.pushes(d.origin).length
  await closeSettings(d.page)
  await quickAdd(d.page, 'old build bun 1.20')
  await d.page.waitForTimeout(4000)
  expect(relay.pushes(d.origin)).toHaveLength(sent)
  expect(await privateKey(d.page)).toBe(key)
  expect((await syncState(d.page)).code).toBeNull()
  expect((await syncState(d.page)).config).toMatchObject({ kind: 'e2e' })

  // updated again: the same private sync carries on, and the entry made meanwhile goes out
  hostA.serve(build('candidate-flags'))
  await d.page.reload()
  await waitForApp(d.page)
  expect(await privateKey(d.page)).toBe(key)
  await expect.poll(() => relay.writes(d.origin).length, { timeout: 30_000 }).toBeGreaterThan(sent)
  const b = await openDevice(browser, hostB.origin, { syncCode: null })
  devices.push(b)
  await joinPrivate(b, code, 'Synced: 2 entries')
  await expect
    .poll(() => itemNames(b.page), { timeout: 30_000 })
    .toEqual(['new build kopi', 'old build bun'])
})

test('3.2: a second tab follows the device going private, and sends the plain row nothing more', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  // one device, two tabs, both linked to a plain code
  const a = await openDevice(browser, hostA.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify([entry('t-1', 'tab kopi', '2026-11-10')]) },
  })
  devices.push(a)
  await expect.poll(() => relay.row(PLAIN_CODE) !== null, { timeout: 30_000 }).toBe(true)
  const tabB = await a.context.newPage()
  await tabB.goto(`${hostA.origin}/ledger`)
  await waitForApp(tabB)

  // in the second tab: Disconnect, then start a private sync
  const sheet = await openSettingsTab(tabB, 'Sync')
  await sheet.getByRole('button', { name: /Disconnect sync/ }).click()
  await sheet
    .getByRole('group', { name: 'Disconnect sync on this device?' })
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click()
  await sheet.getByRole('button', { name: 'Generate sync code for this device' }).click()
  // the device remembers the plain code it left: a new code is a separate sync, and it asks
  await sheet
    .getByRole('group', { name: 'Start a separate sync?' })
    .getByRole('button', { name: 'Make a new code', exact: true })
    .click()
  await expect(
    toasts(tabB).getByText('Private sync code created. Enter it on your other device.'),
  ).toBeVisible({ timeout: 30_000 })
  const privateRow = () =>
    relay
      .writes(a.origin)
      .map((q) => q.syncId ?? '')
      .find((id) => DERIVED_ROW.test(id)) ?? ''
  await expect.poll(privateRow, { timeout: 30_000 }).toMatch(DERIVED_ROW)
  const row = privateRow()
  await closeSettings(tabB)

  // the first tab still holds the plain code in memory. An entry made there now must go out
  // sealed, to the private row, and the plain row must be asked nothing
  const mark = relay.log.length
  const plainBefore = JSON.stringify(relay.row(PLAIN_CODE))
  await quickAdd(a.page, 'after private 1.10')
  await expect
    .poll(
      () => relay.log.slice(mark).filter((q) => q.syncId === row && q.outcome === 'ok').length,
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0)
  await a.page.waitForTimeout(3000)
  const since = relay.log.slice(mark)
  expect(since.filter((q) => q.syncId === PLAIN_CODE)).toEqual([])
  expect(JSON.stringify(relay.row(PLAIN_CODE))).toBe(plainBefore)
  expect(JSON.stringify([since, relay.row(PLAIN_CODE)])).not.toContain('after private')
  expect(relay.channels(PLAIN_CODE)).toBe(0)
  // and the first tab now shows the private sync
  const sheetA = await openSettingsTab(a.page, 'Sync')
  await expect(
    sheetA.getByText(/^Private sync: what this device sends is encrypted here first\./),
  ).toBeVisible()
})

// ─── AC-P19: the new states, through the accessibility gate ──────────────────────────────────

const softly = expect.configure({ soft: true })

/** axe in both themes, and on the phone the target audit and 320 px. */
async function gate(page: Page, testInfo: TestInfo) {
  await settle(page)
  softly(await axeViolations(page), 'axe, dark theme').toEqual([])
  await switchTheme(page, 'light')
  softly(await axeViolations(page), 'axe, light theme').toEqual([])
  await switchTheme(page, 'dark')
  if (!isPhone(testInfo)) return
  const targets = await auditTargets(page)
  softly(targets.problems, '44 px touch targets').toEqual([])
  softly(await fieldFillProblems(page), 'fields fill their boxes').toEqual([])
  await page.setViewportSize({ width: 320, height: 720 })
  await settle(page)
  softly(await horizontalOverflow(page, 320), '320 px: no sideways scrolling').toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
}

/** Settings › Sync on the flags build, dark theme and reduced motion, after seeding `keys`. */
async function openSync(page: Page, testInfo: TestInfo, keys: Record<string, string>) {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript((seed) => {
    if (localStorage.getItem('e2e:seeded') !== null) return
    localStorage.setItem('e2e:seeded', '1')
    localStorage.setItem('spendtrack:theme', 'system')
    localStorage.setItem('spendtrack:currency', 'SGD')
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
  }, keys)
  await page.goto(`${hostA.origin}/pulse`)
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Sync', exact: true }).click()
  return sheet
}

/** A device that already syncs privately with the known-answer code. */
const PRIVATE_DEVICE = {
  'st5:synckey': JSON.stringify({ code: KAT, at: 1, established: true }),
  expenses: JSON.stringify(RICH),
}

test('AC-P19: before a private sync is made, and a mistyped private code', async ({
  page,
}, testInfo) => {
  const sheet = await openSync(page, testInfo, { expenses: JSON.stringify(RICH) })
  await expect(sheet.getByText(/A sync started here is private/)).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Sync code' }).fill(`${KAT.slice(0, -1)}0`)
  await sheet.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(
    sheet.getByText('One character of that code looks wrong. Check it against your other device.'),
  ).toBeVisible()
  await gate(page, testInfo)
})

test('AC-P19: a private sync, its code masked and then shown', async ({ page }, testInfo) => {
  const sheet = await openSync(page, testInfo, PRIVATE_DEVICE)
  await expect(
    sheet.getByText(/^Private sync: what this device sends is encrypted here first\./),
  ).toBeVisible()
  await expect
    .poll(() => keysOf(relay.row(KAT_ROW)?.payload), { timeout: 30_000 })
    .toEqual(ENVELOPE_KEYS)
  await expect(sheet.getByText(KAT)).toHaveCount(0)
  await gate(page, testInfo)
  await sheet.getByRole('button', { name: 'Show code' }).click()
  await expect(sheet.getByRole('button', { name: 'Hide code' })).toBeVisible()
  await gate(page, testInfo)
})

test('AC-P19: fenced out of a sync that was made private: the code field, in place', async ({
  page,
}, testInfo) => {
  // the plain row already holds the marker another device left when it made sync private
  relay.put(PLAIN_CODE, {
    version: '4.0',
    expenses: 'moved',
    categories: [],
    x5: { min: 99, moved: { at: '2026-11-14T08:00:00.000Z', why: 'private' } },
  })
  const sheet = await openSync(page, testInfo, {
    syncId: PLAIN_CODE,
    expenses: JSON.stringify(RICH),
  })
  await expect(
    sheet
      .getByText('Sync was made private on your other device. Enter the new sync code shown there.')
      .first(),
  ).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByRole('textbox', { name: 'Sync code' })).toBeVisible()
  // one code on screen: the old one, which no device syncs with any more, is not shown
  await expect(sheet.getByRole('button', { name: 'Show code' })).toHaveCount(0)
  await expect(
    sheet.getByText(
      'No code? Use Disconnect at the bottom of this page, then start a new sync. Your entries stay on this device.',
    ),
  ).toBeVisible()
  // fenced for good: the marker is remembered, and the row is left as it is
  await expect
    .poll(async () => JSON.stringify((await syncState(page)).config))
    .toContain('"fenced"')
  expect(relay.pushes().filter((q) => q.syncId === PLAIN_CODE)).toEqual([])
  await gate(page, testInfo)
})

test('3.9, AC-P19: a copy marked newer: Replace asks first, then repairs it from this device', async ({
  page,
}, testInfo) => {
  relay.put(KAT_ROW, NEWER)
  const sheet = await openSync(page, testInfo, PRIVATE_DEVICE)
  const replace = sheet.getByRole('button', { name: 'Replace the synced copy' })
  await expect(replace).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
  // paused: the copy marked newer is not written over by the cycles that found it
  expect(relay.pushes().filter((q) => q.syncId === KAT_ROW)).toEqual([])
  expect(relay.row(KAT_ROW)?.payload).toEqual(NEWER)
  await gate(page, testInfo)

  await replace.click()
  const ask = sheet.getByRole('group', { name: "Replace the synced copy with this device's?" })
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await expect(ask).toContainText('Anything that is no longer on any of your devices is lost.')
  expect(relay.row(KAT_ROW)?.payload).toEqual(NEWER)
  await gate(page, testInfo)

  await ask.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(toasts(page).getByText('Synced copy replaced')).toBeVisible({ timeout: 30_000 })
  await expect(replace).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Sync now' })).toBeFocused()
  expect(keysOf(relay.row(KAT_ROW)?.payload)).toEqual(ENVELOPE_KEYS)
  const landed = relay.writes().filter((q) => q.syncId === KAT_ROW)
  expect(landed).toHaveLength(1)
  expect(landed[0]).toMatchObject({ kind: 'rpc', fn: 'st_sync_push', writer: 'e2e', force: false })
  expect(typeof landed[0]?.base).toBe('string')
})
