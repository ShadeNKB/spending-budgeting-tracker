import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  RICH,
  RICH_BUDGETS,
  STATES,
  THEMES,
  TODAY,
  dialog,
  enterState,
  expectGone,
  isPhone,
  manyRows,
  obscuredWalk,
  openAddSheet,
  openEditSheet,
  openPalette,
  openSettings,
  quickAdd,
  ringProblems,
  searchButton,
  seed,
  settle,
  storedExpenses,
  switchTheme,
  tabWalk,
  transformFrames,
  waitForApp,
  type SeedOptions,
  type UiState,
} from './support/a11y'

// Keyboard, focus and screen-reader behaviour that axe cannot see (T6 spec §4, §6): one modal
// layer stack (initial focus, trap, Escape, focus return), the date picker grid, the palette
// combobox, ledger rows, forms and confirmations, live regions, the heatmap and chart sliders,
// and the focus ring / target / obscured-focus audits. Both projects unless a test says why not.
// Invented data on a fixed Singapore clock, reduced motion.

declare global {
  interface Window {
    /** expectTrapped: focus that landed outside the layer, and how to stop recording it. */
    __e2eTrap?: { outside: string[]; stop: () => void }
    __e2eLive?: {
      regions: Element[]
      keyAt: number
      /** When the first toast was drawn. */
      toastAt: number
      seen: { index: number; text: string; at: number }[]
    }
  }
}

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  // WebKit draws every step of these walks more slowly, and here it can hold a closing sheet's
  // fade for seconds (see settle in support/a11y.ts): the phone gets three times the time.
  test.slow(isPhone(testInfo), 'WebKit')
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

// ─── helpers ──────────────────────────────────────────────────────────────────

async function load(page: Page, path: string, opts: SeedOptions = {}) {
  await seed(page, { expenses: RICH, budgets: RICH_BUDGETS, ...opts })
  await page.goto(path)
  await waitForApp(page)
}

/** Keyboard activation: the control has focus when it opens a layer, as for a keyboard user. */
async function activate(page: Page, target: Locator) {
  await target.focus()
  await page.keyboard.press('Enter')
}

async function expectFocusBack(page: Page, target: Locator, what: string) {
  await expect(target, `${what}: focus back on the control`).toBeFocused()
  await page.waitForTimeout(600)
  await expect(target, `${what}: still there 600 ms later`).toBeFocused()
}

/** Clicks the backdrop beside or above the layer. */
async function clickBackdrop(page: Page, layer: Locator) {
  const box = await layer.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('no layer box')
  if (box.y > 40) await page.mouse.click(viewport.width / 2, Math.max(4, box.y / 2))
  else await page.mouse.click(Math.max(4, box.x / 2), viewport.height / 2)
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

const inside = (layer: Locator) => layer.evaluate((el) => el.contains(document.activeElement))

/**
 * Tab and Shift+Tab, one full cycle and two more each way, never leave the layer: every focus
 * that lands outside it, even for a moment before the layer pulls it back, is recorded.
 */
async function expectTrapped(page: Page, layer: Locator, what: string) {
  const count = await layer.evaluate((el, selector) => {
    const outside: string[] = []
    const watch = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && !el.contains(target))
        outside.push(`${target.tagName.toLowerCase()} ${target.getAttribute('aria-label') ?? ''}`)
    }
    document.addEventListener('focusin', watch, true)
    window.__e2eTrap = {
      outside,
      stop: () => {
        document.removeEventListener('focusin', watch, true)
      },
    }
    return [...el.querySelectorAll(selector)].filter(
      (n) => n.getClientRects().length > 0 && n.getAttribute('tabindex') !== '-1',
    ).length
  }, TABBABLE)
  expect(count, `${what}: has tab stops`).toBeGreaterThan(0)
  for (const key of ['Tab', 'Shift+Tab'])
    for (let i = 0; i < count + 2; i++) await page.keyboard.press(key)
  const outside = await page.evaluate(() => {
    const trap = window.__e2eTrap
    if (!trap) return ['(no trap record)']
    trap.stop()
    return trap.outside
  })
  expect(outside, `${what}: focus that left the layer`).toEqual([])
  expect(await inside(layer), `${what}: focus ends inside`).toBe(true)
}

/** The day key of the focused heatmap cell (the cell or the button in it). */
const focusedDay = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest('[data-day]')?.getAttribute('data-day') ?? null,
  )

const focused = (page: Page) => page.locator(':focus')

/** The focused element's aria-label ('' when focus is on <body>). */
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')

const mainHeading = (page: Page, name: string) =>
  page.getByRole('main').getByRole('heading', { name, level: 1 })

/** Moves focus with Tab (or Shift+Tab) until `target` has it. */
async function tabTo(page: Page, target: Locator, backwards = false) {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab')
  }
  throw new Error('Tab never reached the control')
}

const pen = (page: Page) =>
  page.getByRole('button', { name: 'Full entry form' }).filter({ visible: true }).first()

// ─── the modal layer stack (AC-L1 … AC-L5, AC-S1, AC-S3) ──────────────────────

