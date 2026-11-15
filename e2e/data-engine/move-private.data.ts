import { join } from 'node:path'
import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { FNV_A, FNV_B, fnvLane } from '../../src/data/core/hash'
import { serveBuild, startRelay, type Relay, type StaticHost } from './support/relayServer'
import {
  PORTS,
  build,
  closeAll,
  closeSettings,
  deleteEntry,
  itemNames,
  openDevice,
  openSettingsTab,
  quickAdd,
  syncState,
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

// PRIVATE-SYNC release 2 in real browsers: "Make sync private" on the flags build (the relay's
// sync functions, compare-and-set, and the lockdown applied), against the real releases before it.
//
// AC-M16: one device makes its plain sync private; the other, on the real 0.21.0 build, meets the
//   marker, fences, and joins with the typed code; edits flow both ways; the relay's log shows a
//   marker on the plain row and, after the move, envelopes only, on a derived row id. Chromium
//   and iPhone WebKit.
// AC-M17: the real 0.20.0 build (as deployed, with the sync flags on) meets the marker, pauses,
//   and never writes the plain row.
// AC-M18: the new states (the question, closing the old sync, the next-step line, contested, the
//   straggler notice, Disconnect's added warning) pass axe in both themes, with 44 px targets and no sideways scroll at 320 px
//   on the phone. The lockdown check refuses on a relay that still answers the table.
// ST5_SHOTS=<folder> also saves a screenshot of each state in each theme there.
// Invented data; the seeded private code is the codec's known-answer vector, never a real one.

/** The secret of bytes 00..0f (core/codes.test.ts), and what it derives (core/e2e.test.ts). */
const KAT = 'ST5-0004106-1050R3G-G28A1C6-0T3GFS3'
const KAT_ROW = 'e4555323-21f5-8f92-8c6a-97e208c0967b'
const PRIVATE_CODE = /^ST5(-[0-9A-HJKMNP-TV-Z]{7}){4}$/
const DERIVED_ROW = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ENVELOPE_KEYS = ['ct', 'iv', 'k', 'r', 'st', 'z']
const PLAIN_CODE = '5e5e5e5e-0e2e-4e2e-8e2e-0000000b0002'

// The engine's words (stores/syncEngine.ts) and the panel's (features/settings/SyncMove.tsx).
const QUESTION = 'Make sync private?'
const MOVED = 'Sync made private. Enter the new sync code on your other devices.'
const NEXT = 'Next: enter this code on your other devices. They stop syncing until you do.'
const CLOSING = 'Closing the old sync…'
const NOT_CLOSED = 'The old sync is not closed yet. This device keeps trying.'
const UNSAVED = /^This device couldn't save its note of the move/
const CONTESTED = /^Another device may also have made this sync private\./
const STRAGGLER =
  'Something was written to the old sync after it was closed. If a device of yours is still on it, update it and enter this sync code there.'
const LOCKDOWN =
  "This sync's server still allows direct reads. Make sync private after the database lockdown."
const FENCED = 'Sync was made private on your other device. Enter the new sync code shown there.'

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
/** The moved marker a payload is (`x5.moved`), or null. */
function markerOf(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || payload.expenses !== 'moved' || !isRecord(payload.x5)) return null
  return isRecord(payload.x5.moved) ? payload.x5.moved : null
}
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' })
/** A line of the panel as the eye sees it (its words are also in a live region). */
const shown = (sheet: Locator, text: string | RegExp) =>
  sheet.locator('[aria-hidden="true"]').getByText(text)

test.beforeAll(async () => {
  hostA = await serveBuild(PORTS.candidateA, build('candidate-flags'))
  hostB = await serveBuild(PORTS.candidateB, build('v021'))
  hostOld = await serveBuild(PORTS.v020, build('v020-flags'))
})

test.beforeEach(async () => {
  relay = await startRelay(PORTS.relay)
  // migration 004: the sync functions (compare-and-set writes)
  relay.enableRpc()
})

