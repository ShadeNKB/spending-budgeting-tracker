import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import {
  dialog,
  expectGone,
  isPhone,
  manyRows,
  openPalette,
  row,
  seed,
  storedExpenses,
  waitForApp,
  type SeedExpense,
} from './support/a11y'

// A press that changes what is under the pointer ends its gesture (src/ui/pressShield.ts). The
// second press of a double click or a double tap on Save, Add, Cancel, Close, the backdrop, a
// palette option or a calendar day used to land on whatever the change put there: on /ledger a
// row's trash (an unrelated expense deleted), on a phone a tab of the TabBar, under the
// calendar a category chip (the expense saved under the wrong category), on the toast that just
// appeared its Undo. Real presses: Chromium at 1280 px with a mouse (a double click, and two
// clicks 120 ms apart), WebKit (iPhone) at 375 px with two taps. Invented data, Singapore clock.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  test.slow(isPhone(testInfo), 'WebKit')
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

type Press = 'a double click' | 'two clicks 120 ms apart' | 'two taps 120 ms apart'

const pressesFor = (testInfo: TestInfo): readonly Press[] =>
  isPhone(testInfo) ? ['two taps 120 ms apart'] : ['a double click', 'two clicks 120 ms apart']

/** Both presses of the gesture at the middle of `target`, the way the device sends them. */
async function doublePress(page: Page, target: Locator, how: Press) {
  const box = await target.boundingBox()
  if (!box) throw new Error('nothing to press')
  await doublePressAt(page, box.x + box.width / 2, box.y + box.height / 2, how)
}

async function doublePressAt(page: Page, x: number, y: number, how: Press) {
  if (how === 'a double click') {
    await page.mouse.dblclick(x, y)
  } else if (how === 'two clicks 120 ms apart') {
    await page.mouse.click(x, y)
    await page.waitForTimeout(120)
    await page.mouse.click(x, y)
  } else {
    await page.touchscreen.tap(x, y)
    await page.waitForTimeout(120)
    await page.touchscreen.tap(x, y)
  }
  // Whatever the second press reached has had time to act.
  await page.waitForTimeout(800)
}

/** A plain press: a click with the mouse, a tap on the phone. */
async function press(target: Locator, testInfo: TestInfo) {
  if (isPhone(testInfo)) await target.tap()
  else await target.click()
}

const SIXTY = manyRows(60)

/**
 * Both motion settings. Under Reduce Motion (the shared seed's) a closed sheet or palette leaves
 * the page at once; with motion, as most people have it, it stays for its exit (up to 400 ms),
 * inert, and a press passes through it to the page: the second press must still land nowhere.
 */
const MOTIONS = ['reduce', 'no-preference'] as const
type Motion = (typeof MOTIONS)[number]
const motionName = (motion: Motion) => (motion === 'reduce' ? 'Reduce Motion' : 'with motion')

async function load(
  page: Page,
  path: string,
  expenses: readonly SeedExpense[],
  motion: Motion = 'reduce',
) {
  await seed(page, { expenses })
  await page.emulateMedia({ reducedMotion: motion })
  await page.goto(path)
  await waitForApp(page)
}

/** The Edit sheet of a row near the top of the list (the page under it is all rows). */
async function openEdit(page: Page, testInfo: TestInfo, item = 'row 0003') {
  // As a person does, after seeing the list: on a phone the last save's toast can sit over the
  // row (toast placement is T7's), and a press within a double tap's time of the one that
  // closed the last sheet, or of the toast leaving that spot, is swallowed.
  await expect(page.locator('[data-toast]')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(500)
  await press(page.getByRole('button', { name: new RegExp(`^Edit ${item},`) }), testInfo)
  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  // A person reads the sheet before pressing in it.
  await page.waitForTimeout(600)
  return sheet
}

/** Nothing open, nothing gone, and still on the screen the press began on. */
async function expectUntouched(page: Page, path: string, count: number, what: string) {
  await expectGone(page.getByRole('dialog'), `${what}: no layer open`)
  expect((await storedExpenses(page)).length, `${what}: no expense deleted or added`).toBe(count)
  expect(new URL(page.url()).pathname, `${what}: same screen`).toBe(path)
}

type Busy = 'in its task' | 'after it'

/**
 * Keeps the page busy for `ms` on the next click, as a long list re-rendering after Save does on
 * a slow phone: in the click's own task, before the app handles it (the sheet then closes long
 * after the click was handled), or in a task right after it. A press made meanwhile waits in
 * the queue and is handled long after it was made. Returns the clicks that reach the page from
 * then on (the controls they land on): a swallowed press reaches none of it.
 */
async function busyOnNextClick(
  page: Page,
  ms: number,
  when: Busy,
): Promise<() => Promise<string[]>> {
  await page.evaluate(
    ([busy, inTask]) => {
      const reached: string[] = []
      Reflect.set(window, '__e2eReached', reached)
      window.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null
        const control = target?.closest('button, a, [role]')
        reached.push(control?.getAttribute('aria-label') ?? control?.textContent?.trim() ?? '')
      })
      const work = () => {
        const end = performance.now() + busy
        while (performance.now() < end) {
          // nothing else runs meanwhile
        }
      }
      window.addEventListener(
        'click',
        () => {
          if (inTask) work()
          else setTimeout(work, 0)
        },
        { capture: true, once: true },
      )
    },
    [ms, when === 'in its task'] as const,
  )
  return () => page.evaluate(() => Reflect.get(window, '__e2eReached') as string[])
}