test.describe('Modal layers', () => {
  test('AC-L1: Ctrl+N, type, Tab, amount, Enter: every key lands, focus comes back', async ({
    page,
  }) => {
    await load(page, '/pulse')
    // Open and close once: the lazy sheet is then mounted, as after the app goes idle.
    await page.keyboard.press('Control+n')
    await expect(dialog(page, 'Add expense')).toBeVisible()
    await page.keyboard.press('Escape')
    await expectGone(dialog(page, 'Add expense'))

    const search = searchButton(page)
    await search.focus()
    await page.keyboard.press('Control+n')
    await page.keyboard.type('Coffee')
    await page.keyboard.press('Tab')
    await page.keyboard.type('4.50')
    await page.keyboard.press('Enter')
    await expectGone(dialog(page, 'Add expense'))
    await expectFocusBack(page, search, 'Ctrl+N from Search')

    // From <body>: focus lands on the screen's heading.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Control+n')
    await page.keyboard.type('Teh tarik')
    await page.keyboard.press('Tab')
    await page.keyboard.type('1.80')
    await page.keyboard.press('Enter')
    await expectGone(dialog(page, 'Add expense'))
    await expect(page.locator('main h1')).toBeFocused()

    await expect
      .poll(async () =>
        (await storedExpenses(page))
          .filter((e) => e.itemName === 'Coffee' || e.itemName === 'Teh tarik')
          .map((e) => [e.itemName, e.amount])
          .sort(),
      )
      .toEqual([
        ['Coffee', 4.5],
        ['Teh tarik', 1.8],
      ])
  })

  // A browser tab keeps Ctrl+N for a new window; only an installed app receives it (Playwright's
  // keys reach the page below the browser's own shortcuts, so that cannot be shown here). Alt+N
  // opens the same sheet, from a text field too.
  test('AC-L1: Alt+N opens Add expense too, from the page and from the quick add', async ({
    page,
  }) => {
    await load(page, '/pulse')
    const sheet = dialog(page, 'Add expense')
    await page.keyboard.press('Alt+n')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('textbox', { name: 'What' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expectGone(sheet)

    await quickAdd(page).focus()
    await page.keyboard.press('Alt+n')
    await expect(sheet).toBeVisible()
    await page.keyboard.type('Kaya toast')
    await expect(sheet.getByRole('textbox', { name: 'What' })).toHaveValue('Kaya toast')
    await expect(quickAdd(page)).toHaveValue('')
  })

  interface Opener {
    title: string
    /** Only on this project (the + button and the TabBar exist on phones only). */
    only?: 'mobile' | 'chromium'
    path: string
    trigger: (page: Page) => Locator
    /** Where focus must come back to (default: the trigger). */
    back?: (page: Page) => Locator
    open: (page: Page, trigger: Locator) => Promise<Locator>
    closes: readonly ('Escape' | 'Close' | 'Cancel' | 'Save' | 'backdrop')[]
  }

  const openWith =
    (name: string) =>
    async (page: Page, trigger: Locator): Promise<Locator> => {
      await activate(page, trigger)
      const layer = dialog(page, name)
      await expect(layer).toBeVisible()
      return layer
    }

  const OPENERS: readonly Opener[] = [
    {
      title: 'the + button',
      only: 'mobile',
      path: '/pulse',
      trigger: (page) => page.getByRole('button', { name: 'Add expense', exact: true }),
      open: openWith('Add expense'),
      closes: ['Escape', 'Close', 'Cancel', 'Save', 'backdrop'],
    },
    {
      title: 'the quick-add pen',
      path: '/pulse',
      trigger: pen,
      open: openWith('Add expense'),
      closes: ['Escape', 'Cancel', 'Save', 'backdrop'],
    },
    {
      title: 'Settings in the top bar',
      path: '/pulse',
      trigger: (page) => page.getByRole('button', { name: 'Settings', exact: true }),
      open: openWith('Settings'),
      closes: ['Escape', 'Close', 'backdrop'],
    },
    {
      title: 'Settings in the tab bar',
      only: 'mobile',
      path: '/pulse',
      trigger: (page) => page.getByRole('button', { name: 'Open settings', exact: true }),
      open: openWith('Settings'),
      closes: ['Close', 'backdrop'],
    },
    {
      title: '"Add expense" in the palette',
      path: '/pulse',
      trigger: searchButton,
      back: searchButton,
      open: async (page, trigger) => {
        await activate(page, trigger)
        const palette = dialog(page, 'Command palette')
        await expect(palette.getByRole('combobox')).toBeFocused()
        await expect(palette.getByRole('option', { name: /^Add expense/ })).toHaveAttribute(
          'aria-selected',
          'true',
        )
        await page.keyboard.press('Enter')
        const sheet = dialog(page, 'Add expense')
        await expect(sheet).toBeVisible()
        await expectGone(palette)
        return sheet
      },
      closes: ['Escape', 'Cancel'],
    },
    {
      title: 'a ledger row',
      path: '/ledger',
      trigger: (page) => page.getByRole('button', { name: /^Edit / }).nth(2),
      open: openWith('Edit expense'),
      closes: ['Escape', 'Close', 'Cancel', 'Save', 'backdrop'],
    },
  ]

  for (const opener of OPENERS) {
    test(`AC-L2: focus returns to ${opener.title} however the layer closes`, async ({
      page,
    }, testInfo) => {
      test.skip(
        opener.only !== undefined && testInfo.project.name !== opener.only,
        `${opener.only ?? ''} only`,
      )
      await load(page, opener.path)
      const trigger = opener.trigger(page)
      // A ledger row keeps its name; resolve it once so the row is found again after a save.
      const name = (await trigger.getAttribute('aria-label')) ?? ''
      const target = name ? page.getByRole('button', { name, exact: true }) : trigger
      const back = opener.back?.(page) ?? target
      for (const how of opener.closes) {
        const layer = await opener.open(page, target)
        if (how === 'Escape') await page.keyboard.press('Escape')
        if (how === 'Close') await layer.getByRole('button', { name: 'Close', exact: true }).click()
        if (how === 'Cancel')
          await layer.getByRole('button', { name: 'Cancel', exact: true }).first().click()
        if (how === 'backdrop') await clickBackdrop(page, layer)
        if (how === 'Save') {
          const add = layer.getByRole('button', { name: /^Add( for |$)/ })
          if ((await add.count()) > 0) {
            await layer.getByLabel('What').fill('focus test')
            await layer.getByLabel('Amount').fill('3')
            await add.click()
          } else {
            await layer.getByRole('button', { name: 'Save changes' }).click()
          }
        }
        await expectGone(layer, `${how} closes it`)
        await expectFocusBack(page, back, `${opener.title} → ${how}`)
      }
    })
  }

  test('AC-L2: a row its editor moved to another day gets focus back where it now is', async ({
    page,
  }) => {
    await load(page, '/ledger')
    // A row from 16-18 Oct, moved to "3d ago" (15 Oct, a day with nothing on it): it is drawn
    // as a new element in a new day group, and the element that opened the editor is gone.
    const row = page.getByRole('button', { name: /^Edit / }).nth(2)
    const name = (await row.getAttribute('aria-label')) ?? ''
    // The row's name ends with its day ("…, Social & Leisure, Oct 17"): moved, it is "…, Oct 15".
    const movedName = name.replace(/, [A-Z][a-z]{2} \d{1,2}$/, ', Oct 15')
    expect(movedName, 'the name ends with the day').not.toBe(name)
    await expect(row).not.toContainText('Oct 15')
    await row.evaluate((el) => el.setAttribute('data-e2e-opener', ''))
    await activate(page, row)
    const edit = dialog(page, 'Edit expense')
    await expect(edit).toBeVisible()
    await edit
      .getByRole('group', { name: 'Date' })
      .getByRole('button', { name: '3d ago', exact: true })
      .click()
    await edit.getByRole('button', { name: 'Save changes' }).click()
    await expectGone(edit)
    await expect(page.locator('[data-e2e-opener]')).toHaveCount(0)
    const moved = page.getByRole('button', { name: movedName, exact: true })
    await expect(moved).toContainText('Oct 15')
    await expectFocusBack(page, moved, 'row moved to 15 Oct')
  })

  test('AC-L2: when the opener leaves with the layout, focus lands on the screen heading', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'a laptop window, widened past the phone layout')
    await page.setViewportSize({ width: 375, height: 812 })
    await load(page, '/pulse')
    const plus = page.getByRole('button', { name: 'Add expense', exact: true })
    await activate(page, plus)
    const add = dialog(page, 'Add expense')
    await expect(add).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 800 }) // the tab bar and its + go away
    await expect(plus).toBeHidden()
    await page.keyboard.press('Escape')
    await expectGone(add)
    await expectFocusBack(page, page.locator('main h1'), 'opener hidden by the wider layout')
  })

  test('AC-L3: re-renders behind an open sheet never move focus; a typed space stays text', async ({
    page,
    context,
  }) => {
    await load(page, '/pulse')
    // A quick add first: its toast and its 6 s undo window are still running behind the sheet.
    await quickAdd(page).fill('kopi 1.80')
    await quickAdd(page).press('Enter')
    await expect(
      page
        .getByRole('region', { name: 'Notifications' })
        .getByText('Added "kopi" · S$1.80', { exact: true }),
    ).toBeVisible()

    await activate(page, pen(page))
    const sheet = dialog(page, 'Add expense')
    const what = sheet.getByLabel('What')
    await expect(what).toBeFocused()
    await page.keyboard.type('Coffee')
    await context.setOffline(true) // the shell re-renders with the offline banner
    await page.keyboard.type(' latte')
    await page.evaluate(() => window.dispatchEvent(new Event('spendtrack:quota-exceeded')))
    await page.waitForTimeout(6500) // the quick add's undo window expires
    await page.keyboard.type(' x')
    await expect(what).toBeFocused()
    await expect(what).toHaveValue('Coffee latte x')
    await expect(sheet).toBeVisible()
    await context.setOffline(false)

    // A settings change re-themes the whole app behind the sheet (Settings opened over it).
    await page.keyboard.press('Control+,')
    const settings = dialog(page, 'Settings')
    await expect(settings).toBeVisible()
    await settings
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Light' })
      .click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.keyboard.press('Escape')
    await expectGone(settings)
    await expect(what).toBeFocused()
    await page.keyboard.type(' ok')
    await expect(what).toHaveValue('Coffee latte x ok')
    await expect(sheet).toBeVisible()
  })

  test.describe('AC-L4: Tab and Shift+Tab never leave the top layer', () => {
    test('the Add sheet and the date picker over it', async ({ page }, testInfo) => {
      await load(page, '/pulse')
      const add = await openAddSheet(page, testInfo)
      await expectTrapped(page, add, 'Add')
      await activate(page, add.getByRole('button', { name: 'Pick date' }))
      const picker = dialog(page, 'Choose date')
      await expect(picker).toBeVisible()
      await expectTrapped(page, picker, 'date picker')
    })

    test('every Settings section', async ({ page }) => {
      await load(page, '/pulse')
      const settings = await openSettings(page)
      for (const tab of ['Categories', 'Budgets', 'Backup', 'Sync']) {
        await settings.getByRole('tab', { name: tab, exact: true }).click()
        await expectTrapped(page, settings, `Settings ${tab}`)
      }
    })

    test('the shortcuts sheet, the palette and the Edit sheet', async ({ page }) => {
      await load(page, '/pulse')
      await page.locator('body').press('?')
      const shortcuts = dialog(page, 'Keyboard shortcuts')
      await expect(shortcuts).toBeVisible()
      await expectTrapped(page, shortcuts, 'Keyboard shortcuts')
      await page.keyboard.press('Escape')
      await expectGone(shortcuts)

      const palette = await openPalette(page)
      await palette.getByRole('combobox').fill('ko')
      await expectTrapped(page, palette, 'palette')
      await page.keyboard.press('Escape')
      await expectGone(palette)

      await page.goto('/ledger')
      await waitForApp(page)
      const edit = await openEditSheet(page)
      await expectTrapped(page, edit, 'Edit')
    })
  })

  test('AC-L5: Escape closes only the top layer and the form keeps its values', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')

    // The date picker over the Add sheet.
    let sheet = await openAddSheet(page, testInfo)
    await sheet.getByLabel('What').fill('kopi')
    await sheet.getByLabel('Amount').fill('2')
    const pill = sheet.getByRole('button', { name: 'Pick date' })
    await activate(page, pill)
    const picker = dialog(page, 'Choose date')
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expectGone(picker)
    await expect(sheet).toBeVisible()
    await expect(pill).toBeFocused()
    await expect(sheet.getByLabel('What')).toHaveValue('kopi')
    await expect(sheet.getByLabel('Amount')).toHaveValue('2')
    await page.keyboard.press('Escape')
    await expectGone(sheet)

    // The palette over the Add sheet (Ctrl+K from a control in the sheet).
    sheet = await openAddSheet(page, testInfo)
    await sheet.getByLabel('What').fill('teh')
    const yesterday = sheet.getByRole('button', { name: 'Yesterday', exact: true })
    await yesterday.focus()
    await page.keyboard.press('Control+k')
    const palette = dialog(page, 'Command palette')
    const combobox = palette.getByRole('combobox')
    await expect(combobox).toBeFocused()
    // Over the sheet, not behind it: the palette's field is what a tap there reaches.
    expect(
      await combobox.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return hit !== null && (hit === el || el.contains(hit))
      }),
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expectGone(palette)
    await expect(sheet).toBeVisible()
    await expect(yesterday).toBeFocused()
    await expect(sheet.getByLabel('What')).toHaveValue('teh')

    // Settings over the Add sheet (Ctrl+,).
    await page.keyboard.press('Control+,')
    const settings = dialog(page, 'Settings')
    await expect(settings).toBeVisible()
    await page.keyboard.press('Escape')
    await expectGone(settings)
    await expect(sheet).toBeVisible()
    await expect(yesterday).toBeFocused()
    await page.keyboard.press('Escape')
    await expectGone(sheet)
  })

  test('AC-S1: sheets open on their field or on the dialog, never on Close', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')

    const add = await openAddSheet(page, testInfo)
    await expect(add.getByLabel('What')).toBeFocused()
    // One dialog element, a plain div: no complementary landmark, no second banner.
    expect(await add.evaluate((el) => el.tagName)).toBe('DIV')
    await expect(add.locator('aside, header')).toHaveCount(0)
    await page.keyboard.press('Escape')

    const settings = await openSettings(page)
    await expect(settings).toBeFocused()
    await page.keyboard.press('Escape')

    await page.keyboard.press('?')
    const shortcuts = dialog(page, 'Keyboard shortcuts')
    await expect(shortcuts).toBeFocused()
    await page.keyboard.press('Escape')

    await page.goto('/ledger')
    await waitForApp(page)
    const edit = await openEditSheet(page)
    // A laptop types at once; a phone does not pop its keyboard over the sheet.
    if (isPhone(testInfo)) await expect(edit).toBeFocused()
    else await expect(edit.getByLabel('Item', { exact: true })).toBeFocused()
    await expect(edit.getByRole('button', { name: 'Close' })).not.toBeFocused()
  })

  test('AC-S3, AC-M1, AC-A3: with reduced motion sheets, the palette and toasts never slide', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')
    expect(
      await transformFrames(page, '[role="dialog"]', async () => {
        await openAddSheet(page, testInfo)
      }),
      'Add sheet opening',
    ).toEqual([])
    expect(
      await transformFrames(page, '[role="dialog"]', async () => {
        await page.keyboard.press('Escape')
      }),
      'Add sheet closing',
    ).toEqual([])
    expect(
      await transformFrames(page, '[role="dialog"]', async () => {
        await openPalette(page)
      }),
      'palette opening',
    ).toEqual([])
    expect(
      await transformFrames(page, '[role="dialog"]', async () => {
        await page.keyboard.press('Escape')
      }),
      'palette closing',
    ).toEqual([])
    expect(
      await transformFrames(page, '[role="region"][aria-label="Notifications"] > *', async () => {
        await quickAdd(page).fill('kopi 1.20')
        await quickAdd(page).press('Enter')
        await expect(
          page
            .getByRole('region', { name: 'Notifications' })
            .getByText('Added "kopi" · S$1.20', { exact: true }),
        ).toBeVisible()
      }),
      'toast',
    ).toEqual([])
  })

  test('AC-M1: with reduced motion a released swipe snaps back at once', async ({
    page,
  }, testInfo) => {
    test.skip(!isPhone(testInfo), 'the swipe is the phone gesture')
    await load(page, '/ledger')
    const target = page.getByRole('button', { name: /^Edit / }).nth(1)
    const box = await target.boundingBox()
    if (!box) throw new Error('row has no box')
    const tagged = await target.evaluate((el) => {
      let row: Element | null = el
      while (row && !row.querySelector('[data-swipe-delete]')) row = row.parentElement
      row?.setAttribute('data-e2e-row', '')
      return row !== null
    })
    expect(tagged, 'the row around the button').toBe(true)
    // A slow 40 px drag (well short of the 76 px that reveals Delete, and far below the flick
    // speed that does): the release must put the row straight back.
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(box.x + box.width / 2 - step * 10, y)
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(150) // the pointer rests: no fling left in the gesture
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-e2e-row] *')].some(
          (el) => !/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(el).transform),
        ),
      ),
      'the row follows the finger',
    ).toBe(true)
    const frames = await transformFrames(
      page,
      '[data-e2e-row], [data-e2e-row] *',
      async () => {
        await page.mouse.up()
      },
      300,
    )
    // At most the frames the release lands in still show the drag (one or two positions); a
    // spring back would pass through a run of ever smaller offsets, ~20 frames of them.
    expect(new Set(frames).size, frames.join(' | ')).toBeLessThanOrEqual(2)
    expect(frames.length, frames.join(' | ')).toBeLessThanOrEqual(3)
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-e2e-row] *')].every((el) =>
            /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(el).transform),
          ),
        ),
      )
      .toBe(true)
  })
})