test.afterEach(async () => {
  await closeAll(devices)
  devices = []
  await relay.close()
})

test.afterAll(async () => {
  await hostA.close()
  await hostB.close()
  await hostOld.close()
})

/**
 * Makes `d`'s plain sync private through the real panel, once the engine offers it; resolves to
 * the new code read off the screen.
 */
async function makePrivateHere(d: Device): Promise<string> {
  const sheet = await openSettingsTab(d.page, 'Sync')
  const button = sheet.getByRole('button', { name: 'Make sync private' })
  // offered once every device in the registry has reported release 1 and the sync functions
  await expect(button).toBeVisible({ timeout: 60_000 })
  await button.click()
  const ask = sheet.getByRole('group', { name: QUESTION })
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await ask.getByRole('button', { name: 'Make private', exact: true }).click()
  await expect(toasts(d.page).getByText(MOVED)).toBeVisible({ timeout: 60_000 })
  await expect(sheet.getByRole('button', { name: 'Make sync private' })).toHaveCount(0)
  await expect(
    sheet.getByText(/^Private sync: what this device sends is encrypted here first\./),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Show code' }).click()
  const code = (await sheet.locator('span.select-all').innerText()).replace(/[^0-9A-Z-]/g, '')
  await sheet.getByRole('button', { name: 'Hide code' }).click()
  expect(code).toMatch(PRIVATE_CODE)
  return code
}

/** Two devices on the plain code, each holding both entries. */
async function plainPair(browser: Browser, hostOfB: StaticHost): Promise<{ a: Device; b: Device }> {
  const a = await openDevice(browser, hostA.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify([entry('m-a1', 'laptop kopi', '2026-11-10')]) },
  })
  devices.push(a)
  const b = await openDevice(browser, hostOfB.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify([entry('m-b1', 'phone taxi', '2026-11-11')]) },
  })
  devices.push(b)
  const both = ['laptop kopi', 'phone taxi']
  await expect.poll(() => itemNames(a.page), { timeout: 60_000 }).toEqual(both)
  await expect.poll(() => itemNames(b.page), { timeout: 60_000 }).toEqual(both)
  return { a, b }
}