for (const motion of MOTIONS) {
  test.describe(`The second press of a double press lands nowhere (${motionName(motion)})`, () => {
    for (const [control, find] of [
      ['Save changes', (s: Locator) => s.getByRole('button', { name: 'Save changes' })],
      ['Cancel', (s: Locator) => s.getByRole('button', { name: 'Cancel', exact: true })],
      ['Close', (s: Locator) => s.getByRole('button', { name: 'Close', exact: true })],
    ] as const) {
      test(`Edit sheet ${control}: no row under it is deleted or opened`, async ({
        page,
      }, testInfo) => {
        await load(page, '/ledger', SIXTY, motion)
        for (const how of pressesFor(testInfo)) {
          const sheet = await openEdit(page, testInfo)
          await doublePress(page, find(sheet), how)
          await expectUntouched(page, '/ledger', SIXTY.length, `${control}, ${how}`)
        }
      })
    }

    // The second press is handled 700 ms after the first, past the gesture's time by the page's
    // clock, yet made 120 ms after it: judged by when it was made, it still lands nowhere. Busy in
    // the click's own task, the sheet closes 700 ms after the click was handled: still the
    // click's doing.
    for (const when of ['in its task', 'after it'] as const) {
      test(`Edit sheet Save on a page busy ${when}: the second press lands nowhere`, async ({
        page,
      }, testInfo) => {
        await load(page, '/ledger', SIXTY, motion)
        const sheet = await openEdit(page, testInfo)
        const reached = await busyOnNextClick(page, 700, when)
        const how = isPhone(testInfo) ? 'two taps 120 ms apart' : 'two clicks 120 ms apart'
        await doublePress(page, sheet.getByRole('button', { name: 'Save changes' }), how)
        await expectUntouched(page, '/ledger', SIXTY.length, `Save, busy ${when}, ${how}`)
        // Wherever it fell (a row, its trash, the space between), the second press reached nothing.
        expect(await reached(), 'clicks that reached the page').toEqual(['Save changes'])
      })
    }

    test('Edit sheet backdrop: the header or row under it is not pressed', async ({
      page,
    }, testInfo) => {
      await load(page, '/ledger', SIXTY, motion)
      for (const how of pressesFor(testInfo)) {
        const sheet = await openEdit(page, testInfo)
        const box = await sheet.boundingBox()
        const viewport = page.viewportSize()
        if (!box || !viewport) throw new Error('no sheet box')
        // Beside a side sheet (over the rows), or above a bottom sheet (over the header's Settings).
        const spot = box.y > 40 ? { x: viewport.width - 24, y: box.y / 2 } : { x: 200, y: 400 }
        const backdrop = await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.hasAttribute('data-sheet-backdrop') ?? false,
          spot,
        )
        expect(backdrop, `${how}: the spot is on the backdrop`).toBe(true)
        await doublePressAt(page, spot.x, spot.y, how)
        await expectUntouched(page, '/ledger', SIXTY.length, `backdrop, ${how}`)
      }
    })

    // One page load per test: each starts from a fresh page. (With framer-motion, a reload in the
    // same page under Playwright's fixed clock left exits scheduled in the future, and a closed
    // sheet stayed for seconds; the CSS exits since have a cap, but a fresh page stays the rule.)
    for (const path of ['/ledger', '/pulse']) {
      test(`Add sheet Add on ${path}: the entry is added once and stays (the toast’s Undo is not pressed)`, async ({
        page,
      }, testInfo) => {
        await load(page, path, SIXTY, motion)
        let count = SIXTY.length
        for (const how of pressesFor(testInfo)) {
          // The last add's toast sits over the sheet's Add on a laptop (toast placement is T7's):
          // a press on it there is the toast's, so each add starts with none on screen.
          await expect(page.locator('[data-toast]')).toHaveCount(0, { timeout: 10_000 })
          if (isPhone(testInfo))
            await page.getByRole('button', { name: 'Add expense', exact: true }).tap()
          else await page.keyboard.press('Control+n')
          const sheet = dialog(page, 'Add expense')
          await expect(sheet).toBeVisible()
          await sheet.getByRole('textbox', { name: 'What' }).fill(`coffee ${how}`)
          await sheet.getByRole('spinbutton', { name: 'Amount' }).fill('4.50')
          await page.waitForTimeout(600)
          await doublePress(page, sheet.getByRole('button', { name: 'Add', exact: true }), how)
          count += 1
          await expectUntouched(page, path, count, `Add, ${how}`)
          expect((await storedExpenses(page))[0]?.itemName, how).toBe(`coffee ${how}`)
        }
      })
    }

    test('a palette option: it runs once, and nothing on the next screen is pressed', async ({
      page,
    }, testInfo) => {
      await load(page, '/ledger', SIXTY, motion)
      for (const how of pressesFor(testInfo)) {
        if (new URL(page.url()).pathname !== '/ledger') {
          // In the app, not by a reload (see the Add test).
          await press(
            page
              .getByRole('link', { name: 'Ledger', exact: true })
              .filter({ visible: true })
              .first(),
            testInfo,
          )
          await expect(page.getByRole('heading', { level: 1, name: 'Ledger' })).toBeVisible()
        }
        const palette = await openPalette(page)
        await page.waitForTimeout(600)
        await doublePress(page, palette.getByRole('option', { name: /^Go to Pulse/ }), how)
        await expectUntouched(page, '/pulse', SIXTY.length, `Go to Pulse, ${how}`)
        expect(new URL(page.url()).search, `Go to Pulse, ${how}: no filter opened`).toBe('')
      }
    })

    test('a palette option that opens a sheet: the sheet stays open and untouched', async ({
      page,
    }, testInfo) => {
      await load(page, '/ledger', SIXTY, motion)
      for (const how of pressesFor(testInfo)) {
        const palette = await openPalette(page)
        await page.waitForTimeout(600)
        await doublePress(page, palette.getByRole('option', { name: /^Add expense/ }), how)
        const sheet = dialog(page, 'Add expense')
        await expect(sheet, how).toBeVisible()
        await expect(sheet.getByRole('textbox', { name: 'What' }), how).toHaveValue('')
        await expect(sheet.locator('[aria-pressed="true"]'), how).toHaveText(['Today'])
        await page.keyboard.press('Escape')
        await expectGone(sheet)
      }
    })
  })
}