// ─── the date picker (AC-D1, AC-D2, AC-D4) ────────────────────────────────────

/** [key, focused day's name, month heading after the key] */
type Step = readonly [string, string, string?]

async function walkPicker(page: Page, picker: Locator, steps: readonly Step[]) {
  for (const [key, name, heading] of steps) {
    await page.keyboard.press(key)
    await expect(focused(page), `${key} → ${name}`).toHaveAccessibleName(name)
    if (heading) await expect(picker.getByRole('heading', { level: 2 })).toHaveText(heading)
  }
}

test.describe('Date picker by keyboard', () => {
  test('AC-D1: arrows, Home/End, PageUp/PageDown and Shift step calendar days, clamped to today', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')
    const sheet = await openAddSheet(page, testInfo)
    const pill = sheet.getByRole('button', { name: 'Pick date' })
    await activate(page, pill)
    const picker = dialog(page, 'Choose date')
    await expect(picker).toBeVisible()
    await expect(focused(page)).toHaveAccessibleName('Sunday, October 18, 2026')
    await expect(picker.getByRole('heading', { level: 2 })).toHaveText('October 2026')
    await expect(picker.getByRole('button', { name: 'Next month, November 2026' })).toBeDisabled()
    await expect(
      picker.getByRole('button', { name: 'Previous month, September 2026' }),
    ).toBeEnabled()
    await expect(picker.getByRole('grid')).toBeVisible()
    await expect(picker.locator('[aria-current="date"]')).toHaveCount(1)

    await walkPicker(page, picker, [
      ['ArrowRight', 'Sunday, October 18, 2026'], // today is the latest day
      ['ArrowLeft', 'Saturday, October 17, 2026'],
      ['ArrowUp', 'Saturday, October 10, 2026'],
      ['Home', 'Sunday, October 4, 2026'],
      ['End', 'Saturday, October 10, 2026'],
      ['ArrowDown', 'Saturday, October 17, 2026'],
      ['ArrowDown', 'Sunday, October 18, 2026'], // Oct 24 is after today: clamped
      ['PageUp', 'Friday, September 18, 2026', 'September 2026'],
      ['Shift+PageUp', 'Thursday, September 18, 2025', 'September 2025'],
    ])
    for (let i = 0; i < 8; i++) await page.keyboard.press('PageUp')
    await expect(focused(page)).toHaveAccessibleName('Saturday, January 18, 2025')
    await expect(picker.getByRole('heading', { level: 2 })).toHaveText('January 2025')
    await walkPicker(page, picker, [
      ['ArrowDown', 'Saturday, January 25, 2025'],
      ['ArrowDown', 'Saturday, February 1, 2025', 'February 2025'],
      ['ArrowLeft', 'Friday, January 31, 2025', 'January 2025'],
      ['PageDown', 'Friday, February 28, 2025', 'February 2025'], // Jan 31 → the month's last day
      ['Shift+PageDown', 'Saturday, February 28, 2026', 'February 2026'],
      ['Shift+PageUp', 'Friday, February 28, 2025', 'February 2025'],
      ['Shift+PageUp', 'Wednesday, February 28, 2024', 'February 2024'],
      ['ArrowRight', 'Thursday, February 29, 2024'],
      ['Shift+PageDown', 'Friday, February 28, 2025', 'February 2025'], // no Feb 29 in 2025
      ['PageUp', 'Tuesday, January 28, 2025', 'January 2025'],
      ['PageUp', 'Saturday, December 28, 2024', 'December 2024'],
      ['ArrowRight', 'Sunday, December 29, 2024'],
      ['ArrowRight', 'Monday, December 30, 2024'],
      ['ArrowRight', 'Tuesday, December 31, 2024'],
      ['ArrowRight', 'Wednesday, January 1, 2025', 'January 2025'],
      ['ArrowLeft', 'Tuesday, December 31, 2024', 'December 2024'],
    ])
    await expect(
      picker.getByRole('button', { name: 'Previous month, November 2024' }),
    ).toBeEnabled()
    await expect(picker.getByRole('button', { name: 'Next month, January 2025' })).toBeEnabled()

    // Enter picks the day, closes the calendar and hands focus back to the pill.
    await page.keyboard.press('Enter')
    await expectGone(picker)
    const chosen = sheet.getByRole('button', { name: 'Change date, selected Dec 31, 2024' })
    await expect(chosen).toBeFocused()
    await expect(sheet).toContainText('Logging for Tuesday, December 31, 2024')

    // Reopened, it starts on the chosen day (marked selected); Space picks too.
    await page.keyboard.press('Enter')
    await expect(focused(page)).toHaveAccessibleName('Tuesday, December 31, 2024')
    await expect(picker.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(1)
    await expect(
      picker.locator('[role="gridcell"][aria-selected="true"]').getByRole('button'),
    ).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Space')
    await expectGone(picker)
    const second = sheet.getByRole('button', { name: 'Change date, selected Dec 30, 2024' })
    await expect(second).toBeFocused()

    // Escape closes without a change, focus on the pill.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Escape')
    await expectGone(picker)
    await expect(sheet).toBeVisible()
    await expect(second).toBeFocused()
  })

  for (const { zone, now, today, before, monthBack } of [
    {
      zone: 'Pacific/Honolulu',
      now: new Date('2026-10-18T09:30:00Z'), // 23:30 on Sat 17 Oct in Honolulu
      today: 'Saturday, October 17, 2026',
      before: 'Friday, October 16, 2026',
      monthBack: 'Wednesday, September 16, 2026',
    },
    {
      zone: 'Pacific/Kiritimati',
      now: new Date('2026-10-18T10:30:00Z'), // 00:30 on Mon 19 Oct at UTC+14
      today: 'Monday, October 19, 2026',
      before: 'Sunday, October 18, 2026',
      monthBack: 'Friday, September 18, 2026',
    },
  ]) {
    test.describe(zone, () => {
      test.use({ timezoneId: zone })

      test(`AC-D1: in ${zone} the calendar opens on the local today and steps local days`, async ({
        page,
      }, testInfo) => {
        await load(page, '/pulse', { now })
        const sheet = await openAddSheet(page, testInfo)
        await activate(page, sheet.getByRole('button', { name: 'Pick date' }))
        const picker = dialog(page, 'Choose date')
        await expect(focused(page)).toHaveAccessibleName(today)
        await walkPicker(page, picker, [
          ['ArrowRight', today],
          ['ArrowLeft', before],
          ['ArrowRight', today],
          ['ArrowLeft', before],
          ['PageUp', monthBack, 'September 2026'],
        ])
      })
    })
  }

  test('AC-D2: the Ledger custom range: Enter opens the calendar in the grid, Escape closes only it', async ({
    page,
  }) => {
    await load(page, '/ledger?range=custom')
    const from = page.getByRole('button', { name: /^From, / })
    await activate(page, from)
    const fromPicker = dialog(page, /^Choose From date/)
    await expect(fromPicker).toBeVisible()
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="grid"]') !== null),
    ).toBe(true)
    await expect(focused(page)).toHaveAccessibleName('Sunday, October 18, 2026')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expectGone(fromPicker)
    await expect(
      page.getByRole('button', { name: 'From, Change date, selected Oct 11, 2026' }),
    ).toBeFocused()
    await expect(page).toHaveURL(/customStart=2026-10-11/)

    // To: the start date is the earliest it allows.
    const to = page.getByRole('button', { name: /^To, / })
    await activate(page, to)
    const toPicker = dialog(page, /^Choose To date/)
    await expect(focused(page)).toHaveAccessibleName('Sunday, October 18, 2026')
    await walkPicker(page, toPicker, [
      ['ArrowUp', 'Sunday, October 11, 2026'],
      ['ArrowLeft', 'Sunday, October 11, 2026'], // clamped at the start date
      ['Home', 'Sunday, October 11, 2026'],
    ])
    await page.keyboard.press('Escape')
    await expectGone(toPicker)
    await expect(to).toBeFocused()
    await expect(to).not.toHaveAccessibleName(/selected/)
    await expect(page).toHaveURL(/range=custom/)
  })

  test('AC-D4: at 375 and 320 px the calendar stays on screen, with thumb-sized days', async ({
    page,
  }, testInfo) => {
    const sizes = [
      { width: 375, height: 812 },
      { width: 320, height: 640 },
    ] as const
    /** Opens the calendar at each phone size in turn: it is placed for the size it opens at. */
    const atEachSize = async (where: string, openPicker: () => Promise<void>) => {
      for (const size of sizes) {
        await page.setViewportSize(size)
        await openPicker()
        const picker = page.getByRole('dialog', { name: /^Choose / })
        await expect(picker).toBeVisible()
        await settle(page)
        const box = await picker.boundingBox()
        if (!box) throw new Error('no calendar box')
        const at = `${where} at ${String(size.width)} px`
        expect(box.x, `${at}: left`).toBeGreaterThanOrEqual(7.5)
        expect(box.y, `${at}: top`).toBeGreaterThanOrEqual(7.5)
        expect(box.x + box.width, `${at}: right`).toBeLessThanOrEqual(size.width - 7.5)
        expect(box.y + box.height, `${at}: bottom`).toBeLessThanOrEqual(size.height - 7.5)
        const day = await picker.getByRole('gridcell').getByRole('button').first().boundingBox()
        const min = size.width >= 360 ? 44 : 40
        expect(day?.width ?? 0, `${at}: day width`).toBeGreaterThanOrEqual(min)
        expect(day?.height ?? 0, `${at}: day height`).toBeGreaterThanOrEqual(min)
        await page.keyboard.press('Escape')
        await expectGone(picker)
      }
    }

    await page.setViewportSize(sizes[0])
    await load(page, '/pulse')
    const add = await openAddSheet(page, testInfo)
    await atEachSize('Add sheet', () => add.getByRole('button', { name: 'Pick date' }).click())
    await page.keyboard.press('Escape')
    await expectGone(add)

    await page.setViewportSize(sizes[0])
    await page.goto('/ledger')
    await waitForApp(page)
    const edit = await openEditSheet(page)
    await atEachSize('Edit sheet', () =>
      edit
        .getByRole('group', { name: 'Date' })
        .getByRole('button', { name: /date/i })
        .last()
        .click(),
    )
    await page.keyboard.press('Escape')
    await expectGone(edit)

    await page.setViewportSize(sizes[0])
    await page.goto('/ledger?range=custom')
    await waitForApp(page)
    await atEachSize('Ledger', () => page.getByRole('button', { name: /^To, / }).click())
  })
})