test('AC-M16: one device makes sync private; 0.21.0 on the other fences, joins with the typed code, and edits flow both ways', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  // 005: the table refuses the public key, as the move requires
  relay.lockTable()
  const { a, b } = await plainPair(browser, hostB)
  await expect.poll(() => relay.writes(b.origin).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const since = Date.now()
  const code = await makePrivateHere(a)
  const sheetA = await openSettingsTab(a.page, 'Sync')
  await expect(shown(sheetA, NEXT)).toBeVisible()

  // the plain row holds this device's marker; the private row an envelope under a derived id
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 30_000 })
    .toMatchObject({ why: 'private' })
  expect(typeof markerOf(relay.row(PLAIN_CODE)?.payload)?.by).toBe('string')
  const rowOf = () =>
    relay
      .writes(a.origin, since)
      .map((q) => q.syncId ?? '')
      .find((id) => id !== PLAIN_CODE) ?? ''
  const row = rowOf()
  expect(row).toMatch(DERIVED_ROW)
  expect(keysOf(relay.row(row)?.payload)).toEqual(ENVELOPE_KEYS)

  // 0.21.0 meets the marker: fenced for good, with the code field in place of its old code
  const sheetB = await openSettingsTab(b.page, 'Sync')
  await expect(sheetB.getByText(FENCED).first()).toBeVisible({ timeout: 90_000 })
  await expect(sheetB.getByRole('textbox', { name: 'Sync code' })).toBeVisible()
  await expect(sheetB.getByRole('button', { name: 'Show code' })).toHaveCount(0)
  await expect
    .poll(async () => JSON.stringify((await syncState(b.page)).config))
    .toContain('"fenced"')

  // the code typed as a person types it, on 0.21.0's own Join
  await sheetB
    .getByRole('textbox', { name: 'Sync code' })
    .fill(code.toLowerCase().replaceAll('-', ' '))
  await sheetB.getByRole('button', { name: 'Join', exact: true }).click()
  const ask = sheetB.getByRole('group', { name: 'Join this sync?' })
  await expect(ask).toContainText('Synced: 2 entries')
  await ask.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(toasts(b.page).getByText('Joined. This device is synced.')).toBeVisible({
    timeout: 30_000,
  })

  // edits flow both ways
  await closeSettings(b.page)
  await quickAdd(b.page, 'phone teh 1.80')
  await expect.poll(() => itemNames(a.page), { timeout: 60_000 }).toContain('phone teh')
  await closeSettings(a.page)
  await quickAdd(a.page, 'laptop bao 2.40')
  await expect.poll(() => itemNames(b.page), { timeout: 60_000 }).toContain('laptop bao')

  // the next-step line goes once the other device has written to the private row
  const sheetA2 = await openSettingsTab(a.page, 'Sync')
  await expect(shown(sheetA2, NEXT)).toHaveCount(0, { timeout: 60_000 })

  // the relay since the move: on the plain row only this device's marker (0.21.0 never wrote
  // it again), every other write an envelope on the derived row, through the sync functions
  const landed = relay.writes(undefined, since)
  expect(landed.filter((q) => q.syncId === PLAIN_CODE && q.origin !== a.origin)).toEqual([])
  expect(landed.filter((q) => q.syncId === PLAIN_CODE).length).toBeGreaterThan(0)
  expect(
    landed.filter(
      (q) =>
        q.syncId !== PLAIN_CODE &&
        (q.syncId !== row || q.kind !== 'rpc' || q.fn !== 'st_sync_push' || q.writer !== 'e2e'),
    ),
  ).toEqual([])
  expect(landed.filter((q) => q.syncId === row && q.origin === b.origin).length).toBeGreaterThan(0)
  expect(markerOf(relay.row(PLAIN_CODE)?.payload)).toMatchObject({ why: 'private' })
  expect(keysOf(relay.row(row)?.payload)).toEqual(ENVELOPE_KEYS)
  const seen = JSON.stringify([relay.log, relay.row(row), relay.row(PLAIN_CODE), relay.topics()])
  for (const secret of [code, code.replaceAll('-', ''), 'phone teh', 'laptop bao']) {
    expect(seen, `the relay never sees "${secret}"`).not.toContain(secret)
  }
})

test('AC-M17: the real 0.20.0 build meets the marker, pauses, and never writes the old row', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  relay.lockTable()
  // the mover alone on the plain row (a device not seen yet does not hold the offer back)
  const a = await openDevice(browser, hostA.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify([entry('o-a1', 'laptop kopi', '2026-11-10')]) },
  })
  devices.push(a)
  await makePrivateHere(a)
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 30_000 })
    .toMatchObject({ why: 'private' })
  const marker = JSON.stringify(relay.row(PLAIN_CODE))

  // 0.20.0, as deployed (the sync functions), still on the plain code
  const old = await openDevice(browser, hostOld.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify([entry('o-o1', 'old taxi', '2026-11-11')]) },
  })
  devices.push(old)
  const sheet = await openSettingsTab(old.page, 'Sync')
  await expect(sheet.getByText('This device runs SpendTrack 0.20.0')).toBeVisible()
  await expect(sheet.getByText(/Sync moved to a newer version/).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(sheet.getByRole('button', { name: 'Reload', exact: true }).first()).toBeVisible()
  // an entry made there stays there: the old row is never written
  await closeSettings(old.page)
  await quickAdd(old.page, 'old bun 1.20')
  await old.page.waitForTimeout(5000)
  expect(relay.pushes(old.origin)).toEqual([])
  expect(JSON.stringify(relay.row(PLAIN_CODE))).toBe(marker)
  expect(await itemNames(old.page)).toEqual(['old bun', 'old taxi'])
  expect(JSON.stringify(relay.log)).not.toContain('old bun')
})