// A slow double click (the second press past the gesture's time, inside the system's
// double-click time) whose second press lands on the row that the closed sheet uncovered. Its
// mousedown and click are swallowed by their click count, but its pointerdown got through and
// started the row's drag: the pointerup must reach the row too, or the row follows the mouse
// with no button held and the next click leaves its swipe Delete out.
for (const motion of MOTIONS) {
  test.describe(`A slow double click on Save over the ledger (${motionName(motion)})`, () => {
    test('leaves the row under its second press where it was, Delete hidden', async ({
      page,
    }, testInfo) => {
      test.skip(isPhone(testInfo), 'a mouse double click')
      await load(page, '/ledger', SIXTY, motion)
      const sheet = await openEdit(page, testInfo)
      const box = await sheet.getByRole('button', { name: 'Save changes' }).boundingBox()
      if (!box) throw new Error('no Save')
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down({ clickCount: 1 })
      await page.mouse.up({ clickCount: 1 })
      await page.waitForTimeout(450)
      const under = await page.evaluate(
        ([px, py]) =>
          document.elementFromPoint(px ?? 0, py ?? 0)?.closest('[data-ledger-row]') !== null,
        [x, y],
      )
      expect(under, 'a ledger row is under the second press').toBe(true)
      await page.mouse.down({ clickCount: 2 })
      await page.mouse.up({ clickCount: 2 })
      for (let step = 1; step <= 15; step++) await page.mouse.move(x - step * 12, y)
      await page.waitForTimeout(200)
      const heading = await page.getByRole('heading', { level: 1, name: 'Ledger' }).boundingBox()
      if (!heading) throw new Error('no heading')
      await page.mouse.click(heading.x + 5, heading.y + 5)
      await page.waitForTimeout(500)
      const moved = await page.evaluate(() =>
        [...document.querySelectorAll('[data-ledger-row] *')]
          .filter(
            (el) => !/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(el).transform),
          )
          .map((el) => el.closest('[data-ledger-row]')?.getAttribute('data-ledger-row')),
      )
      expect(moved, 'rows moved off their place').toEqual([])
      const shown = await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-swipe-delete]')].filter(
            (el) => Number(getComputedStyle(el).opacity) > 0,
          ).length,
      )
      expect(shown, 'swipe Delete actions showing').toBe(0)
      await expectUntouched(page, '/ledger', SIXTY.length, 'slow double click on Save')
    })
  })
}