// ─── the command palette (AC-P1, AC-P2) ───────────────────────────────────────

/**
 * The options that are active (`aria-selected`) or drawn as active (their ::before bar shows).
 * `meets`: the bar is 3:1 or more against the option's own fill and against an inactive
 * option's (the palette's surface), each composited over that surface.
 */
const optionMarks = (palette: Locator) =>
  palette.getByRole('option').evaluateAll((els) => {
    type Rgba = { r: number; g: number; b: number; a: number }
    const parse = (value: string): Rgba => {
      const [r = 0, g = 0, b = 0, a = 1] = (/rgba?\(([^)]+)\)/.exec(value)?.[1] ?? '')
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number)
      return { r, g, b, a }
    }
    const over = (top: Rgba, under: Rgba): Rgba => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    })
    const lum = ({ r, g, b }: Rgba) => {
      const f = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (x: Rgba, y: Rgba) => {
      const [hi = 0, lo = 0] = [lum(x), lum(y)].sort((p, q) => q - p)
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    const dialog = els[0]?.closest('[role="dialog"]')
    const surface = parse(dialog ? getComputedStyle(dialog).backgroundColor : '')
    // Playwright finds the options and reads them in two steps: an option the search's deferred
    // render took away in between is gone, not unmarked.
    return els.flatMap((el) => {
      if (!el.isConnected) return []
      const before = getComputedStyle(el, '::before')
      const bar = before.display !== 'none' && before.content !== 'none'
      const selected = el.getAttribute('aria-selected') === 'true'
      if (!bar && !selected) return []
      const own = over(parse(getComputedStyle(el).backgroundColor), surface)
      const mark = over(parse(before.backgroundColor), own)
      const againstOwn = ratio(mark, own)
      const againstInactive = ratio(mark, surface)
      return [
        {
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          selected,
          bar,
          contrast: `${String(againstOwn)}:1 on its fill, ${String(againstInactive)}:1 on the list`,
          meets: againstOwn >= 3 && againstInactive >= 3,
        },
      ]
    })
  })

/** The one active option, drawn as such, starting with `text`. */
const marked = (text: RegExp) => [
  expect.objectContaining({
    text: expect.stringMatching(text),
    selected: true,
    bar: true,
    meets: true,
  }),
]

test.describe('Command palette', () => {
  test('AC-P1: a combobox whose active option follows the arrows; Enter runs exactly it', async ({
    page,
  }) => {
    await load(page, '/pulse')
    await activate(page, searchButton(page))
    const palette = dialog(page, 'Command palette')
    const combobox = palette.getByRole('combobox', {
      name: 'Search actions and expenses, or quick add',
    })
    await expect(combobox).toBeFocused()
    await expect(combobox).toHaveAttribute('aria-expanded', 'true')
    await expect(combobox).toHaveAttribute('aria-autocomplete', 'list')
    const listboxId = (await combobox.getAttribute('aria-controls')) ?? ''
    await expect(palette.locator(`[id="${listboxId}"]`)).toHaveAttribute('role', 'listbox')
    await expect(palette.getByRole('group', { name: 'Actions' })).toBeVisible()

    const active = async () => {
      const id = (await combobox.getAttribute('aria-activedescendant')) ?? ''
      return palette.locator(`[id="${id}"]`)
    }
    await expect(await active()).toHaveAccessibleName(/^Add expense/)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const third = await active()
    await expect(third).toHaveAttribute('role', 'option')
    await expect(third).toHaveAttribute('aria-selected', 'true')
    await expect(third).toHaveAccessibleName(/^Go to Ledger/)
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1)
    // The highlight is drawn on that option and no other.
    const looks = await palette.getByRole('option').evaluateAll(async (els) => {
      await Promise.all(
        els.flatMap((el) => el.getAnimations().map((a) => a.finished.catch(() => undefined))),
      )
      return els.map((el) => ({
        selected: el.getAttribute('aria-selected') === 'true',
        background: getComputedStyle(el).backgroundColor,
      }))
    })
    const highlighted = looks.filter((l) => l.selected).map((l) => l.background)
    expect(highlighted).toHaveLength(1)
    expect(looks.filter((l) => !l.selected).map((l) => l.background)).not.toContain(highlighted[0])

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/ledger$/)
    await expectGone(palette)
  })

  // A tint alone (1.07:1 dark, 1.11:1 light) left the option Enter runs all but invisible, and
  // the amber large-amount option looked active when it was not. The active option carries a
  // bar in the focus colour: 3:1 or more against its own fill and against an inactive option's.
  test('AC-P1: the active option is marked at 3:1 in both themes, whatever its tone', async ({
    page,
  }) => {
    await load(page, '/pulse', { theme: 'system' })
    const palette = await openPalette(page)
    const combobox = palette.getByRole('combobox')
    for (const theme of THEMES) {
      await switchTheme(page, theme)
      await combobox.fill('')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      expect(await optionMarks(palette), `${theme}: actions`).toEqual(marked(/^Go to Ledger/))
      await combobox.fill('kopi')
      await expect(palette.getByRole('group', { name: 'Expenses' })).toBeVisible()
      await page.keyboard.press('ArrowDown')
      expect(await optionMarks(palette), `${theme}: expenses`).toEqual(marked(/kopi/i))

      await combobox.fill('tv 4500')
      await page.keyboard.press('Enter')
      await expect(palette.getByRole('option', { name: /^Confirm large amount/ })).toBeVisible()
      // The expense search has caught up with the new query.
      await expect(palette.getByRole('group', { name: 'Expenses' })).toHaveCount(0)
      expect(await optionMarks(palette), `${theme}: the large amount`).toEqual(
        marked(/^Confirm large amount/),
      )
      // The amber option keeps its tint once it is no longer the one Enter runs: the bar moves.
      await page.keyboard.press('ArrowDown')
      expect(await optionMarks(palette), `${theme}: past the large amount`).toEqual(
        marked(/^Add expense/),
      )
    }
  })

  test('AC-P1: pressing on an option keeps focus in the field until the action runs', async ({
    page,
  }) => {
    await load(page, '/pulse')
    const palette = await openPalette(page)
    const option = palette.getByRole('option', { name: /^Go to Insights/ })
    await option.hover()
    await page.mouse.down()
    await expect(palette.getByRole('combobox')).toBeFocused()
    await page.mouse.up()
    await expect(page).toHaveURL(/\/insights$/)
  })

  test('AC-P2: Tab moves only between the field and Clear', async ({ page }) => {
    await load(page, '/pulse')
    const palette = await openPalette(page)
    const combobox = palette.getByRole('combobox')
    await combobox.fill('ko')
    const clear = palette.getByRole('button', { name: 'Clear command search' })
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      const onField = await combobox.evaluate((el) => el === document.activeElement)
      const onClear = await clear.evaluate((el) => el === document.activeElement)
      expect(onField || onClear, `Tab ×${String(i + 1)}`).toBe(true)
    }
  })
})