// ─── AC-M18: the new states, through the accessibility gate ──────────────────────────────────

const softly = expect.configure({ soft: true })

/** Saves the page as `name` in ST5_SHOTS, when it is set (outside the repository). */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.ST5_SHOTS
  if (dir === undefined || dir === '') return
  await page.screenshot({ path: join(dir, `${name}-${testInfo.project.name}.png`) })
}

/** Screenshots only, in both themes (a state too short-lived for the whole gate). */
async function shots(page: Page, testInfo: TestInfo, name: string) {
  await shoot(page, testInfo, `${name}-dark`)
  await switchTheme(page, 'light')
  await shoot(page, testInfo, `${name}-light`)
  await switchTheme(page, 'dark')
}

/** axe in both themes, and on the phone the target audit and 320 px. */
async function gate(page: Page, testInfo: TestInfo, name: string) {
  await settle(page)
  await shoot(page, testInfo, `${name}-dark`)
  softly(await axeViolations(page), 'axe, dark theme').toEqual([])
  await switchTheme(page, 'light')
  await shoot(page, testInfo, `${name}-light`)
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

/**
 * Settings › Sync on the flags build, dark theme and reduced motion, after seeding `keys`;
 * `first` runs once the app is up, before Settings opens.
 */
async function openSync(
  page: Page,
  testInfo: TestInfo,
  keys: Record<string, string>,
  first?: () => Promise<void>,
) {
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
  await first?.()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  await sheet.getByRole('tab', { name: 'Sync', exact: true }).click()
  return sheet
}

/**
 * A device that made the known-answer code's sync private from `PLAIN_CODE` (its key and the
 * move's record, as the switch leaves them), with the record's fields `over`.
 */
function movedDevice(over: Record<string, unknown>): Record<string, string> {
  const fingerprint = [FNV_A, FNV_B]
    .map((lane) => fnvLane(KAT_ROW, lane).toString(36).padStart(7, '0'))
    .join('')
  return {
    'st5:synckey': JSON.stringify({ code: KAT, at: 1, established: true }),
    'st5:synckey:move': JSON.stringify({
      v: 1,
      for: fingerprint,
      from: PLAIN_CODE,
      at: Date.now(),
      phase: 'retiring',
      absorbed: null,
      retired: null,
      checkedAt: null,
      conflicts: 0,
      contested: false,
      ...over,
    }),
    expenses: JSON.stringify(RICH),
  }
}

test('AC-M18: the question, the next step, and a write to the old sync after it closed', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  const sheet = await openSync(page, testInfo, {
    syncId: PLAIN_CODE,
    expenses: JSON.stringify(RICH),
  })
  const button = sheet.getByRole('button', { name: 'Make sync private' })
  await expect(button).toBeVisible({ timeout: 60_000 })
  await expect(sheet.getByText("This sync isn't encrypted.", { exact: false })).toBeVisible()

  // before the lockdown the move refuses, with nothing changed
  const before = Date.now()
  await button.click()
  await sheet
    .getByRole('group', { name: QUESTION })
    .getByRole('button', { name: 'Make private', exact: true })
    .click()
  await expect(toasts(page).getByText(LOCKDOWN)).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeFocused()
  expect(
    relay.writes(undefined, before).filter((q) => q.syncId !== PLAIN_CODE),
    'no private row made',
  ).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('st5:synckey'))).toBeNull()
  await expect(toasts(page).getByText(LOCKDOWN)).toHaveCount(0, { timeout: 20_000 })

  // the question, with the age of the last backup and Export beside it
  relay.lockTable()
  await button.click()
  const ask = sheet.getByRole('group', { name: QUESTION })
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await expect(ask).toContainText('No backup downloaded yet')
  await expect(sheet.getByRole('button', { name: 'Export backup' })).toBeVisible()
  await gate(page, testInfo, 'm18-question')
  await ask.getByRole('button', { name: 'Export backup' }).scrollIntoViewIfNeeded()
  await shots(page, testInfo, 'm18-question-export')

  // made private: busy while it runs (its first sync of the old row held a moment), then the
  // code, and the next step while no other device has it
  const release = relay.holdReads(PLAIN_CODE)
  await ask.getByRole('button', { name: 'Make private', exact: true }).click()
  const busy = sheet.getByRole('button', { name: 'Making sync private…' })
  await expect(busy).toBeFocused({ timeout: 10_000 })
  await expect.poll(() => relay.heldReads(), { timeout: 10_000 }).toBeGreaterThan(0)
  await shots(page, testInfo, 'm18-busy')
  release()
  await expect(toasts(page).getByText(MOVED)).toBeVisible({ timeout: 60_000 })
  await expect(sheet.getByRole('button', { name: 'Sync now' })).toBeFocused()
  await expect(shown(sheet, NEXT)).toBeVisible()
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 30_000 })
    .toMatchObject({ why: 'private' })
  await expect(toasts(page).getByText(MOVED)).toHaveCount(0, { timeout: 20_000 })
  await gate(page, testInfo, 'm18-next')

  // someone writes the old row over its marker: retired again, not merged, and said
  relay.put(PLAIN_CODE, {
    version: '4.0',
    expenses: [entry('s-1', 'straggler kopi', '2026-11-12')],
    categories: [],
  })
  await sheet.getByRole('button', { name: 'Sync now' }).click()
  await expect(shown(sheet, STRAGGLER)).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 30_000 })
    .toMatchObject({ why: 'private' })
  expect(await itemNames(page)).not.toContain('straggler kopi')
  await expect(toasts(page).getByText('Synced', { exact: true })).toHaveCount(0, {
    timeout: 20_000,
  })
  await gate(page, testInfo, 'm18-straggler')
})