test.describe('A double press on a calendar day picks the day and nothing else', () => {
  /** October 2026, a day from each week row (later days are past today, the 18th). */
  const DAYS = [
    ['Thursday, October 1, 2026', 'Oct 1'],
    ['Wednesday, October 7, 2026', 'Oct 7'],
    ['Tuesday, October 13, 2026', 'Oct 13'],
    ['Friday, October 16, 2026', '2d ago'],
    ['Sunday, October 18, 2026', 'Today'],
  ] as const

  const pressOf = (testInfo: TestInfo): Press =>
    isPhone(testInfo) ? 'two taps 120 ms apart' : 'a double click'

  test('in the Add sheet: no category chip toggles, the form keeps what was typed', async ({
    page,
  }, testInfo) => {
    test.slow(true, 'five days, each in a fresh sheet')
    await load(page, '/pulse', [])
    for (const [day, shown] of DAYS) {
      if (isPhone(testInfo))
        await page.getByRole('button', { name: 'Add expense', exact: true }).tap()
      else await page.keyboard.press('Control+n')
      const sheet = dialog(page, 'Add expense')
      await expect(sheet).toBeVisible()
      await sheet.getByRole('textbox', { name: 'What' }).fill('picker probe')
      await page.waitForTimeout(400)
      const presets = sheet.getByRole('group', { name: 'Date' })
      await press(presets.getByRole('button', { name: /Pick date|Change date/ }), testInfo)
      const picker = dialog(page, 'Choose date')
      await expect(picker).toBeVisible()
      await page.waitForTimeout(600)
      await doublePress(page, picker.getByRole('button', { name: day }), pressOf(testInfo))
      await expectGone(picker, day)
      await expect(sheet, day).toBeVisible()
      const chips = sheet.getByRole('group', { name: 'Category' })
      await expect(chips.locator('[aria-pressed="true"]'), `${day}: no chip chosen`).toHaveCount(0)
      await expect(sheet.getByRole('textbox', { name: 'What' }), day).toHaveValue('picker probe')
      await expect(sheet.getByRole('spinbutton', { name: 'Amount' }), day).toHaveValue('')
      // The day is the one chosen: a preset says so, or the calendar pill does.
      if (shown === 'Today' || shown === '2d ago')
        await expect(presets.getByRole('button', { name: shown, exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
      else
        await expect(
          presets.getByRole('button', { name: new RegExp(`${shown}, 2026$`) }),
        ).toBeVisible()
      await page.keyboard.press('Escape')
      await expectGone(sheet)
    }
    expect(await storedExpenses(page)).toEqual([])
  })

  test('in the Edit sheet: Save keeps the expense’s category', async ({ page }, testInfo) => {
    test.slow(true, 'five days, each saved and its toast waited out')
    const probe = row('probe', '2026-10-17', 3.5, 'probe kopi', 'Food & Dining')
    const others = manyRows(8)
    await load(page, '/ledger', [probe, ...others])
    for (const [day] of DAYS) {
      const sheet = await openEdit(page, testInfo, 'probe kopi')
      const dates = sheet.getByRole('group', { name: 'Date' })
      await press(dates.getByRole('button', { name: /Pick date|Change date/ }), testInfo)
      const picker = dialog(page, 'Choose date')
      await expect(picker).toBeVisible()
      await page.waitForTimeout(600)
      await doublePress(page, picker.getByRole('button', { name: day }), pressOf(testInfo))
      await expectGone(picker, day)
      const chips = sheet.getByRole('group', { name: 'Category' })
      await expect(chips.locator('[aria-pressed="true"]'), day).toHaveText(['Food & Dining'])
      await press(sheet.getByRole('button', { name: 'Save changes' }), testInfo)
      await expectGone(sheet, day)
      const saved = (await storedExpenses(page)).find((e) => e.id === 'probe')
      expect(saved?.category, `${day}: category kept`).toBe('Food & Dining')
      expect(saved?.itemName, day).toBe('probe kopi')
    }
  })
})