// ─── ledger rows (AC-R1 … AC-R3) ──────────────────────────────────────────────

const rowButtons = (page: Page) => page.getByRole('button', { name: /^Edit row / })
const rowName = async (row: Locator) =>
  ((await row.getAttribute('aria-label')) ?? '').split(',')[0]?.slice(5) ?? ''

/**
 * Waits until the virtual list has drawn the row after the focused one. Tab scrolls the focused
 * row into view and the list draws the rows the scroll uncovers a frame later: a person's next
 * Tab comes after that (key repeat is ~30 a second), a test's comes at once.
 */
const nextRowDrawn = (page: Page) =>
  page.waitForFunction(() => {
    const active = document.activeElement
    const rows = [...document.querySelectorAll('button[aria-label^="Edit row "]')]
    const at = active ? rows.indexOf(active) : -1
    return at < 0 || at < rows.length - 1
  })

test.describe('Ledger rows', () => {
  test('AC-R1: each row is one tab stop with one Delete button and nothing hidden focusable', async ({
    page,
  }) => {
    const rows29 = manyRows(29)
    await load(page, '/ledger', { expenses: rows29 })
    const rows = rowButtons(page)
    await expect(rows).toHaveCount(29)
    await rows.first().focus()
    for (let i = 1; i < 29; i++) {
      await page.keyboard.press('Tab')
      await expect(rows.nth(i), `Tab ×${String(i)}`).toBeFocused()
    }
    await page.keyboard.press('Tab')
    expect(await focusedLabel(page)).not.toMatch(/^Edit row /)

    // "Delete row 0003, S$4.25, Oct 15": the item, its amount and its day.
    for (const e of rows29) {
      await expect(
        page.getByRole('button', {
          name: new RegExp(`^Delete ${e.itemName}, S\\$[\\d.]+, \\w{3} \\d+$`),
        }),
      ).toHaveCount(1)
    }
    const hiddenStops = await page.evaluate((selector) => {
      const hidden = (el: Element) => {
        if (el.closest('[aria-hidden="true"]')) return true
        for (let n: Element | null = el; n; n = n.parentElement)
          if (getComputedStyle(n).opacity === '0') return true
        return false
      }
      return [...document.querySelectorAll(selector)]
        .filter((el) => el.getAttribute('tabindex') !== '-1' && hidden(el))
        .map((el) => el.outerHTML.slice(0, 120))
    }, TABBABLE)
    expect(hiddenStops).toEqual([])
  })

  test('AC-R2: Delete removes the focused row once and focus moves to the next row', async ({
    page,
  }) => {
    await load(page, '/ledger', { expenses: manyRows(29) })
    const rows = rowButtons(page)
    const count = async () => (await storedExpenses(page)).length

    await rows.nth(2).focus()
    const doomed = await rowName(rows.nth(2))
    const next = await rowName(rows.nth(3))
    await page.keyboard.press('Delete')
    await expect.poll(count).toBe(28)
    expect((await storedExpenses(page)).some((e) => e.itemName === doomed)).toBe(false)
    await expect(rows.nth(2)).toBeFocused()
    expect(await rowName(rows.nth(2))).toBe(next)
    await expect(page.getByRole('button', { name: 'Undo' }).first()).toBeVisible()

    // A held key deletes one row, not a run of them. Its repeats come spaced past the screen's
    // 450 ms guard between two deletes, so only the row's own repeat check can stop them.
    await page.waitForTimeout(600)
    await page.keyboard.down('Delete')
    await page.waitForTimeout(600)
    await page.keyboard.down('Delete') // auto-repeat (repeat: true)
    await page.waitForTimeout(600)
    await page.keyboard.down('Delete')
    await page.keyboard.up('Delete')
    await page.waitForTimeout(600)
    expect(await count()).toBe(27)

    // Two separate presses, 600 ms apart, delete two.
    await page.keyboard.press('Delete')
    await page.waitForTimeout(600)
    await page.keyboard.press('Delete')
    await expect.poll(count).toBe(25)
    await expect(rows.nth(2)).toBeFocused()

    // Enter edits; it never deletes.
    await page.keyboard.press('Enter')
    const edit = dialog(page, 'Edit expense')
    await expect(edit).toBeVisible()
    await page.keyboard.press('Escape')
    await expectGone(edit)
    await expect(rows.nth(2)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(edit).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await count()).toBe(25)
  })

  for (const total of [300, 5000]) {
    test(`AC-R3: a ${String(total)}-row virtual list: one stop per row, Delete moves on, Enter never deletes`, async ({
      page,
    }) => {
      test.slow(total > 1000, '5,000 rows to seed and hydrate')
      await load(page, '/ledger', { expenses: manyRows(total) })
      await expect(page.getByText(`${String(total)} entries`, { exact: true })).toBeVisible()
      const rows = rowButtons(page)
      await rows.first().focus()
      const seen = [await rowName(focused(page))]
      for (let i = 0; i < 20; i++) {
        await nextRowDrawn(page)
        await page.keyboard.press('Tab')
        const name = await focusedLabel(page)
        expect(name, `Tab ×${String(i + 1)} lands on a row`).toMatch(/^Edit row /)
        seen.push(name.split(',')[0]?.slice(5) ?? '')
      }
      expect(new Set(seen).size).toBe(21)

      const before = await rowName(focused(page))
      await page.keyboard.press('Delete')
      await expect.poll(async () => (await storedExpenses(page)).length).toBe(total - 1)
      await expect.poll(async () => rowName(focused(page))).not.toBe(before)
      expect(await focusedLabel(page)).toMatch(/^Edit row /)

      await page.waitForTimeout(600)
      await page.keyboard.press('Enter')
      await expect(dialog(page, 'Edit expense')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      await expectGone(dialog(page, 'Edit expense'))
      expect((await storedExpenses(page)).length).toBe(total - 1)

      // The palette still finds one row among them all, first of its expenses.
      const palette = await openPalette(page)
      await palette.getByRole('combobox').fill('row 0123')
      await expect(
        palette.getByRole('group', { name: 'Expenses' }).getByRole('option').first(),
      ).toContainText('row 0123')
    })
  }
})

// ─── forms, confirmations, tabs, pressed state (AC-C1, AC-C2, AC-C4, AC-C5) ───

test.describe('Forms and confirmations', () => {
  test('AC-C1: an invalid Add focuses the first invalid field, marked and described', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')
    const sheet = await openAddSheet(page, testInfo)
    const what = sheet.getByLabel('What')
    const amount = sheet.getByLabel('Amount')
    await page.keyboard.press('Enter')
    await expect(what).toBeFocused()
    await expect(what).toHaveAttribute('aria-invalid', 'true')
    await expect(what).toHaveAccessibleDescription(/Required/)

    await what.fill('kopi')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(amount).toBeFocused()
    await expect(amount).toHaveAttribute('aria-invalid', 'true')
    await expect(amount).toHaveAccessibleDescription(/Enter a valid amount/)
    await expect(what).not.toHaveAttribute('aria-invalid', 'true')
  })

  test('AC-C1: an invalid Edit save focuses the field and raises no toast', async ({ page }) => {
    await load(page, '/ledger')
    const sheet = await openEditSheet(page)
    const item = sheet.getByLabel('Item', { exact: true })
    await item.fill('')
    await sheet.getByRole('button', { name: 'Save changes' }).click()
    await expect(item).toBeFocused()
    await expect(item).toHaveAttribute('aria-invalid', 'true')
    await expect(item).toHaveAccessibleDescription(/Required/)
    await expect(page.locator('[role="region"][aria-label="Notifications"] > *')).toHaveCount(0)
    await expect(page.getByText('Required', { exact: true })).toHaveCount(1)
    await expect(sheet).toBeVisible()
  })

  test('AC-C2: the Edit delete question takes focus, gives it back, and deletes once', async ({
    page,
  }) => {
    await load(page, '/ledger', { expenses: manyRows(29) })
    const rows = rowButtons(page)
    const count = async () => (await storedExpenses(page)).length
    const doomed = await rowName(rows.nth(1))
    const next = await rowName(rows.nth(2))
    await activate(page, rows.nth(1))
    const sheet = dialog(page, 'Edit expense')
    const trigger = sheet.getByRole('button', { name: 'Delete expense' })
    await activate(page, trigger)
    const question = sheet.getByRole('group', { name: `Delete "${doomed}"?` })
    await expect(question).toHaveAccessibleDescription('This cannot be undone.')
    const cancel = question.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(question).toHaveCount(0)
    await expect(trigger).toBeFocused()

    // Enter on Delete deletes the expense, and focus goes on to the row that took its place.
    await activate(page, trigger)
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(question.getByRole('button', { name: 'Delete', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expectGone(sheet)
    await expect.poll(count).toBe(28)
    expect((await storedExpenses(page)).some((e) => e.itemName === doomed)).toBe(false)
    await expect(focused(page)).toHaveAttribute('aria-label', new RegExp(`^Edit ${next},`))
    await page.waitForTimeout(600)
    await expect(focused(page)).toHaveAttribute('aria-label', new RegExp(`^Edit ${next},`))

    // A double tap on Delete deletes one expense too (the second tap lands behind the sheet).
    await activate(page, rows.nth(4))
    await sheet.getByRole('button', { name: 'Delete expense' }).click()
    await sheet.getByRole('button', { name: 'Delete', exact: true }).dblclick()
    await expectGone(sheet)
    await expect.poll(count).toBe(27)
    await page.waitForTimeout(600)
    expect(await count()).toBe(27)
  })

  test('AC-C2: a category delete asks in its row; Keep and Delete put focus somewhere sensible', async ({
    page,
  }) => {
    await load(page, '/pulse', { expenses: [] })
    const sheet = await openSettings(page, 'Categories')
    const triggers = sheet.getByRole('button', { name: /^Delete category / })
    const names = (
      await triggers.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
    ).map((n) => n.replace('Delete category ', ''))
    const victim = names[1] ?? ''
    const after = names[2] ?? ''
    const trigger = sheet.getByRole('button', { name: `Delete category ${victim}`, exact: true })

    await activate(page, trigger)
    const question = sheet.getByRole('group', { name: `Delete ${victim}?` })
    await expect(question.getByRole('button', { name: `Keep ${victim}` })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(question).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await activate(page, trigger)
    await activate(page, question.getByRole('button', { name: `Delete category ${victim}` }))
    await expect(sheet.getByRole('textbox', { name: `Rename category ${victim}` })).toHaveCount(0)
    await expect(
      sheet.getByRole('button', { name: `Delete category ${after}`, exact: true }),
    ).toBeFocused()
  })

  test('AC-C2: clear-all and import confirmations', async ({ page }) => {
    await load(page, '/pulse')
    const sheet = await openSettings(page, 'Backup')

    const clear = sheet.getByRole('button', { name: 'Clear all expenses' })
    await activate(page, clear)
    const question = sheet.getByRole('group', {
      name: `Delete all ${String(RICH.length)} expenses?`,
    })
    const cancel = question.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(question).toHaveCount(0)
    await expect(clear).toBeFocused()
    expect(await storedExpenses(page)).toHaveLength(RICH.length)

    // Confirmed from the keyboard: everything goes, once, and focus is back on the trigger.
    await activate(page, clear)
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(question.getByRole('button', { name: 'Yes, delete all' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await storedExpenses(page)).length).toBe(0)
    await expect(clear).toBeFocused()
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText('All expenses cleared'),
    ).toHaveCount(1)

    const backup = {
      version: '4.0',
      expenses: [
        {
          id: 'imp-1',
          itemName: 'imported kopi',
          amount: 1.8,
          category: 'Food & Dining',
          date: '2026-10-10T12:00:00',
        },
        {
          id: 'imp-2',
          itemName: 'imported grab',
          amount: 12,
          category: 'Transportation',
          date: '2026-10-11T12:00:00',
        },
      ],
    }
    const file = {
      name: 'spendtrack-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    }
    const importButton = sheet.getByRole('button', { name: 'Import JSON backup' })
    await importButton.focus()
    await sheet.locator('input[type="file"]').setInputFiles(file)
    const ask = sheet.getByRole('group', { name: 'Import 2 expenses?' })
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(ask).toHaveCount(0)
    await expect(importButton).toBeFocused()

    await sheet.locator('input[type="file"]').setInputFiles(file)
    await activate(page, ask.getByRole('button', { name: 'Confirm import' }))
    await expect(importButton).toBeFocused()
    await expect.poll(async () => (await storedExpenses(page)).length).toBe(2)
  })

  test('AC-C4: Settings sections are a tablist with one tab stop and arrow keys', async ({
    page,
  }) => {
    await load(page, '/pulse')
    const sheet = await openSettings(page)
    const tablist = sheet.getByRole('tablist', { name: 'Settings sections' })
    const tabs = tablist.getByRole('tab')
    await expect(tabs).toHaveCount(4)
    await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1)
    const tab = (name: string) => tablist.getByRole('tab', { name, exact: true })

    await tab('Categories').focus()
    for (const [key, name] of [
      ['ArrowRight', 'Budgets'],
      ['ArrowRight', 'Backup'],
      ['End', 'Sync'],
      ['ArrowRight', 'Categories'],
      ['ArrowLeft', 'Sync'],
      ['Home', 'Categories'],
      ['ArrowLeft', 'Sync'],
    ] as const) {
      await page.keyboard.press(key)
      await expect(tab(name), `${key} → ${name}`).toBeFocused()
      await expect(tab(name)).toHaveAttribute('aria-selected', 'true')
      await expect(sheet.getByRole('tabpanel', { name })).toBeVisible()
    }
    await expect(tablist.locator('[aria-selected="true"]')).toHaveCount(1)
    // Tab leaves the tablist for its panel (the panel itself when nothing in it takes focus,
    // as Sync without a relay), never for the next tab or round to the top of the sheet.
    for (const name of ['Sync', 'Budgets']) {
      await tab(name).click()
      await tab(name).focus()
      await page.keyboard.press('Tab')
      expect(await tablist.evaluate((el) => el.contains(document.activeElement)), name).toBe(false)
      expect(await inside(sheet.getByRole('tabpanel', { name })), `Tab from ${name}`).toBe(true)
      await page.keyboard.press('Shift+Tab')
      await expect(tab(name), `Shift+Tab back to ${name}`).toBeFocused()
    }
  })

  test('AC-C5: date presets and category chips say which one is chosen', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')
    const sheet = await openAddSheet(page, testInfo)
    const dates = sheet.getByRole('group', { name: 'Date' })
    const preset = (name: string) => dates.getByRole('button', { name, exact: true })
    await expect(preset('Today')).toHaveAttribute('aria-pressed', 'true')
    for (const name of ['Yesterday', '2d ago', '3d ago'])
      await expect(preset(name)).toHaveAttribute('aria-pressed', 'false')
    await activate(page, preset('Yesterday'))
    await expect(preset('Yesterday')).toHaveAttribute('aria-pressed', 'true')
    await expect(preset('Today')).toHaveAttribute('aria-pressed', 'false')

    const chips = sheet.getByRole('group', { name: 'Category' })
    const food = chips.getByRole('button', { name: 'Food & Dining', exact: true })
    await expect(food).toHaveAttribute('aria-pressed', 'false')
    await activate(page, food)
    await expect(food).toHaveAttribute('aria-pressed', 'true')
    await expect(chips.locator('[aria-pressed="true"]')).toHaveCount(1)
  })
})

// ─── live regions (AC-A1, AC-A2) ──────────────────────────────────────────────

/** Remembers every status / alert node now, and logs when one of them says something. */
async function watchLiveRegions(page: Page) {
  await page.evaluate(() => {
    const regions = [...document.querySelectorAll('[role="status"], [role="alert"]')]
    const seen: { index: number; text: string; at: number }[] = []
    const live = { regions, keyAt: 0, toastAt: 0, seen }
    window.__e2eLive = live
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') live.keyAt = performance.now()
      },
      true,
    )
    new MutationObserver(() => {
      const at = performance.now()
      if (!live.toastAt && document.querySelector('[data-toast]')) live.toastAt = at
      for (const el of document.querySelectorAll('[role="status"], [role="alert"]')) {
        const text = el.textContent ?? ''
        if (text && !live.seen.some((s) => s.text === text && s.index === regions.indexOf(el)))
          live.seen.push({ index: regions.indexOf(el), text, at })
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
}

test.describe('Live regions', () => {
  test('AC-A1: a quick add is spoken by the app-wide status region, which never re-mounts', async ({
    page,
  }) => {
    await load(page, '/pulse')
    await watchLiveRegions(page)
    await quickAdd(page).fill('kopi 4.50')
    await quickAdd(page).press('Enter')
    const message = 'Added "kopi" · S$4.50. Undo available.'
    await expect
      .poll(() =>
        page.evaluate((m) => window.__e2eLive?.seen.find((s) => s.text === m) ?? null, message),
      )
      .not.toBeNull()
    const spoken = await page.evaluate((m) => {
      const live = window.__e2eLive
      const hit = live?.seen.find((s) => s.text === m)
      const node = live && hit && hit.index >= 0 ? live.regions[hit.index] : undefined
      return {
        sameNode: hit !== undefined && hit.index >= 0,
        role: node?.getAttribute('role') ?? null,
        outsideMain: node ? node.closest('main') === null : false,
        connected: node?.isConnected ?? false,
        afterKey: hit && live ? Math.round(hit.at - live.keyAt) : -1,
        afterToast: hit && live?.toastAt ? Math.round(hit.at - live.toastAt) : null,
      }
    }, message)
    expect(spoken).toMatchObject({
      sameNode: true,
      role: 'status',
      outsideMain: true,
      connected: true,
    })
    // Spoken with the toast, never after an animation or a chunk load: the announcer speaks on
    // the task after the add, a few ms on a phone. 300 ms leaves room for a busy CI runner; the
    // key-to-speech bound covers the add itself.
    expect(spoken.afterToast ?? 0).toBeLessThanOrEqual(300)
    expect(spoken.afterKey).toBeGreaterThanOrEqual(0)
    expect(spoken.afterKey).toBeLessThanOrEqual(1000)

    // An error goes to the alert region, also one that was there from the start.
    const error = 'Storage is full — export a backup and clear old data to keep saving.'
    await page.evaluate(() => window.dispatchEvent(new Event('spendtrack:quota-exceeded')))
    await expect
      .poll(() =>
        page.evaluate((m) => {
          const live = window.__e2eLive
          const hit = live?.seen.find((s) => s.text === m)
          return live && hit && hit.index >= 0
            ? (live.regions[hit.index]?.getAttribute('role') ?? null)
            : null
        }, error),
      )
      .toBe('alert')
  })

  test('AC-A2: with Settings open, a toast is spoken inside the Settings dialog', async ({
    page,
  }) => {
    await load(page, '/pulse')
    const sheet = await openSettings(page, 'Categories')
    const field = sheet.getByRole('textbox', { name: 'Add category' })
    await field.fill('Gifts')
    await field.press('Enter')
    await expect(sheet.getByRole('status').filter({ hasText: /^Category added$/ })).toHaveCount(1)
  })
})

// ─── heatmap, charts, budgets (AC-H1, AC-H2, AC-G1, AC-SH2) ───────────────────

test.describe('Heatmap and charts', () => {
  test('AC-H1: the heatmap is one tab stop; arrows move by day and week; Enter opens the day', async ({
    page,
  }) => {
    await load(page, '/pulse')
    const grid = page.getByRole('grid', { name: /^Daily spending, / })
    await expect(grid).toHaveAccessibleDescription(/days with spending/)
    let entered = false
    for (let i = 0; i < 120 && !entered; i++) {
      await page.keyboard.press('Tab')
      entered = await inside(grid)
    }
    expect(entered, 'Tab reaches the heatmap').toBe(true)
    expect(await focusedDay(page)).toBe(TODAY)
    await page.keyboard.press('Tab')
    expect(await inside(grid), 'the next Tab leaves it').toBe(false)
    await page.keyboard.press('Shift+Tab')
    expect(await focusedDay(page)).toBe(TODAY)

    const first = await grid.evaluate(
      (el) =>
        [...el.querySelectorAll('[data-day]')]
          .map((c) => c.getAttribute('data-day') ?? '')
          .sort()[0],
    )
    for (const [key, day] of [
      ['ArrowUp', '2026-10-17'],
      ['ArrowDown', '2026-10-18'],
      ['ArrowDown', '2026-10-18'], // the last day
      ['ArrowLeft', '2026-10-11'],
      ['ArrowRight', '2026-10-18'],
      ['PageUp', '2026-09-20'],
      ['PageDown', '2026-10-18'],
      ['Home', first],
      ['End', '2026-10-18'],
    ] as const) {
      await page.keyboard.press(key)
      expect(await focusedDay(page), key).toBe(day)
    }

    // A day without spending has nothing to open: Enter and Space do nothing, not even scroll.
    const empty = grid.locator('[role="gridcell"][data-day]:not(:has(button))').last()
    await empty.focus()
    const scrollY = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(page).toHaveURL(/\/pulse$/)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
    await expect(empty).toBeFocused()

    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/ledger\?date=2026-10-18/)
    await expect(mainHeading(page, 'Ledger')).toBeFocused()
  })

  test('AC-H1, AC-G1: with no data the heatmap is one stop on today and the trend reads zero', async ({
    page,
  }) => {
    await load(page, '/pulse', { expenses: [] })
    const grid = page.getByRole('grid', { name: /^Daily spending, / })
    await expect(grid).toHaveAccessibleDescription('No spending in these 14 weeks.')
    await expect(grid.getByRole('button')).toHaveCount(0)
    let entered = false
    for (let i = 0; i < 60 && !entered; i++) {
      await page.keyboard.press('Tab')
      entered = await inside(grid)
    }
    expect(entered, 'Tab reaches the heatmap').toBe(true)
    expect(await focusedDay(page)).toBe(TODAY)
    await expect(focused(page)).toHaveAccessibleName('Sun, October 18: No spending')
    await page.keyboard.press('ArrowUp')
    expect(await focusedDay(page)).toBe('2026-10-17')
    await page.keyboard.press('Tab')
    expect(await inside(grid), 'the next Tab leaves it').toBe(false)

    const trend = page.locator('[data-chart="trend"]')
    await expect(trend).toHaveAccessibleName('Daily spending, last 30 days')
    await expect(trend).toHaveAccessibleDescription('No spending in this period.')
    await trend.focus()
    await page.keyboard.press('End')
    await expect(trend).toHaveAttribute('aria-valuetext', /S\$0\.00$/)
    await page.keyboard.press('Home')
    await expect(trend).toHaveAttribute('aria-valuenow', '0')
  })

  test('AC-H2: days without spending are cells, not buttons', async ({ page }) => {
    await load(page, '/pulse')
    const grid = page.getByRole('grid', { name: /^Daily spending, / })
    await expect(grid.getByRole('button', { name: /: No spending$/ })).toHaveCount(0)
    expect(await grid.getByRole('gridcell', { name: /: No spending$/ }).count()).toBeGreaterThan(5)
    // A day with spending is a cell holding the one button that opens it, under the same name
    // (browsers name the cell from that button; Playwright's name engine skips a child's title).
    const today = grid.locator(`[role="gridcell"][data-day="${TODAY}"]`)
    await expect(today.getByRole('button')).toHaveCount(1)
    await expect(today.getByRole('button')).toHaveAccessibleName('Sun, October 18: S$7.30')
    // Exactly the days with spending in the window are buttons.
    const shown = await grid
      .locator('[data-day]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-day') ?? ''))
    const spent = new Set(RICH.map((e) => e.date.slice(0, 10)).filter((d) => shown.includes(d)))
    expect(spent.size).toBeGreaterThan(20)
    await expect(grid.locator('[role="gridcell"] button')).toHaveCount(spent.size)
    for (const day of spent)
      await expect(grid.locator(`[data-day="${day}"]`).getByRole('button')).toHaveCount(1)
  })

  async function expectChart(page: Page, chart: Locator, name: string, described = true) {
    await expect(chart).toHaveCount(1)
    await expect(chart).toHaveAttribute('role', 'slider')
    await expect(chart).toHaveAccessibleName(name)
    if (described)
      await expect(chart).toHaveAccessibleDescription(
        /^(Total \S+\. Peak \S+ (on|in) .+\.|No spending in this period\.)$/,
      )
    expect(await chart.evaluate((el, sel) => el.querySelectorAll(sel).length, TABBABLE)).toBe(0)
    const description = await chart.evaluate((el) =>
      (el.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    )
    expect(description, 'the name is not read twice').not.toContain(name)

    await chart.focus()
    const max = Number(await chart.getAttribute('aria-valuemax'))
    expect(max).toBeGreaterThan(0)
    await page.keyboard.press('Home')
    await expect(chart).toHaveAttribute('aria-valuenow', '0')
    const texts = new Set([(await chart.getAttribute('aria-valuetext')) ?? ''])
    for (let i = 1; i <= max; i++) {
      await page.keyboard.press('ArrowRight')
      texts.add((await chart.getAttribute('aria-valuetext')) ?? '')
    }
    expect(texts.size, `${name}: every point reads differently`).toBe(max + 1)
    await page.keyboard.press('End')
    await expect(chart).toHaveAttribute('aria-valuenow', String(max))
    await page.keyboard.press('Tab')
    await expect(chart).not.toBeFocused()
  }

  test('AC-G1: every chart is one slider that reads each point, with total and peak', async ({
    page,
  }) => {
    await load(page, '/pulse')
    await expectChart(page, page.locator('[data-chart="trend"]'), 'Daily spending, last 30 days')
    await page
      .getByRole('radiogroup', { name: 'Period' })
      .getByRole('radio', { name: 'Year' })
      .click()
    await expectChart(page, page.locator('[data-chart="trend"]'), 'Monthly spending, 2026')
    await expectChart(page, page.locator('[data-chart="months"]'), 'Monthly totals, 2026')

    await page.goto('/insights')
    await waitForApp(page)
    await expectChart(page, page.locator('[data-chart="trend"]'), 'Daily spending, last 30 days')
    await expectChart(page, page.locator('[data-chart="week"]'), 'Last 7 days by day')
    await expectChart(
      page,
      page.locator('[data-chart="forecast"]'),
      '14-day forecast by day',
      false,
    )
  })

  test('AC-G3, AC-SH2: budget rows say their state; Pulse links land focus on the Ledger heading', async ({
    page,
  }) => {
    await load(page, '/pulse')
    await expect(
      page.getByRole('button', { name: /^Shopping\W+Over budget\W/ }),
    ).toHaveAccessibleName(/S\$120\.00 of S\$50\.00/)
    await expect(
      page.getByRole('button', { name: /^Transportation\W+On pace to go over budget\W/ }),
    ).toHaveAccessibleName(/S\$60\.00 of S\$80\.00/)
    await expect(
      page.getByRole('button', { name: /^Food & Dining\W+On track\W/ }),
    ).toHaveAccessibleName(/of S\$300\.00/)

    await activate(page, page.getByRole('button', { name: /^Shopping\W+Over budget\W/ }))
    await expect(page).toHaveURL(/\/ledger\?category=Shopping/)
    await expect(mainHeading(page, 'Ledger')).toBeFocused()

    await page.goto('/pulse')
    await waitForApp(page)
    await activate(page, page.getByRole('button', { name: /^Transportation \d+%/ }))
    await expect(page).toHaveURL(/\/ledger\?category=Transportation/)
    await expect(mainHeading(page, 'Ledger')).toBeFocused()
  })
})

// ─── focus visibility (AC-F1, AC-F2, AC-F3, AC-F5, AC-F6) and the shell ───────

const stateById = (id: string): UiState => {
  const state = STATES.find((s) => s.id === id)
  if (!state) throw new Error(`no state ${id}`)
  return state
}

const settingsTab = (tab: string): UiState => ({
  id: `Settings ${tab}`,
  title: `Settings, ${tab}`,
  path: '/pulse',
  expenses: RICH,
  budgets: RICH_BUDGETS,
  open: async (page) => {
    await openSettings(page, tab)
  },
})

const RING_STATES: readonly UiState[] = [
  stateById('S02'),
  stateById('S04'),
  stateById('S08'),
  stateById('S10'),
  stateById('S12'),
  stateById('S07'),
  stateById('S13'),
  settingsTab('Categories'),
  settingsTab('Budgets'),
  settingsTab('Backup'),
  settingsTab('Sync'),
  stateById('S19'),
]

test.describe('Focus visibility', () => {
  for (const state of RING_STATES) {
    test(`AC-F1: every stop in ${state.title} shows a solid 3:1 ring, uncut, dark and light`, async ({
      page,
    }, testInfo) => {
      // Opened once; the OS scheme then flips and the app re-themes in place for the second walk.
      await enterState(page, testInfo, state, 'system')
      for (const theme of THEMES) {
        if (theme === 'light') await switchTheme(page, 'light')
        const stops = await tabWalk(page)
        expect.soft(stops.length, `${theme} theme: focus stops`).toBeGreaterThan(1)
        expect.soft(ringProblems(stops, { contrast: true }), `${theme} theme`).toEqual([])
      }
    })
  }

  for (const state of RING_STATES) {
    test(`AC-F2: in forced colours every stop in ${state.title} keeps a solid outline`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium', 'forced-colors emulation is Chromium only')
      await enterState(page, testInfo, state, 'dark')
      await page.emulateMedia({ forcedColors: 'active' })
      const stops = await tabWalk(page)
      expect(stops.length).toBeGreaterThan(1)
      expect(ringProblems(stops, { contrast: false })).toEqual([])
    })
  }

  test('AC-F2: in forced colours chosen chips, presets, radios, days and tabs stand out', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'forced-colors emulation is Chromium only')
    /** The background once the one-frame transitions have run. */
    const background = (l: Locator) =>
      l.evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
        return getComputedStyle(el).backgroundColor
      })
    await load(page, '/pulse')
    await page.emulateMedia({ forcedColors: 'active' })
    const period = page.getByRole('radiogroup', { name: 'Period' })
    expect(await background(period.getByRole('radio', { name: 'Month' }))).not.toBe(
      await background(period.getByRole('radio', { name: 'Year' })),
    )
    const add = await openAddSheet(page, testInfo)
    const dates = add.getByRole('group', { name: 'Date' })
    expect(await background(dates.getByRole('button', { name: 'Today', exact: true }))).not.toBe(
      await background(dates.getByRole('button', { name: 'Yesterday', exact: true })),
    )
    const chips = add.getByRole('group', { name: 'Category' })
    await chips.getByRole('button', { name: 'Food & Dining', exact: true }).click()
    expect(
      await background(chips.getByRole('button', { name: 'Food & Dining', exact: true })),
    ).not.toBe(await background(chips.getByRole('button', { name: 'Gaming', exact: true })))
    // Oct 11 is no preset's day, so the calendar marks it as the chosen one.
    await add.getByRole('button', { name: 'Pick date' }).click()
    const picker = dialog(page, 'Choose date')
    await picker.getByRole('button', { name: 'Sunday, October 11, 2026' }).click()
    await add.getByRole('button', { name: 'Change date, selected Oct 11, 2026' }).click()
    expect(
      await background(picker.getByRole('button', { name: 'Sunday, October 11, 2026' })),
    ).not.toBe(await background(picker.getByRole('button', { name: 'Saturday, October 10, 2026' })))
    await page.keyboard.press('Escape')
    await expectGone(picker)
    await page.keyboard.press('Escape')
    await expectGone(add)
    const settings = await openSettings(page)
    const tabs = settings.getByRole('tablist', { name: 'Settings sections' })
    expect(await background(tabs.getByRole('tab', { name: 'Categories' }))).not.toBe(
      await background(tabs.getByRole('tab', { name: 'Budgets' })),
    )
  })

  test('AC-F3: a focused control never looks like a chosen one', async ({ page }, testInfo) => {
    // Read once the focus change has settled (one 0.01 ms transition under reduced motion).
    const outline = (l: Locator) =>
      l.evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
        return getComputedStyle(el).outlineStyle
      })
    await load(page, '/pulse')

    // Segmented: the checked radio (unfocused) against an unchecked one given focus.
    const period = page.getByRole('radiogroup', { name: 'Period' })
    const month = period.getByRole('radio', { name: 'Month' })
    const year = period.getByRole('radio', { name: 'Year' })
    await tabTo(page, month)
    await year.focus()
    expect(await outline(year)).toBe('solid')
    expect(await outline(month)).toBe('none')

    // Date presets and category chips.
    const sheet = await openAddSheet(page, testInfo)
    const dates = sheet.getByRole('group', { name: 'Date' })
    await tabTo(page, dates.getByRole('button', { name: 'Yesterday', exact: true }), true)
    expect(await outline(dates.getByRole('button', { name: 'Yesterday', exact: true }))).toBe(
      'solid',
    )
    expect(await outline(dates.getByRole('button', { name: 'Today', exact: true }))).toBe('none')
    const chips = sheet.getByRole('group', { name: 'Category' })
    await activate(page, chips.getByRole('button', { name: 'Food & Dining', exact: true }))
    await tabTo(page, chips.getByRole('button', { name: 'Gaming', exact: true }))
    expect(await outline(chips.getByRole('button', { name: 'Gaming', exact: true }))).toBe('solid')
    expect(await outline(chips.getByRole('button', { name: 'Food & Dining', exact: true }))).toBe(
      'none',
    )

    // Calendar days: the chosen day against the focused one (Oct 11 is no preset's day).
    await activate(page, sheet.getByRole('button', { name: 'Pick date' }))
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter') // Oct 11 chosen; focus back on the pill
    const pill = sheet.getByRole('button', { name: 'Change date, selected Oct 11, 2026' })
    await expect(pill).toBeFocused()
    await page.keyboard.press('Enter')
    const picker = dialog(page, 'Choose date')
    const chosen = picker.getByRole('button', { name: 'Sunday, October 11, 2026' })
    await expect(chosen).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    const before = picker.getByRole('button', { name: 'Saturday, October 10, 2026' })
    await expect(before).toBeFocused()
    expect(await outline(before)).toBe('solid')
    expect(await outline(chosen)).toBe('none')
  })

  // This month's ledger (13 rows under 12 day headers) is about two screens tall on a phone.
  for (const path of ['/pulse', '/ledger']) {
    test(`AC-F5: on ${path} focus never sits under the sticky header or the tab bar`, async ({
      page,
    }, testInfo) => {
      // The phone has both bars to clear in both directions; on a laptop only the header
      // (there is no tab bar), which only Shift+Tab can scroll a control under.
      const directions = isPhone(testInfo) ? [false, true] : [true]
      const problems: string[] = []
      for (const backwards of directions) {
        await load(page, path)
        const walk = await obscuredWalk(page, { backwards })
        expect(walk.stops, `${backwards ? 'Shift+Tab' : 'Tab'} finds the controls`).toBeGreaterThan(
          10,
        )
        problems.push(...walk.problems.map((p) => `${backwards ? 'Shift+Tab' : 'Tab'}: ${p}`))
      }
      expect(problems).toEqual([])
    })
  }

  test('AC-F6: typing in the top-bar quick add never changes the header height', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'the top-bar quick add is shown from 1024 px')
    await load(page, '/pulse')
    const header = page.locator('header').first()
    const height = async () => (await header.boundingBox())?.height ?? 0
    const start = await height()
    await quickAdd(page).focus()
    for (const ch of 'kopi 2.40 yesterday') {
      await page.keyboard.type(ch)
      expect(await height(), `after "${ch}"`).toBe(start)
    }
  })
})