test('AC-M18: closing the old sync (a move resumed after a reload, its old row slow to answer)', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  relay.lockTable()
  // the old row's reads wait: the resumed step 5 is caught while it closes the old sync
  const release = relay.holdReads(PLAIN_CODE)
  const sheet = await openSync(page, testInfo, movedDevice({ phase: 'retiring' }), async () => {
    await expect.poll(() => relay.heldReads(), { timeout: 30_000 }).toBeGreaterThan(0)
  })
  await expect(shown(sheet, CLOSING)).toBeVisible({ timeout: 10_000 })
  await expect(shown(sheet, NEXT)).toBeVisible()
  await gate(page, testInfo, 'm18-closing')
  // the held read runs out: not closed yet, and the device keeps trying
  await expect(shown(sheet, NOT_CLOSED)).toBeVisible({ timeout: 60_000 })
  await expect(shown(sheet, CLOSING)).toHaveCount(0)
  await gate(page, testInfo, 'm18-not-closed')
  release()
  await sheet.getByRole('button', { name: 'Sync now' }).click()
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 60_000 })
    .toMatchObject({ why: 'private' })
  await expect(shown(sheet, NOT_CLOSED)).toHaveCount(0, { timeout: 30_000 })
  await expect(shown(sheet, NEXT)).toBeVisible()
})