test.describe('Shell', () => {
  test('AC-SH1: "Skip to content" is the first tab stop and moves focus into main', async ({
    page,
  }, testInfo) => {
    await load(page, '/pulse')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    // The first focusable element in the document, before the header.
    expect(
      await skip.evaluate(
        (el) =>
          document.querySelector('a[href], button, input, select, textarea, [tabindex]') === el,
      ),
    ).toBe(true)
    // WebKit, like Safari, tabs to links only when the user turns that on: there the link is
    // reached the other way a keyboard or switch user does, and must work the same.
    if (isPhone(testInfo)) await skip.focus()
    else await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    const box = await skip.boundingBox()
    expect(box?.width ?? 0, 'visible while focused').toBeGreaterThan(20)
    const url = page.url()
    await page.keyboard.press('Enter')
    expect(
      await page.evaluate(() => {
        const main = document.querySelector('main')
        return (
          main !== null &&
          (main === document.activeElement || main.contains(document.activeElement))
        )
      }),
    ).toBe(true)
    expect(page.url()).toBe(url)
  })
})

// ─── the reading position (keyboard on a laptop) ──────────────────────────────

// A keyboard user on a scrolled Ledger: opening and closing a layer, tabbing through the
// header, and typing in the header's quick add must leave the page where it was. The page's
// focus offset (clear of the sticky header) used to apply to the header's own controls too, and
// a layer opened with nothing focused sent focus back to the heading by scrolling to it.
// Both engines at laptop width (the header's quick add shows from 1024 px).
test.describe('Reading position', () => {
  const ROW = 80 // one ledger row and some: the one Ctrl+N adds, above the reader's spot

  async function scrolledLedger(page: Page) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await load(page, '/ledger?range=all', { expenses: manyRows(120) })
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.scrollTo(0, 1500)
    })
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(1500)
  }
  const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY))

  test('a shortcut, typing and Enter, then Escape: the page stays put', async ({ page }) => {
    await scrolledLedger(page)
    await page.keyboard.press('Control+n')
    const sheet = dialog(page, 'Add expense')
    await expect(sheet).toBeVisible()
    await page.keyboard.type('Coffee')
    await page.keyboard.press('Tab')
    await page.keyboard.type('4.50')
    await page.keyboard.press('Enter')
    await expectGone(sheet)
    await expect(mainHeading(page, 'Ledger')).toBeFocused()
    expect(Math.abs((await scrollY(page)) - 1500), 'after the add').toBeLessThanOrEqual(ROW)

    for (const key of ['Control+k', 'Control+,']) {
      const before = await scrollY(page)
      await page.keyboard.press(key)
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expectGone(page.getByRole('dialog'))
      expect(await scrollY(page), `${key} then Escape`).toBe(before)
    }
  })

  test('tabbing through the header, and typing in its quick add, never scroll the page', async ({
    page,
  }) => {
    await scrolledLedger(page)
    // From <body> the first stops are the header's (WebKit skips its links, as Safari does).
    let headerStops = 0
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      const inHeader = await page.evaluate(
        () => document.activeElement?.closest('header, a[href="#main"]') != null,
      )
      if (!inHeader) break
      headerStops += 1
      expect(await scrollY(page), `Tab ×${String(i + 1)}`).toBe(1500)
    }
    expect(headerStops, 'stops in the header').toBeGreaterThanOrEqual(3)

    // (The Tab that left the header went on to the Ledger's first control, at the top.)
    await page.evaluate(() => {
      window.scrollTo(0, 1500)
    })
    await expect.poll(() => scrollY(page)).toBe(1500)
    await quickAdd(page).click()
    await page.keyboard.type('kopi 2')
    expect(await scrollY(page), 'typing in the quick add').toBe(1500)
    await quickAdd(page).fill('')

    // Back from the palette onto Search, by keyboard.
    await searchButton(page).focus()
    await page.keyboard.press('Enter')
    const palette = dialog(page, 'Command palette')
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expectGone(palette)
    await expect(searchButton(page)).toBeFocused()
    expect(await scrollY(page), 'focus back on Search').toBe(1500)
  })
})