test('AC-M18: a note of the move this device could not save', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  relay.lockTable()
  // storage that takes the move's first note, then refuses it and has lost it after the switch
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    let notes = 0
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'st5:synckey:move' && ++notes > 1) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      set.call(this, key, value)
    }
    Storage.prototype.getItem = function (key: string) {
      if (key === 'st5:synckey:move' && get.call(this, 'st5:synckey') !== null) return null
      return get.call(this, key)
    }
  })
  const sheet = await openSync(page, testInfo, {
    syncId: PLAIN_CODE,
    expenses: JSON.stringify(RICH),
  })
  await sheet.getByRole('button', { name: 'Make sync private' }).click({ timeout: 60_000 })
  await sheet
    .getByRole('group', { name: QUESTION })
    .getByRole('button', { name: 'Make private', exact: true })
    .click()
  await expect(toasts(page).getByText(MOVED)).toBeVisible({ timeout: 60_000 })
  await expect(shown(sheet, UNSAVED)).toBeVisible()
  await expect(toasts(page).getByText(MOVED)).toHaveCount(0, { timeout: 20_000 })
  await gate(page, testInfo, 'm18-unsaved')
})

test('AC-M18: a fenced device joins, and the preview counts what it deleted for the others', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  relay.lockTable()
  const both = [entry('j-1', 'shared kopi', '2026-11-10'), entry('j-2', 'shared bun', '2026-11-11')]
  // the private sync, holding both entries
  const mover = await openDevice(browser, hostA.origin, {
    syncCode: null,
    seed: {
      'st5:synckey': JSON.stringify({ code: KAT, at: 1, established: true }),
      expenses: JSON.stringify(both),
    },
  })
  devices.push(mover)
  await expect
    .poll(() => keysOf(relay.row(KAT_ROW)?.payload), { timeout: 30_000 })
    .toEqual(ENVELOPE_KEYS)
  // a device still on the plain code, fenced by the marker, deletes one of them meanwhile
  relay.put(PLAIN_CODE, {
    version: '4.0',
    expenses: 'moved',
    categories: [],
    x5: { min: 99, moved: { at: '2026-11-14T08:00:00.000Z', why: 'private' } },
  })
  const fenced = await openDevice(browser, hostA.origin, {
    syncCode: PLAIN_CODE,
    seed: { expenses: JSON.stringify(both) },
  })
  devices.push(fenced)
  const page = fenced.page
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect
    .poll(async () => JSON.stringify((await syncState(page)).config), { timeout: 30_000 })
    .toContain('"fenced"')
  await deleteEntry(page, 'shared bun')
  await expect.poll(() => itemNames(page)).toEqual(['shared kopi'])
  const sheet = await openSettingsTab(page, 'Sync')
  await sheet.getByRole('textbox', { name: 'Sync code' }).fill(KAT)
  await sheet.getByRole('button', { name: 'Join', exact: true }).click()
  const ask = sheet.getByRole('group', { name: 'Join this sync?' })
  await expect(ask).toContainText(
    '1 entry deleted on this device is removed from your other devices when you join.',
  )
  await gate(page, testInfo, 'm18-join-preview')
})

test('AC-M18: contested: another device may also have made this sync private', async ({
  page,
}, testInfo) => {
  relay.lockTable()
  const sheet = await openSync(page, testInfo, movedDevice({ phase: 'retired', contested: true }))
  await expect(shown(sheet, CONTESTED)).toBeVisible({ timeout: 30_000 })
  await expect(shown(sheet, NEXT)).toBeVisible()
  // the contested device keeps its private sync, and keeps the old row closed
  await expect
    .poll(() => keysOf(relay.row(KAT_ROW)?.payload), { timeout: 30_000 })
    .toEqual(ENVELOPE_KEYS)
  await expect
    .poll(() => markerOf(relay.row(PLAIN_CODE)?.payload), { timeout: 30_000 })
    .toMatchObject({ why: 'private' })
  await gate(page, testInfo, 'm18-contested')
  // Disconnect's question adds that nobody else has the code yet
  await sheet.getByRole('button', { name: /Disconnect sync/ }).click()
  const ask = sheet.getByRole('group', { name: 'Disconnect sync on this device?' })
  await expect(ask).toContainText(
    "No other device has this sync code yet. A device waiting for it can't join without it.",
  )
  await gate(page, testInfo, 'm18-disconnect')
})
