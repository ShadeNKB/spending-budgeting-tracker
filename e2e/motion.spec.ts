import { writeFile } from 'node:fs/promises'
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import {
  RICH,
  dialog,
  expectGone,
  isPhone,
  manyRows,
  openAddSheet,
  openPalette,
  quickAdd,
  storedExpenses,
  transformFrames,
} from './support/a11y'
import {
  FRAME_MS,
  SWIPE,
  actionOpacityAt,
  busyTime,
  curveError,
  draggedTo,
  evenPath,
  expectRowAt,
  fastestRate,
  finishRecording,
  firstShownGap,
  flickRow,
  leavingFrames,
  ledgerRow,
  loadInMotion,
  markLayer,
  mouseSwipe,
  moved,
  pointerSwipe,
  record,
  rowNow,
  scaleX,
  shiftY,
  springAt,
  springOvershoot,
  springPeakRate,
  startDelay,
  startRecording,
  stayedFor,
  touchSwipe,
  transitionSpan,
  withLag,
  withPanel,
  wrongWay,
  type Box,
  type Frame,
  type LayerLook,
  type Look,
  type ToastLook,
} from './support/motion'

// Motion, characterized (T5b spec §9.2): how the sheets, the command palette, the toasts and the
// ledger swipe move, read off every animation frame the way a person sees them (where each part
// is drawn, its opacity and transforms, what is in the page, what a press does, what is stored)
// and never through an animation library. Written against the framer-motion build, and kept
// unchanged for its CSS / Web Animations rewrite. Exact curves and timings in Chromium; WebKit
// here can hold an animation at its first frame for seconds after a load, so there it checks
// where things end up and that they move one way. Invented data on the Singapore date.

/** What a dialog shows on one frame. */
interface Showing {
  /** It is closing: still in the page, and inert. */
  closing: boolean
  /** The values of its fields. */
  values: string[]
  /** The text of its options (the palette's list). */
  options: string[]
}

declare global {
  interface Window {
    /** What a dialog showed, frame by frame, until it left the page (see startReading). */
    __e2eShowing?: { frames: Showing[]; done: boolean }
  }
}

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  test.slow(isPhone(testInfo), 'WebKit')
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

// framer-motion's springs in the baseline (stiffness, damping; mass 1).
const SHEET_SPRING = { k: 380, c: 40 }
const PALETTE_SPRING = { k: 420, c: 36 }
const TOAST_SPRING = { k: 420, c: 32 }
const ROW_SPRING = { k: 420, c: 40 }

/** How long a recording may run: WebKit can hold an animation for seconds. */
const longest = (testInfo: TestInfo, chromium: number) => (isPhone(testInfo) ? 15_000 : chromium)

const SIXTY = manyRows(60)

function lastOf<T>(items: readonly T[], what: string): T {
  const item = items.at(-1)
  if (item === undefined) throw new Error(`no ${what}`)
  return item
}

function firstOf<T>(items: readonly T[], what: string): T {
  const item = items[0]
  if (item === undefined) throw new Error(`no ${what}`)
  return item
}

/** Keeps a recording in the test's output folder, to read when an assertion on it fails. */
async function keep(testInfo: TestInfo, name: string, frames: readonly Frame[]) {
  const path = testInfo.outputPath(`${name.replace(/\W+/g, '-')}.frames.json`)
  await writeFile(path, JSON.stringify(frames, null, 1))
  await testInfo.attach(`${name} frames`, { path, contentType: 'application/json' })
}

/** A toast's frames, by the text it shows. */
const toastFrames = (frames: readonly Frame[], text: string) =>
  frames.flatMap((f) => {
    const toast = f.toasts?.find((x) => x.text.includes(text))
    return toast ? [{ t: f.t, toast }] : []
  })

/**
 * Raises a toast and waits for it, one of `toasts`: at rest in Chromium; in WebKit only shown,
 * as a hold there could outlast a toast's own 4 s.
 */
async function showToast(
  page: Page,
  testInfo: TestInfo,
  toasts: number,
  raise: () => Promise<unknown>,
): Promise<void> {
  if (isPhone(testInfo)) {
    await raise()
    await expect(page.locator('[data-toast]')).toHaveCount(toasts, { timeout: 15_000 })
    return
  }
  await record(page, { toasts: true, until: 'rest', toastCount: toasts, maxMs: 4000 }, async () => {
    await raise()
  })
}

/** Quick-adds `phrase`: a toast with Undo that lasts 4 s (see showToast). */
const quickAddToast = (page: Page, testInfo: TestInfo, phrase: string, toasts: number) =>
  showToast(page, testInfo, toasts, async () => {
    await quickAdd(page).fill(phrase)
    await quickAdd(page).press('Enter')
  })

/**
 * The app's storage-full warning (AppShell.tsx): a real toast, and the one that lasts 12 s, long
 * enough to outlive WebKit's holds.
 */
const warnStorageFull = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('spendtrack:quota-exceeded')))

/** Raises the storage-full warning (see showToast). */
const raiseQuotaToast = (page: Page, testInfo: TestInfo, toasts: number) =>
  showToast(page, testInfo, toasts, () => warnStorageFull(page))

// ─── sheets (AC-O1, AC-O2, AC-O3) ─────────────────────────────────────────────

type Axis = 'x' | 'y'

/** How far a box is from where it rests, along the axis it slides on (px, towards the edge). */
const offsetOf = (box: Box, rest: Box, axis: Axis) =>
  axis === 'y' ? box.y - rest.y : box.x - rest.x
const travelOf = (rest: Box, axis: Axis) => (axis === 'y' ? rest.height : rest.width)

/**
 * The layer's backdrop fades from opacity `from` to `to` over about `ms`. It does not snap: from
 * its last frame at `from` to its first at `to` takes the fade's time at least (less a frame).
 * And it shows in-between opacities only for as long as the fade lasts. Both are timed on the
 * backdrop's own frames: under load a fade can start a few frames after the panel moves.
 */
function expectFade(
  frames: readonly { t: number; layer: LayerLook }[],
  from: number,
  to: number,
  ms: number,
) {
  const samples = frames.map((f) => ({ t: f.t, v: f.layer.backdrop?.opacity ?? 0 }))
  const left =
    samples.filter((s) => Math.abs(s.v - from) <= 0.01).at(-1) ?? firstOf(samples, 'backdrop')
  const reached = samples.find((s) => s.t > left.t && Math.abs(s.v - to) <= 0.01)
  expect(reached, `the backdrop reaches ${String(to)}`).toBeDefined()
  expect(
    (reached?.t ?? 0) - left.t,
    `the backdrop fades over ${String(ms)} ms, it does not snap`,
  ).toBeGreaterThanOrEqual(ms - 20)
  expect(
    transitionSpan(samples),
    `the backdrop fades over about ${String(ms)} ms`,
  ).toBeLessThanOrEqual(ms + 50)
}

/**
 * Focus leaves a closing layer at once: the layer hands it back in a task of its own right
 * after the close (modalLayer.ts). The frames are painted ones, and a page busy with the close
 * can paint one more before that task runs: so the first frame of the close may still find focus
 * inside, and the second only while the layer is still drawn at rest. No frame that shows the
 * layer on its way out (moved or faded, its backdrop included) may.
 */
function expectFocusHandedBack(leaving: readonly { layer: LayerLook; panel: Look }[]) {
  leaving.forEach((f, i) => {
    const atRest =
      moved(f.panel) === '' && f.panel.opacity === 1 && (f.layer.backdrop?.opacity ?? 1) === 1
    if (i === 0 || (i === 1 && atRest)) return
    expect(f.layer.focused, `focus is back outside the closing layer (frame ${String(i)})`).toBe(
      false,
    )
  })
}

/**
 * The layer leaves the page within `ms` of the recording's start. Allowed for: the time a busy
 * machine took from the page (see busyTime), and how long the browser held the exit's parts
 * before they began to move or fade (see startDelay).
 */
function expectGoneWithin(frames: readonly Frame[], ms: number, what: string) {
  const t0 = firstOf(frames, 'frame').t
  const gone = frames.find((f) => f.layer?.dialogs === 0)
  expect(gone, `${what}: gone from the page`).toBeDefined()
  const at = gone?.t ?? Infinity
  const leaving = leavingFrames(frames)
  const held = Math.max(
    startDelay(leaving.map((f) => ({ t: f.t, v: f.panel.box.x + f.panel.box.y }))),
    startDelay(leaving.map((f) => ({ t: f.t, v: f.panel.opacity }))),
    startDelay(leaving.map((f) => ({ t: f.t, v: f.layer.backdrop?.opacity ?? 0 }))),
  )
  expect(
    at - t0 - busyTime(frames, t0, at) - held,
    `${what}: gone within ${String(ms)} ms (${String(Math.round(held))} ms held)`,
  ).toBeLessThanOrEqual(ms)
}

/**
 * The opening of a sheet that slides in along `axis` from the screen's edge: from off-screen,
 * one way, onto its place, the backdrop fading in with it. Returns where the sheet rests.
 */
function expectSlideIn(frames: readonly Frame[], axis: Axis, testInfo: TestInfo): Box {
  const shown = withPanel(frames)
  const end = lastOf(shown, 'frame with the sheet')
  const rest = end.panel.box
  const travel = travelOf(rest, axis)
  const offsets = shown.map((f) => offsetOf(f.panel.box, rest, axis))
  // Starts off-screen: its first frame is 10 % of the way in at most, or no further than the
  // spring gets in the time since the frame before it, when frames are far apart.
  const startShare = Math.max(0.1, springAt(SHEET_SPRING.k, SHEET_SPRING.c, firstShownGap(frames)))
  expect(firstOf(offsets, 'offset'), 'starts off-screen').toBeGreaterThanOrEqual(
    travel * (1 - startShare),
  )
  expect(wrongWay(offsets, 'down', 1), 'slides one way').toEqual([])
  expect(Math.min(...offsets), 'no overshoot past its place').toBeGreaterThanOrEqual(-1)
  for (const f of shown) {
    expect(f.panel.opacity, 'the sheet slides, it does not fade').toBe(1)
    expect(
      axis === 'y' ? f.panel.box.height : f.panel.box.width,
      'the sheet moves, it does not stretch',
    ).toBeCloseTo(travel, 0)
  }
  expect(moved(end.panel), 'at rest in its place').toBe('')
  expect(end.layer.focused, 'focus inside once open').toBe(true)
  const backdrop = shown.map((f) => f.layer.backdrop?.opacity ?? 0)
  expect(wrongWay(backdrop, 'up', 0.01), 'the backdrop only fades in').toEqual([])
  expect(lastOf(backdrop, 'backdrop'), 'the backdrop ends opaque').toBe(1)
  if (isPhone(testInfo)) return rest

  const t0 = firstOf(shown, 'frame').t
  expect(firstOf(backdrop, 'backdrop'), 'the backdrop starts clear').toBeLessThanOrEqual(0.35)
  expectFade(shown, 0, 1, 150)
  const arrived = shown.find((f) => offsetOf(f.panel.box, rest, axis) <= travel * 0.01)
  const took = (arrived?.t ?? Infinity) - t0
  expect(took, '99 % of the way in 250-600 ms').toBeGreaterThanOrEqual(250)
  expect(
    took - busyTime(shown, t0, t0 + took),
    '99 % of the way in 250-600 ms',
  ).toBeLessThanOrEqual(600)
  const fit = curveError(
    withLag(shown.map((f) => ({ t: f.t, p: 1 - offsetOf(f.panel.box, rest, axis) / travel }))),
    (ms) => springAt(SHEET_SPRING.k, SHEET_SPRING.c, ms),
  )
  expect(fit.error, 'on the sheet spring (k 380, c 40)').toBeLessThanOrEqual(0.05)
  return rest
}

/**
 * A closing layer is seen on its way out, on WebKit too: the first frame that shows the close
 * still shows the layer (`visible`), or a later one does. An exit that jumps to its end shows it
 * off-screen or see-through from that first frame (WebKit did so whenever the body's overflow
 * changed under a running CSS transition, as the page's scroll lock let go at the close). Judged
 * when that frame came within `withinMs` of the frame before it, the time the exit takes to get
 * out of sight: a machine that painted nothing for longer could have missed the whole exit, and
 * the test then says so in its report instead of passing it in silence.
 */
function expectSeenLeaving(
  frames: readonly Frame[],
  visible: (panel: Look) => boolean,
  withinMs: number,
  what: string,
  testInfo: TestInfo,
) {
  const leaving = leavingFrames(frames)
  const first = firstOf(leaving, `frame of ${what} on its way out`)
  const gap = firstShownGap(frames, (f) => f.t === first.t)
  if (gap > withinMs && !leaving.some((f) => visible(f.panel))) {
    testInfo.annotations.push({
      type: 'unjudged',
      description: `${what} on its way out: no frame for ${String(Math.round(gap))} ms after the close`,
    })
    return
  }
  expect(
    leaving.filter((f) => visible(f.panel)).length,
    `${what} is seen on its way out (first frame ${String(Math.round(gap))} ms after the one before)`,
  ).toBeGreaterThan(0)
}

/**
 * The closing of a sheet that rests at `rest`: back out along `axis`, one way, inert from its
 * first frame and focus handed back at once, the backdrop fading out, then gone from the page.
 */
function expectSlideOut(frames: readonly Frame[], rest: Box, axis: Axis, testInfo: TestInfo) {
  const leaving = leavingFrames(frames)
  const travel = travelOf(rest, axis)
  const offsets = leaving.map((f) => offsetOf(f.panel.box, rest, axis))
  // More than three frames of an idle page (counted in time: frames can be far apart).
  expect(stayedFor(frames), 'the sheet stays to slide away').toBeGreaterThanOrEqual(4 * FRAME_MS)
  expect(wrongWay(offsets, 'up', 1), 'slides back one way').toEqual([])
  for (const f of leaving) {
    expect(f.panel.inert, 'inert while it leaves').toBe(true)
    expect(f.boxes, 'one layer box while it leaves').toBe(1)
  }
  expectFocusHandedBack(leaving)
  const backdrop = leaving.map((f) => f.layer.backdrop?.opacity ?? 0)
  expect(wrongWay(backdrop, 'down', 0.01), 'the backdrop only fades out').toEqual([])
  const end = lastOf(frames, 'frame')
  expect(end.layer?.dialogs, 'gone from the page').toBe(0)
  expect(end.boxes, 'no layer box left behind').toBe(0)
  // Still partly on screen: the spring is 99.8 % of the way out only after about 350 ms.
  expectSeenLeaving(
    frames,
    (panel) => offsetOf(panel.box, rest, axis) < travel - 1,
    300,
    'the sheet',
    testInfo,
  )
  if (isPhone(testInfo)) return

  expect(lastOf(offsets, 'offset'), 'leaves the page once off-screen').toBeGreaterThanOrEqual(
    travel * 0.9,
  )
  expectFade(withPanel(frames), 1, 0, 150)
  expectGoneWithin(frames, 1500, 'the sheet')
  const fit = curveError(
    withLag(leaving.map((f) => ({ t: f.t, p: offsetOf(f.panel.box, rest, axis) / travel }))),
    (ms) => springAt(SHEET_SPRING.k, SHEET_SPRING.c, ms),
  )
  expect(fit.error, 'on the sheet spring (k 380, c 40)').toBeLessThanOrEqual(0.05)
}

test.describe('Sheets slide', () => {
  test('AC-O1, AC-O2: the Add sheet rises from below the screen and sinks back out', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const opening = await record(
      page,
      { layer: 'Add expense', until: 'open', minMs: 300, maxMs: longest(testInfo, 3000) },
      async () => {
        await openAddSheet(page, testInfo)
      },
    )
    await keep(testInfo, 'opening', opening)
    const rest = expectSlideIn(opening, 'y', testInfo)
    const closing = await record(
      page,
      { layer: 'Add expense', until: 'gone', maxMs: longest(testInfo, 3000) },
      async () => {
        await page.keyboard.press('Escape')
      },
    )
    await keep(testInfo, 'closing', closing)
    expectSlideOut(closing, rest, 'y', testInfo)
  })

  test('AC-O1, AC-O2: on a laptop Settings slides in from the right and back out', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'the side sheet is the laptop layout')
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const opening = await record(
      page,
      { layer: 'Settings', until: 'open', minMs: 300, maxMs: 3000 },
      async () => {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
      },
    )
    await keep(testInfo, 'opening', opening)
    const rest = expectSlideIn(opening, 'x', testInfo)
    expect(rest.x + rest.width, 'against the right edge').toBeCloseTo(1280, 0)
    const closing = await record(
      page,
      { layer: 'Settings', until: 'gone', maxMs: 3000 },
      async () => {
        await page.keyboard.press('Escape')
      },
    )
    await keep(testInfo, 'closing', closing)
    expectSlideOut(closing, rest, 'x', testInfo)
  })

  test('AC-O2: a sheet on its way out lets a press through to the page under it', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    await record(
      page,
      { layer: 'Add expense', until: 'open', minMs: 300, maxMs: longest(testInfo, 3000) },
      async () => {
        await openAddSheet(page, testInfo)
      },
    )
    const search = await page.getByRole('button', { name: 'Search', exact: true }).boundingBox()
    if (!search) throw new Error('no Search button')
    await page.keyboard.press('Escape')
    const at = { x: search.x + search.width / 2, y: search.y + search.height / 2 }
    if (isPhone(testInfo)) await page.touchscreen.tap(at.x, at.y)
    else await page.mouse.click(at.x, at.y)
    expect(await dialog(page, 'Add expense').count(), 'the Add sheet was still leaving').toBe(1)
    await expect(dialog(page, 'Command palette'), 'the press reached Search').toBeVisible()
    await expectGone(dialog(page, 'Add expense'))
  })

  test('AC-O3: reopened on its way out, the sheet turns back where it is: the same dialog, focus inside', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    // The phone's + under the closing sheet: tapped where it is, straight through the layer.
    const plus = isPhone(testInfo)
      ? await middleOf(page.getByRole('button', { name: 'Add expense', exact: true }))
      : null
    let rest: Box | null = null
    let frames: Frame[] = []
    // A reopen that a busy machine delivers only after the sheet has gone shows nothing: try
    // again (up to three times) until the press lands while it is on its way out.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const opening = await record(
        page,
        { layer: 'Add expense', until: 'open', minMs: 300, maxMs: longest(testInfo, 3000) },
        async () => {
          if (attempt === 1) await openAddSheet(page, testInfo)
        },
      )
      const box = lastOf(withPanel(opening), 'open sheet').panel.box
      rest = box
      await markLayer(page, 'Add expense')
      const key = await startRecording(page, {
        layer: 'Add expense',
        until: 'open',
        minMs: 600,
        maxMs: longest(testInfo, 4000),
      })
      await page.keyboard.press('Escape')
      if (plus) {
        await page.waitForTimeout(100)
      } else {
        // Well on its way: a jump back to its place from here could not pass for the spring.
        await page.waitForFunction(
          ({ top, height }) => {
            const panel = document.querySelector('[data-e2e-mark]')
            return panel !== null && panel.getBoundingClientRect().y - top >= height * 0.4
          },
          { top: box.y, height: box.height },
          { polling: 'raf', timeout: 2000 },
        )
      }
      if (plus) await page.touchscreen.tap(plus.x, plus.y)
      else await page.keyboard.press('Control+n')
      frames = await finishRecording(page, key)
      if (frames.every((f) => (f.layer?.dialogs ?? 0) > 0)) break
    }
    await keep(testInfo, 'reopening', frames)
    if (!rest) throw new Error('the sheet never opened')

    for (const f of frames) {
      expect(f.layer?.dialogs, 'one Add dialog at most').toBeLessThanOrEqual(1)
      expect(f.layer?.marked, 'the same dialog element throughout').toBe(true)
    }
    const end = lastOf(withPanel(frames), 'frame with the sheet')
    expect(moved(end.panel), 'back at rest in its place').toBe('')
    expect(end.panel.inert, 'no longer inert').toBe(false)
    expect(end.layer.focused, 'focus inside again').toBe(true)
    expect(end.layer.backdrop?.opacity, 'the backdrop back to opaque').toBe(1)
    await expect(dialog(page, 'Add expense')).toBeVisible()
    if (isPhone(testInfo)) return

    const offsets = withPanel(frames).map((f) => ({
      t: f.t,
      v: offsetOf(f.panel.box, rest, 'y'),
    }))
    const values = offsets.map((o) => o.v)
    const deepest = Math.max(...values)
    const turn = values.lastIndexOf(deepest)
    expect(deepest, 'it was well on its way out when it turned back').toBeGreaterThan(
      rest.height * 0.3,
    )
    // Out one way, then back one way: it turns where it is, and does not snap back. A jump to
    // its place would be back within a frame; a slide takes a good part of the sheet's time.
    expect(wrongWay(values.slice(0, turn + 1), 'up', 1), 'out one way').toEqual([])
    expect(wrongWay(values.slice(turn), 'down', 1), 'then back one way').toEqual([])
    const turnedAt = offsets[turn]?.t ?? 0
    const home = offsets.slice(turn).find((o) => o.v <= rest.height * 0.01)
    expect(
      (home?.t ?? Infinity) - turnedAt,
      'it slides back, it does not jump',
    ).toBeGreaterThanOrEqual(100)
    const peak = springPeakRate(SHEET_SPRING.k, SHEET_SPRING.c) * rest.height
    expect(
      fastestRate(offsets),
      'no jump: never faster than 1.5 × the spring at its fastest',
    ).toBeLessThanOrEqual(peak * 1.5)
  })
})

// ─── the command palette (AC-O2, AC-O5) ───────────────────────────────────────

test.describe('The command palette', () => {
  test('AC-O5: drops in from 16 px up at 97 % while fading in, and leaves to 8 px up', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const opening = await record(
      page,
      { layer: 'Command palette', until: 'open', minMs: 300, maxMs: longest(testInfo, 3000) },
      async () => {
        await openPalette(page)
      },
    )
    await keep(testInfo, 'opening', opening)
    const shown = withPanel(opening)
    const end = lastOf(shown, 'frame with the palette')
    const rest = end.panel.box
    const first = firstOf(shown, 'frame with the palette').panel
    // Its first frame is just under way, or, when frames are far apart, no further in than the
    // spring gets in the time since the frame before it (a CSS transition runs on the clock).
    const ran = springAt(PALETTE_SPRING.k, PALETTE_SPRING.c, firstShownGap(opening))
    expect(shiftY(first.box, rest), 'starts 16 px up').toBeGreaterThanOrEqual(-17)
    expect(shiftY(first.box, rest), 'starts 16 px up').toBeLessThanOrEqual(
      Math.max(-11, -16 * (1 - ran)),
    )
    expect(scaleX(first.box, rest), 'starts at 97 %').toBeGreaterThanOrEqual(0.965)
    expect(scaleX(first.box, rest), 'starts at 97 %').toBeLessThanOrEqual(
      Math.max(0.98, 0.97 + 0.03 * ran),
    )
    expect(first.opacity, 'starts see-through').toBeLessThanOrEqual(Math.max(0.35, ran))
    const shifts = shown.map((f) => shiftY(f.panel.box, rest))
    expect(wrongWay(shifts, 'up', 0.5), 'drops one way').toEqual([])
    expect(
      wrongWay(
        shown.map((f) => scaleX(f.panel.box, rest)),
        'up',
        0.003,
      ),
      'grows one way',
    ).toEqual([])
    expect(
      wrongWay(
        shown.map((f) => f.panel.opacity),
        'up',
        0.01,
      ),
      'fades in one way',
    ).toEqual([])
    expect(moved(end.panel), 'at rest in its place').toBe('')
    expect(end.panel.opacity).toBe(1)
    expect(end.layer.backdrop?.opacity, 'the backdrop ends opaque').toBe(1)
    if (!isPhone(testInfo)) {
      const fit = curveError(
        withLag(shown.map((f) => ({ t: f.t, p: 1 - shiftY(f.panel.box, rest) / -16 }))),
        (ms) => springAt(PALETTE_SPRING.k, PALETTE_SPRING.c, ms),
      )
      expect(fit.error, 'on the palette spring (k 420, c 36)').toBeLessThanOrEqual(0.06)
      expectFade(shown, 0, 1, 120)
    }

    const closing = await record(
      page,
      { layer: 'Command palette', until: 'gone', maxMs: longest(testInfo, 3000) },
      async () => {
        await page.keyboard.press('Escape')
      },
    )
    await keep(testInfo, 'closing', closing)
    const leaving = leavingFrames(closing)
    // More than three frames of an idle page (counted in time: frames can be far apart).
    expect(stayedFor(closing), 'the palette stays to animate out').toBeGreaterThanOrEqual(
      4 * FRAME_MS,
    )
    for (const f of leaving) expect(f.panel.inert, 'inert while it leaves').toBe(true)
    expectFocusHandedBack(leaving)
    const away = leaving.map((f) => shiftY(f.panel.box, rest))
    expect(wrongWay(away, 'down', 0.5), 'rises one way').toEqual([])
    expect(Math.min(...away), 'no further than 8 px up').toBeGreaterThanOrEqual(-9)
    expect(
      wrongWay(
        leaving.map((f) => scaleX(f.panel.box, rest)),
        'down',
        0.003,
      ),
      'shrinks one way',
    ).toEqual([])
    expect(
      wrongWay(
        leaving.map((f) => f.panel.opacity),
        'down',
        0.01,
      ),
      'fades out one way',
    ).toEqual([])
    expect(lastOf(closing, 'frame').layer?.dialogs, 'gone from the page').toBe(0)
    expect(lastOf(closing, 'frame').boxes, 'no layer box left behind').toBe(0)
    // Still showing: the spring takes it to 95 % see-through after about 170 ms.
    expectSeenLeaving(closing, (panel) => panel.opacity > 0.05, 150, 'the palette', testInfo)
    if (!isPhone(testInfo)) {
      expectFade(withPanel(closing), 1, 0, 120)
      const last = lastOf(leaving, 'frame with the palette').panel
      expect(shiftY(last.box, rest), 'leaves 8 px up').toBeLessThanOrEqual(-5)
      expect(scaleX(last.box, rest), 'leaves at 97 %').toBeLessThanOrEqual(0.98)
      expect(last.opacity, 'leaves see-through').toBeLessThanOrEqual(0.15)
      expectGoneWithin(closing, 1500, 'the palette')
    }
  })
})

// ─── what a closing overlay shows (AC-O4) ─────────────────────────────────────

/** Starts reading what the dialog named `name` shows on every frame, until it has left. */
async function startReading(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const reading: { frames: Showing[]; done: boolean } = { frames: [], done: false }
    window.__e2eShowing = reading
    const nameOf = (d: Element) => {
      const label = d.getAttribute('aria-label')
      if (label !== null) return label
      const by = d.getAttribute('aria-labelledby')
      return by ? (document.getElementById(by)?.textContent ?? '') : ''
    }
    const started = performance.now()
    let gone = 0
    const tick = () => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find((el) => nameOf(el) === n)
      if (d) {
        reading.frames.push({
          closing: d.closest('[inert]') !== null,
          values: [...d.querySelectorAll('input')].map((i) => i.value),
          options: [...d.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? ''),
        })
        gone = 0
      } else gone += 1
      if (gone >= 3 || performance.now() - started > 15_000) reading.done = true
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, name)
}

/** The frames on which the dialog was closing, once it has left the page. */
async function closingShowed(page: Page): Promise<Showing[]> {
  await page.waitForFunction(() => window.__e2eShowing?.done === true, undefined, {
    timeout: 20_000,
  })
  const frames = await page.evaluate(() => window.__e2eShowing?.frames ?? [])
  return frames.filter((f) => f.closing)
}

test.describe('What a closing overlay shows', () => {
  test('AC-O4: the Add sheet slides away showing what was added, not a cleared form', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const sheet = await openAddSheet(page, testInfo)
    await sheet.getByRole('textbox', { name: 'What' }).fill('laksa')
    await sheet.getByRole('spinbutton', { name: 'Amount' }).fill('6.50')
    await page.waitForTimeout(600) // past the moment a press still belongs to the opening
    await startReading(page, 'Add expense')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    const closing = await closingShowed(page)
    expect(closing.length, 'it stays to slide away').toBeGreaterThan(0)
    for (const f of closing) {
      expect(f.values, 'the entry as typed').toContain('laksa')
      expect(f.values, 'the entry as typed').toContain('6.50')
    }
    await expect
      .poll(async () => (await storedExpenses(page)).map((e) => e.itemName))
      .toContain('laksa')
  })

  test('AC-O4: after a quick add the palette leaves showing its query and its list', async ({
    page,
  }) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const palette = await openPalette(page)
    await palette.getByRole('combobox').fill('laksa 6.50')
    await expect(palette.getByRole('option', { name: /^Add "laksa" · S\$6\.50/ })).toBeVisible()
    await page.waitForTimeout(400)
    const options = await palette.getByRole('option').allTextContents()
    await startReading(page, 'Command palette')
    await page.keyboard.press('Enter')
    const closing = await closingShowed(page)
    expect(closing.length, 'it stays to animate out').toBeGreaterThan(0)
    for (const f of closing) {
      expect(f.values, 'the query as typed').toContain('laksa 6.50')
      expect(f.options, 'the list as it was').toEqual(options)
    }
    await expect
      .poll(async () => (await storedExpenses(page)).map((e) => e.itemName))
      .toContain('laksa')
  })
})

// ─── toasts (AC-O6, AC-O7) ────────────────────────────────────────────────────

test.describe('Toasts', () => {
  test('AC-O6: a toast rises into place from 16 px lower at 96 %, fading in', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    // The storage warning: every toast moves alike, and this one lasts 12 s, so it is still
    // there when a hold in WebKit lets its fade run.
    const frames = await record(
      page,
      { toasts: true, until: 'rest', minMs: 300, maxMs: longest(testInfo, 3000) },
      async () => {
        await warnStorageFull(page)
      },
    )
    await keep(testInfo, 'entering', frames)
    const toast = toastFrames(frames, 'Storage is full')
    const first = firstOf(toast, 'frame with the toast').toast
    const end = lastOf(toast, 'frame with the toast').toast
    // Its first frame is just under way, or, when frames are far apart, no further in than the
    // spring gets in the time since the frame before it (a CSS transition runs on the clock).
    const ran = springAt(
      TOAST_SPRING.k,
      TOAST_SPRING.c,
      firstShownGap(
        frames,
        (f) => f.toasts?.some((t) => t.text.includes('Storage is full')) ?? false,
      ),
    )
    expect(shiftY(first.box, first.place), 'starts 16 px lower').toBeGreaterThanOrEqual(
      Math.min(11, 16 * (1 - ran)),
    )
    expect(shiftY(first.box, first.place), 'starts 16 px lower').toBeLessThanOrEqual(17)
    expect(scaleX(first.box, first.place), 'starts at 96 %').toBeGreaterThanOrEqual(0.955)
    expect(scaleX(first.box, first.place), 'starts at 96 %').toBeLessThanOrEqual(
      Math.max(0.975, 0.96 + 0.04 * ran),
    )
    expect(first.opacity, 'starts see-through').toBeLessThanOrEqual(Math.max(0.35, ran))
    const shifts = toast.map((f) => shiftY(f.toast.box, f.toast.place))
    expect(wrongWay(shifts, 'down', 0.6), 'rises one way').toEqual([])
    expect(
      wrongWay(
        toast.map((f) => f.toast.opacity),
        'up',
        0.01,
      ),
      'fades in one way',
    ).toEqual([])
    expect(moved(end), 'at rest, untransformed').toBe('')
    // Layout offsets are whole pixels: within one of the drawn box.
    expect(Math.abs(shiftY(end.box, end.place)), 'at rest in its place').toBeLessThanOrEqual(1)
    expect(end.opacity).toBe(1)
    if (!isPhone(testInfo)) {
      const fit = curveError(
        withLag(toast.map((f) => ({ t: f.t, p: 1 - shiftY(f.toast.box, f.toast.place) / 16 }))),
        (ms) => springAt(TOAST_SPRING.k, TOAST_SPRING.c, ms),
      )
      expect(fit.error, 'on the toast spring (k 420, c 32)').toBeLessThanOrEqual(0.06)
    }
  })

  test('AC-O6: dismissed, the lowest toast fades out where it is; the one above then slides down into its place', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    // The lowest lasts 4 s: shown, then at once above it a toast that outlives any hold (the
    // quota warning lasts 12 s), and both at rest before the press.
    await quickAdd(page).fill('kopi 1.20')
    await quickAdd(page).press('Enter')
    await expect(page.locator('[data-toast]')).toHaveCount(1)
    await raiseQuotaToast(page, testInfo, 2)
    const lowest = page.locator('[data-toast]').filter({ hasText: 'Added "kopi" · S$1.20' })
    const frames = await record(
      page,
      { toasts: true, until: 'rest', minMs: 600, maxMs: longest(testInfo, 4000) },
      async () => {
        await lowest.getByRole('button', { name: 'Dismiss' }).click()
      },
    )
    await keep(testInfo, 'dismissing', frames)
    const a = toastFrames(frames, 'Added "kopi" · S$1.20')
    const b = toastFrames(frames, 'Storage is full')
    const slot = firstOf(a, 'frame with the dismissed toast').toast.place
    expect(slot.y, 'the dismissed toast is the lowest').toBeGreaterThan(
      firstOf(b, 'frame with the toast above').toast.place.y,
    )
    expect(lastOf(frames, 'frame').toasts?.length, 'the dismissed toast is gone').toBe(1)
    const goneAt = frames.find((f) => f.t > lastOf(a, 'frame').t)?.t ?? Infinity

    // The dismissed toast leaves where it is, still under a press: its slot stays until it has
    // gone, and it does not slide sideways.
    for (const f of a) {
      expect(f.toast.place.y, 'it leaves from its own slot').toBeCloseTo(slot.y, 0)
      const sideways = f.toast.box.x + f.toast.box.width / 2 - (slot.x + slot.width / 2)
      expect(Math.abs(sideways), 'it leaves in place, not sideways').toBeLessThanOrEqual(1)
      if (f.toast.opacity >= 0.2) expect(f.toast.hit, 'a press still lands on it').toBe(true)
    }

    // The toast above then slides down into the lowest slot, and ends exactly there.
    const bEnd = lastOf(b, 'frame with the toast above').toast
    expect(bEnd.place.y + bEnd.place.height, 'it takes the lowest slot').toBeCloseTo(
      slot.y + slot.height,
      0,
    )
    expect(moved(bEnd), 'it ends untransformed').toBe('')
    expect(Math.abs(bEnd.box.y - bEnd.place.y), 'it ends exactly in its slot').toBeLessThanOrEqual(
      1,
    )
    const sliding = b.filter((f) => f.t >= goneAt)
    const tops = sliding.map((f) => f.toast.box.y)
    // Down one way, but for the toast spring's own overshoot past the slot (about 2 % of the
    // slide, so over 1 px for a 54 px one): a frame can land on its peak, the next in the slot.
    const slide = Math.abs(bEnd.box.y - (tops[0] ?? bEnd.box.y))
    const bounce = Math.max(1, slide * springOvershoot(TOAST_SPRING.k, TOAST_SPRING.c))
    expect(wrongWay(tops, 'up', bounce + 0.05), 'it slides down one way').toEqual([])
    expect(Math.max(...tops), 'no more than 2 px past its slot').toBeLessThanOrEqual(bEnd.box.y + 2)
    if (isPhone(testInfo)) return

    // The dismissed toast sinks a little (8 px) as it shrinks and fades, one way.
    const shifts = a.map((f) => shiftY(f.toast.box, f.toast.place))
    expect(wrongWay(shifts, 'up', 0.6), 'it sinks one way').toEqual([])
    expect(Math.max(...shifts), 'no further than 8 px down').toBeLessThanOrEqual(9)
    expect(
      wrongWay(
        a.map((f) => f.toast.opacity),
        'down',
        0.01,
      ),
      'it fades out one way',
    ).toEqual([])
    const bStart = firstOf(b, 'frame with the toast above').toast.box
    for (const f of b.filter((x) => x.t < goneAt))
      expect(f.toast.box.y, 'the toast above waits while the other leaves').toBeCloseTo(bStart.y, 0)
    const t0 = firstOf(frames, 'frame').t
    const held = Math.max(
      startDelay(a.map((f) => ({ t: f.t, v: f.toast.box.y }))),
      startDelay(a.map((f) => ({ t: f.t, v: f.toast.opacity }))),
    )
    expect(
      goneAt - t0 - busyTime(frames, t0, goneAt) - held,
      `the dismissed toast is removed within 1.5 s (${String(Math.round(held))} ms held)`,
    ).toBeLessThanOrEqual(1500)
    const last = lastOf(a, 'frame with the dismissed toast').toast
    expect(shiftY(last.box, last.place), 'it leaves 8 px down').toBeGreaterThanOrEqual(5)
    expect(scaleX(last.box, last.place), 'it leaves at 96 %').toBeLessThanOrEqual(0.975)
    expect(last.opacity, 'it leaves see-through').toBeLessThanOrEqual(0.15)
    const travel = bEnd.box.y - bStart.y
    const peak = springPeakRate(TOAST_SPRING.k, TOAST_SPRING.c) * travel
    expect(
      fastestRate(sliding.map((f) => ({ t: f.t, v: f.toast.box.y }))),
      'no jump: never faster than 1.5 × the spring at its fastest',
    ).toBeLessThanOrEqual(peak * 1.5)
    const fit = curveError(
      withLag(sliding.map((f) => ({ t: f.t, p: (f.toast.box.y - bStart.y) / travel }))),
      (ms) => springAt(TOAST_SPRING.k, TOAST_SPRING.c, ms),
    )
    expect(fit.error, 'on the toast spring (k 420, c 32)').toBeLessThanOrEqual(0.08)
  })

  test('AC-O7: the countdown bar runs out evenly over the toast’s 4 s', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const frames = await record(page, { toasts: true, maxMs: 3600 }, async () => {
      await quickAdd(page).fill('kopi 1.20')
      await quickAdd(page).press('Enter')
    })
    await keep(testInfo, 'counting down', frames)
    const toast = toastFrames(frames, 'Added "kopi" · S$1.20')
    const bars = toast.flatMap((f) => (f.toast.bar === null ? [] : [{ t: f.t, v: f.toast.bar }]))
    expect(bars.length, 'a countdown bar shows on a timed toast').toBeGreaterThan(10)
    expect(
      wrongWay(
        bars.map((s) => s.v),
        'down',
        0.01,
      ),
      'it only runs down',
    ).toEqual([])
    if (isPhone(testInfo)) return
    const t0 = firstOf(toast, 'frame with the toast').t
    expect(firstOf(bars, 'bar').v, 'it starts full').toBeGreaterThanOrEqual(0.95)
    for (const at of [1000, 2000, 3000]) {
      const near = bars.reduce((a, b) =>
        Math.abs(b.t - t0 - at) < Math.abs(a.t - t0 - at) ? b : a,
      )
      // Linear: 1 - t / 4 s, ±0.1 (a busy machine may hold it back by the time it lost).
      const lost = busyTime(toast, t0, near.t)
      const what = `at ${String(at)} ms it is ${String(1 - at / 4000)} full (±0.1)`
      expect(near.v, what).toBeGreaterThanOrEqual(1 - (near.t - t0) / 4000 - 0.1)
      expect(near.v, what).toBeLessThanOrEqual(1 - (near.t - t0 - lost) / 4000 + 0.1)
    }
  })

  test('AC-O6: Undo and Dismiss stay pressable while toasts come and go', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const before = (await storedExpenses(page)).length
    const toasts = page.locator('[data-toast]')
    await quickAddToast(page, testInfo, 'kopi 1.20', 1)
    // Past the moment a press still belongs to what was there (400 ms from when the toast was
    // painted, which a busy WebKit can paint late).
    await page.waitForTimeout(800)
    await toasts
      .filter({ hasText: 'Added "kopi" · S$1.20' })
      .getByRole('button', { name: 'Undo' })
      .click()
    await expect
      .poll(async () => (await storedExpenses(page)).length, 'Undo undid the add')
      .toBe(before)
    await expectGone(toasts)

    // The two adds and the presses close together: a quick-add toast lasts only 4 s.
    for (const [phrase, shown] of [
      ['kopi 1.30', 1],
      ['kopi 1.40', 2],
    ] as const) {
      await quickAdd(page).fill(phrase)
      await quickAdd(page).press('Enter')
      await expect(toasts).toHaveCount(shown)
    }
    await page.waitForTimeout(800) // past that moment again
    expect((await storedExpenses(page)).length).toBe(before + 2)
    await toasts
      .filter({ hasText: 'Added "kopi" · S$1.30' })
      .getByRole('button', { name: 'Dismiss' })
      .click()
    // At once, while the dismissed one leaves: the other toast's Undo still works.
    await toasts
      .filter({ hasText: 'Added "kopi" · S$1.40' })
      .getByRole('button', { name: 'Undo' })
      .click({ force: true })
    await expect
      .poll(async () => (await storedExpenses(page)).map((e) => e.amount), 'the 1.40 add undone')
      .not.toContain(1.4)
    expect((await storedExpenses(page)).map((e) => e.amount)).toContain(1.3)
    await expectGone(toasts)
  })
})

// ─── rapid toggling (AC-O8) ───────────────────────────────────────────────────

/** Presses the two keys in turn, the first one first, `times` presses in all, as fast as keys go. */
async function toggle(page: Page, keys: readonly [string, string], times: number) {
  for (let i = 0; i < times; i++) await page.keyboard.press(keys[i % 2] ?? 'Escape')
}

test.describe('Rapid toggling', () => {
  for (const [what, name, key, times] of [
    ['the palette', 'Command palette', 'Control+k', 20],
    ['the Add sheet', 'Add expense', 'Control+n', 10],
  ] as const) {
    test(`AC-O8: ${what} toggled ${String(times)} times as fast as keys go ends as asked, never doubled`, async ({
      page,
    }, testInfo) => {
      await loadInMotion(page, '/pulse', { expenses: RICH })
      const layer = dialog(page, name)
      /**
       * Presses the keys in turn while recording every frame, then records on until the layer
       * has settled as `until` says: the frames of the toggling and of its end.
       */
      const togglingThen = async (keys: readonly [string, string], until: 'open' | 'gone') => {
        const toggling = await startRecording(page, { layer: name, maxMs: 60_000 })
        await toggle(page, keys, times + 1)
        const during = await finishRecording(page, toggling, { now: true })
        const after = await record(
          page,
          { layer: name, until, maxMs: longest(testInfo, 4000) },
          async () => {},
        )
        for (const f of [...during, ...after]) {
          expect(f.layer?.dialogs, 'never two dialogs').toBeLessThanOrEqual(1)
          expect(f.boxes, 'never two layer boxes').toBeLessThanOrEqual(1)
        }
        return after
      }

      // Open, close, open, … and open last: it ends open, at rest, with focus inside.
      const opened = await togglingThen([key, 'Escape'], 'open')
      const end = lastOf(withPanel(opened), 'frame with the layer')
      expect(moved(end.panel), 'open: at rest in its place').toBe('')
      expect(end.panel.opacity, 'open: opaque').toBe(1)
      expect(end.panel.inert, 'open: not inert').toBe(false)
      expect(end.layer.focused, 'open: focus inside').toBe(true)
      expect(end.boxes, 'open: one layer box').toBe(1)
      await expect(layer).toBeVisible()

      // Close, open, close, … and close last: it ends closed, and nothing is left behind,
      // soon after the last press (pressing them all takes a while on a busy machine).
      const closed = await togglingThen(['Escape', key], 'gone')
      const last = lastOf(closed, 'frame')
      expect(last.layer?.dialogs, 'closed: gone').toBe(0)
      expect(last.boxes, 'closed: no layer box left').toBe(0)
      if (!isPhone(testInfo)) expectGoneWithin(closed, 1500, `${what}, closed`)
      await expect(layer).toHaveCount(0)
    })
  }
})

// ─── the ledger swipe (AC-S1 … AC-S7) ─────────────────────────────────────────

const editSheet = (page: Page) => dialog(page, 'Edit expense')

/** Nothing opened and nothing deleted by what just happened, once a press had time to act. */
async function expectNothingPressed(page: Page, rows: number, what: string) {
  await page.waitForTimeout(400)
  await expect(editSheet(page), `${what}: no Edit sheet`).toHaveCount(0)
  expect((await storedExpenses(page)).length, `${what}: nothing deleted`).toBe(rows)
}

const editButton = (page: Page, id: string): Locator =>
  page.locator(`[data-ledger-row="${id}"]`).getByRole('button', { name: /^Edit / })

/** The middle of a locator's box, now. */
async function middleOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (!box) throw new Error('nothing to press')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Where a mouse swipe on a row starts: 30 px in from its Edit button's right end. */
const grip = (box: Box) => ({
  x: Math.round(box.x + box.width - 30),
  y: Math.round(box.y + box.height / 2),
})

/** The frames of a row once released: from the last frame it was furthest out on. */
const fromFurthest = (frames: readonly Frame[]) => {
  const xs = frames.map((f) => f.row?.x ?? 0)
  const at = xs.lastIndexOf(Math.min(...xs))
  return frames.slice(at).flatMap((f) => (f.row ? [{ t: f.t, x: f.row.x }] : []))
}

/** What in the row is drawn off its place now (see `moved`). */
async function movedInRow(page: Page, id: string): Promise<string[]> {
  const looks = await page.evaluate(
    (rowId) =>
      [
        ...document.querySelectorAll(
          `[data-ledger-row="${CSS.escape(rowId)}"], [data-ledger-row="${CSS.escape(rowId)}"] *`,
        ),
      ].map((el) => {
        const s = getComputedStyle(el)
        return { transform: s.transform, translate: s.translate, scale: s.scale, rotate: s.rotate }
      }),
    id,
  )
  return looks.map(moved).filter(Boolean)
}

/**
 * Flicks one of rows 3 to 8 at a flick's pace (flickRow) and returns its id, saying in the
 * report how its moves were paced. On a machine too busy to keep any pace on six rows the test
 * is skipped locally, and says so in the report and the log; in CI it fails instead (Playwright
 * retries it there), so the gate never goes green without having judged a flick.
 */
async function flickAtPace(
  page: Page,
  testInfo: TestInfo,
  pointerType: 'mouse' | 'touch',
): Promise<string | null> {
  const rows: string[] = []
  for (let nth = 3; nth <= 8; nth++) rows.push((await ledgerRow(page, nth)).id)
  const flick = await flickRow(page, rows, pointerType)
  if (!flick) {
    const unjudged = 'no flick kept its pace (120 ms from press to release) on six rows'
    if (process.env.CI) throw new Error(`AC-S2 unjudged in CI: ${unjudged}`)
    testInfo.annotations.push({ type: 'unjudged', description: unjudged })
    console.warn(`[unjudged] ${testInfo.title}: ${unjudged}; skipped`)
    test.skip(true, 'the machine was too busy to flick at pace')
    return null
  }
  testInfo.annotations.push({
    type: 'flick',
    description: `moves paced by ${flick.pace === 'frames' ? 'the page’s frames' : '16 ms timers'}`,
  })
  return flick.id
}

test.describe('Ledger swipe with a mouse', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'a mouse swipe: Chromium')
    // The swipe is the one-hand gesture: a phone-wide window.
    await page.setViewportSize({ width: 390, height: 844 })
    await loadInMotion(page, '/ledger', { expenses: SIXTY })
  })

  test('AC-S1, AC-S2, AC-S4: a slow drag past 76 px reveals Delete; the click that ends it edits nothing', async ({
    page,
  }) => {
    const row = await ledgerRow(page, 1)
    await mouseSwipe(page, grip(row.box), -100, {
      steps: 10,
      stepMs: 60,
      restMs: 150,
      release: false,
    })
    expect((await rowNow(page, row.id))?.x, 'the row follows the pointer').toBeCloseTo(-100, 0)
    const frames = await record(
      page,
      { row: row.id, until: 'still', minMs: 300, maxMs: 3000 },
      () => page.mouse.up(),
    )
    await expectRowAt(page, row.id, SWIPE.revealed)
    const xs = fromFurthest(frames).map((s) => s.x)
    expect(wrongWay(xs, 'up', 0.5), 'snaps to −96 one way').toEqual([])
    expect(Math.max(...xs), 'no overshoot past −96').toBeLessThanOrEqual(-95.5)
    // The action's own short fade (its colour transition) catches up with the row.
    await expect
      .poll(async () => (await rowNow(page, row.id))?.action, { message: 'Delete shows as at −96' })
      .toBeCloseTo(actionOpacityAt(SWIPE.revealed), 1)
    await expectNothingPressed(page, SIXTY.length, 'the click that ended the drag')
    await expectRowAt(page, row.id, SWIPE.revealed)
  })

  test('AC-S2, AC-S3: a short slow drag springs back to rest', async ({ page }, testInfo) => {
    const row = await ledgerRow(page, 2)
    await mouseSwipe(page, grip(row.box), -40, {
      steps: 4,
      stepMs: 60,
      restMs: 150,
      release: false,
    })
    expect((await rowNow(page, row.id))?.x, 'the row follows the pointer').toBeCloseTo(-40, 0)
    const frames = await record(
      page,
      { row: row.id, until: 'still', minMs: 300, maxMs: 3000 },
      () => page.mouse.up(),
    )
    await keep(testInfo, 'springing back', frames)
    await expectRowAt(page, row.id, 0)
    const back = fromFurthest(frames)
    const xs = back.map((s) => s.x)
    expect(wrongWay(xs, 'up', 0.5), 'springs back one way').toEqual([])
    expect(Math.max(...xs), 'no overshoot past its place').toBeLessThanOrEqual(0.5)
    const start = firstOf(back, 'frame').x
    const fit = curveError(withLag(back.map((s) => ({ t: s.t, p: 1 - s.x / start }))), (ms) =>
      springAt(ROW_SPRING.k, ROW_SPRING.c, ms),
    )
    expect(fit.error, 'on the row spring (k 420, c 40), from rest').toBeLessThanOrEqual(0.06)
    const home = back.find((s) => Math.abs(s.x) < 0.5)
    const t0 = firstOf(back, 'frame').t
    const took = (home?.t ?? Infinity) - t0
    expect(took - busyTime(back, t0, t0 + took), 'home within 600 ms').toBeLessThanOrEqual(600)
    await expect
      .poll(async () => (await rowNow(page, row.id))?.action, { message: 'Delete hidden again' })
      .toBe(0)
    expect(await movedInRow(page, row.id), 'nothing in the row is left moved').toEqual([])
    await expectNothingPressed(page, SIXTY.length, 'the click that ended the drag')
  })

  test('AC-S2: a quick flick reveals Delete though it travels less than 76 px', async ({
    page,
  }, testInfo) => {
    const flicked = await flickAtPace(page, testInfo, 'mouse')
    if (!flicked) return
    await expectRowAt(page, flicked, SWIPE.revealed)
    await expectNothingPressed(page, SIXTY.length, 'the flick')
  })

  test('AC-S1: pulled far left the row gives only 12 % past −120; it never moves right of its place', async ({
    page,
  }) => {
    const row = await ledgerRow(page, 1)
    const at = grip(row.box)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let step = 1; step <= 20; step++) {
      const offset = -15 * step
      await page.mouse.move(at.x + offset, at.y)
      // Free to −120, then 12 % of the pull past it.
      await expect
        .poll(async () => Math.abs(((await rowNow(page, row.id))?.x ?? NaN) - draggedTo(offset)), {
          message: `pulled ${String(offset)} px, the row is at ${draggedTo(offset).toFixed(1)}`,
        })
        .toBeLessThanOrEqual(1.5)
      expect(
        (await rowNow(page, row.id))?.x,
        'never past the elastic bound',
      ).toBeGreaterThanOrEqual(SWIPE.limit - SWIPE.elastic * (-offset + SWIPE.limit) - 1)
    }
    await page.mouse.up()
    await expectRowAt(page, row.id, SWIPE.revealed)

    const other = await ledgerRow(page, 4)
    const left = {
      x: Math.round(other.box.x + 40),
      y: Math.round(other.box.y + other.box.height / 2),
    }
    await page.mouse.move(left.x, left.y)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(left.x + 10 * step, left.y)
      await page.waitForTimeout(30)
      expect((await rowNow(page, other.id))?.x, 'a pull to the right moves nothing').toBe(0)
    }
    await page.mouse.up()
    await expectRowAt(page, other.id, 0)
    await expectNothingPressed(page, SIXTY.length, 'the drags')
  })

  test('AC-S3: the swipe Delete action fades in with the drag: 0.64 at −30, 0.76 at −60, 0.92 at −100', async ({
    page,
  }) => {
    const row = await ledgerRow(page, 2)
    const at = grip(row.box)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (const x of [-30, -60, -100]) {
      await page.mouse.move(at.x + x, at.y, { steps: 3 })
      await expectRowAt(page, row.id, x)
      // Held there, the action's own short fade catches up with the row.
      await expect
        .poll(async () => (await rowNow(page, row.id))?.action, {
          message: `Delete at ${String(x)}`,
        })
        .toBeCloseTo(actionOpacityAt(x), 1)
    }
    await page.mouse.up()
    await expectRowAt(page, row.id, SWIPE.revealed)
    await expect
      .poll(async () => (await rowNow(page, row.id))?.action, { message: 'Delete at −96' })
      .toBeCloseTo(actionOpacityAt(SWIPE.revealed), 1)
  })

  test('AC-S4: a tap on a revealed row closes it and opens nothing', async ({ page }) => {
    const row = await ledgerRow(page, 1)
    await mouseSwipe(page, grip(row.box), -100, { steps: 10, stepMs: 60, restMs: 150 })
    await expectRowAt(page, row.id, SWIPE.revealed)
    await page.waitForTimeout(300)
    const at = await middleOf(editButton(page, row.id))
    await page.mouse.click(at.x, at.y)
    await expectRowAt(page, row.id, 0)
    await expectNothingPressed(page, SIXTY.length, 'the tap on the revealed row')
  })

  test('AC-S4: the swipe Delete action deletes that one row, once', async ({ page }) => {
    const row = await ledgerRow(page, 2)
    await mouseSwipe(page, grip(row.box), -100, { steps: 10, stepMs: 60, restMs: 150 })
    await expectRowAt(page, row.id, SWIPE.revealed)
    await page.waitForTimeout(300)
    const at = await middleOf(page.locator(`[data-ledger-row="${row.id}"] [data-swipe-delete]`))
    await page.mouse.click(at.x, at.y)
    await expect
      .poll(async () => (await storedExpenses(page)).length, 'one row deleted')
      .toBe(SIXTY.length - 1)
    expect(
      (await storedExpenses(page)).map((e) => e.id),
      'that row',
    ).not.toContain(row.id)
    await expect(page.locator(`[data-ledger-row="${row.id}"]`)).toHaveCount(0)
    await page.waitForTimeout(600)
    expect((await storedExpenses(page)).length, 'and only once').toBe(SIXTY.length - 1)
  })

  test('AC-S4: a swipe that starts on the trash reveals Delete and deletes nothing', async ({
    page,
  }) => {
    const row = await ledgerRow(page, 3)
    const trash = page
      .locator(`[data-ledger-row="${row.id}"]`)
      .getByRole('button', { name: /^Delete / })
    const at = await middleOf(trash)
    await mouseSwipe(page, at, -100, { steps: 10, stepMs: 60, restMs: 150 })
    await expectRowAt(page, row.id, SWIPE.revealed)
    await expectNothingPressed(page, SIXTY.length, 'the click on the trash that ended the swipe')
  })

  test('AC-S6: a drag that catches a row still springing back takes it from where it is', async ({
    page,
  }) => {
    const row = await ledgerRow(page, 1)
    // Pointer events dispatched in the page, so the catch lands mid-spring on any machine.
    const seen = await page.evaluate(async (rowId) => {
      const outer = document.querySelector(`[data-ledger-row="${CSS.escape(rowId)}"]`)
      const button = outer?.querySelector('button[aria-label^="Edit "]')
      if (!outer || !button) throw new Error(`row ${rowId} has no Edit button`)
      const xNow = () => button.getBoundingClientRect().left - outer.getBoundingClientRect().left
      const r = button.getBoundingClientRect()
      const y = r.top + r.height / 2
      let px = r.right - 40
      const fire = (type: string, buttons: number) =>
        button.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons,
            clientX: px,
            clientY: y,
          }),
        )
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const frames = async (n: number) => {
        for (let i = 0; i < n; i++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      // A slow 40 px drag, held, released: the row springs back...
      fire('pointerdown', 1)
      for (let i = 0; i < 4; i++) {
        await wait(60)
        px -= 10
        fire('pointermove', 1)
      }
      await wait(150)
      fire('pointerup', 0)
      // ...and a press catches it on its way (once it has started back), then drags it on.
      for (let i = 0; i < 60 && xNow() <= -37; i++) await frames(1)
      const caught = xNow()
      fire('pointerdown', 1)
      await wait(16)
      px -= 4
      const moving = xNow()
      fire('pointermove', 1)
      await frames(2)
      const taken = xNow()
      for (let i = 0; i < 5; i++) {
        await wait(16)
        px -= 4
        fire('pointermove', 1)
      }
      await frames(2)
      const dragged = xNow()
      await wait(150)
      fire('pointerup', 0)
      return { caught, moving, taken, dragged }
    }, row.id)
    const told = JSON.stringify(seen)
    expect(seen.caught, `caught on its way back (${told})`).toBeGreaterThan(-39)
    expect(seen.caught, `caught on its way back (${told})`).toBeLessThan(-1)
    // The drag takes the row from where the spring had it when the drag began (the first move,
    // or the frame after it), 4 px on: never from where the drag started (−40) or the spring was
    // going (0). Within a frame the spring moves it a few px more.
    expect(seen.taken - seen.moving, `taken from where it was (${told})`).toBeGreaterThanOrEqual(
      -4 - 1.5,
    )
    expect(seen.taken - seen.moving, `taken from where it was (${told})`).toBeLessThanOrEqual(
      -4 + 12,
    )
    expect(seen.dragged, `then it follows the pointer (${told})`).toBeCloseTo(seen.taken - 20, 0)
    await expectRowAt(page, row.id, 0)
    await expectNothingPressed(page, SIXTY.length, 'the drags')
  })
})

test.describe('Ledger swipe with a finger', () => {
  test('AC-S5: Chromium touch: a sideways drag reveals Delete; a vertical one scrolls the page and leaves the row', async ({
    browser,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'Chromium touch input through the DevTools protocol')
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
      serviceWorkers: 'block',
      timezoneId: 'Asia/Singapore',
      locale: 'en-US',
    })
    try {
      const page = await context.newPage()
      await loadInMotion(page, '/ledger', { expenses: SIXTY })
      const cdp = await context.newCDPSession(page)

      const row = await ledgerRow(page, 2)
      const from = { x: row.box.x + row.box.width - 40, y: row.box.y + row.box.height / 2 }
      await touchSwipe(cdp, page, from, { dx: -110, dy: 0 }, { steps: 10, stepMs: 30, restMs: 100 })
      await expectRowAt(page, row.id, SWIPE.revealed)
      await expectNothingPressed(page, SIXTY.length, 'the sideways drag')

      const other = await ledgerRow(page, 5)
      const scrolled = await page.evaluate(() => window.scrollY)
      await touchSwipe(
        cdp,
        page,
        { x: other.box.x + 100, y: other.box.y + other.box.height / 2 },
        { dx: 0, dy: -240 },
        { steps: 12, stepMs: 16, restMs: 0 },
      )
      await expect
        .poll(() => page.evaluate(() => window.scrollY), 'the page scrolled')
        .toBeGreaterThan(scrolled + 100)
      const now = await rowNow(page, other.id)
      expect(now?.x, 'the row stays in place').toBe(0)
      expect(now?.action, 'Delete stays hidden').toBe(0)
      await expectNothingPressed(page, SIXTY.length, 'the vertical drag')
    } finally {
      await context.close()
    }
  })

  test('AC-S5: iPhone: touch pointers reveal and spring back; the rows leave vertical panning to the browser; a tap closes a revealed row', async ({
    page,
  }, testInfo) => {
    test.skip(!isPhone(testInfo), 'the iPhone (WebKit) project')
    await loadInMotion(page, '/ledger', { expenses: SIXTY })
    const touch = async (id: string, path: readonly number[]) => {
      await pointerSwipe(page, id, { pointerType: 'touch', path, stepMs: 20, restMs: 150 })
    }
    const row = await ledgerRow(page, 1)
    const actions = await page.evaluate((id) => {
      const outer = document.querySelector(`[data-ledger-row="${id}"]`)
      const content = outer?.querySelector('button[aria-label^="Edit "]')?.parentElement
      return [outer, content].map((el) => (el ? getComputedStyle(el).touchAction : ''))
    }, row.id)
    for (const action of actions)
      expect(action, 'vertical panning stays the browser’s').toContain('pan-y')

    let frames = await record(
      page,
      { row: row.id, until: 'still', minMs: 600, maxMs: 15_000 },
      () => touch(row.id, evenPath(-100, 10)),
    )
    await expectRowAt(page, row.id, SWIPE.revealed, 15_000)
    expect(
      wrongWay(
        fromFurthest(frames).map((s) => s.x),
        'up',
        0.5,
      ),
      'snaps to −96 one way',
    ).toEqual([])

    const other = await ledgerRow(page, 2)
    frames = await record(page, { row: other.id, until: 'still', minMs: 600, maxMs: 15_000 }, () =>
      touch(other.id, evenPath(-40, 4)),
    )
    await expectRowAt(page, other.id, 0, 15_000)
    expect(
      wrongWay(
        fromFurthest(frames).map((s) => s.x),
        'up',
        0.5,
      ),
      'springs back one way',
    ).toEqual([])

    await page.waitForTimeout(300)
    const at = await middleOf(editButton(page, row.id))
    await page.touchscreen.tap(at.x, at.y)
    await expectRowAt(page, row.id, 0, 15_000)
    await expectNothingPressed(page, SIXTY.length, 'the swipes and the tap on the revealed row')
  })

  test('AC-S2: iPhone: a quick flick of a finger reveals Delete though it travels less than 76 px', async ({
    page,
  }, testInfo) => {
    test.skip(!isPhone(testInfo), 'the iPhone (WebKit) project')
    await loadInMotion(page, '/ledger', { expenses: SIXTY })
    const flicked = await flickAtPace(page, testInfo, 'touch')
    if (!flicked) return
    await expectRowAt(page, flicked, SWIPE.revealed, 15_000)
    await expectNothingPressed(page, SIXTY.length, 'the flick')
  })
})

test.describe('Ledger swipe over 5,000 rows', () => {
  test('AC-S7: in the virtual list a row swipes open, closes, and its swipe Delete deletes it', async ({
    page,
  }, testInfo) => {
    test.slow(true, '5,000 rows')
    const phone = isPhone(testInfo)
    if (!phone) await page.setViewportSize({ width: 390, height: 844 })
    const many = manyRows(5000)
    await loadInMotion(page, '/ledger?range=all', { expenses: many })
    await expect(page.getByText('5000 entries', { exact: true })).toBeVisible()
    const row = await ledgerRow(page, 3)
    const reveal = async () => {
      if (phone)
        await pointerSwipe(page, row.id, {
          pointerType: 'touch',
          path: evenPath(-100, 10),
          stepMs: 20,
          restMs: 150,
        })
      else await mouseSwipe(page, grip(row.box), -100, { steps: 10, stepMs: 60, restMs: 150 })
      await expectRowAt(page, row.id, SWIPE.revealed, phone ? 15_000 : 5000)
      await page.waitForTimeout(300)
    }
    const press = async (target: Locator) => {
      const at = await middleOf(target)
      if (phone) await page.touchscreen.tap(at.x, at.y)
      else await page.mouse.click(at.x, at.y)
    }

    await reveal()
    await press(editButton(page, row.id))
    await expectRowAt(page, row.id, 0, phone ? 15_000 : 5000)
    await expectNothingPressed(page, many.length, 'the tap that closed the row')

    await reveal()
    await press(page.locator(`[data-ledger-row="${row.id}"] [data-swipe-delete]`))
    await expect
      .poll(async () => (await storedExpenses(page)).length, 'one row deleted')
      .toBe(many.length - 1)
    expect(
      (await storedExpenses(page)).map((e) => e.id),
      'that row',
    ).not.toContain(row.id)
  })
})

// ─── reduced motion (AC-R1 … AC-R4) ───────────────────────────────────────────

/** Every part's frames, as text, where it was moved off its place (see `moved`). */
function movedFrames(frames: readonly Frame[]): string[] {
  return frames.flatMap((f) => {
    const parts: (Look | null | undefined)[] = [
      f.layer?.panel,
      f.layer?.backdrop,
      ...(f.toasts ?? []),
    ]
    return parts.flatMap((p) => (p && moved(p) ? [`${f.t.toFixed(0)}: ${moved(p)}`] : []))
  })
}

/**
 * The longest any part of the layer showed an in-between opacity (ms), less the time a busy
 * machine took from the page meanwhile (see busyTime).
 */
function longestFade(frames: readonly Frame[]): number {
  const shown = withPanel(frames)
  return (
    Math.max(
      transitionSpan(shown.map((f) => ({ t: f.t, v: f.panel.opacity }))),
      transitionSpan(shown.map((f) => ({ t: f.t, v: f.layer.backdrop?.opacity ?? 0 }))),
    ) - busyTime(shown, -Infinity, Infinity)
  )
}

test.describe('Reduced motion', () => {
  test('AC-R1: sheets and the palette appear and leave without moving, fading for 150 ms at most', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH, motion: 'reduce' })
    const layers: [string, () => Promise<void>][] = [
      ['Add expense', () => openAddSheet(page, testInfo).then(() => undefined)],
      ['Command palette', () => openPalette(page).then(() => undefined)],
    ]
    if (!isPhone(testInfo))
      layers.push([
        'Settings',
        () => page.getByRole('button', { name: 'Settings', exact: true }).click(),
      ])
    for (const [name, open] of layers) {
      const opening = await record(
        page,
        { layer: name, until: 'open', minMs: 400, maxMs: longest(testInfo, 3000) },
        open,
      )
      expect(movedFrames(opening), `${name} opening: no frame moved`).toEqual([])
      const closing = await record(
        page,
        { layer: name, until: 'gone', minMs: 400, maxMs: longest(testInfo, 3000) },
        () => page.keyboard.press('Escape'),
      )
      expect(movedFrames(closing), `${name} closing: no frame moved`).toEqual([])
      expect(lastOf(closing, 'frame').layer?.dialogs, `${name}: gone`).toBe(0)
      if (isPhone(testInfo)) continue
      expect(longestFade(opening), `${name} opening: fades for 150 ms at most`).toBeLessThanOrEqual(
        150 + 17,
      )
      expect(longestFade(closing), `${name} closing: fades for 150 ms at most`).toBeLessThanOrEqual(
        150 + 17,
      )
      // Faded out within 150 ms and taken out of the page: 300 ms, and a few frames for the page.
      expectGoneWithin(closing, 350, name)
    }
  })

  test('AC-R2: toasts come, go and close ranks without moving, and show no countdown', async ({
    page,
  }, testInfo) => {
    await loadInMotion(page, '/pulse', { expenses: RICH, motion: 'reduce' })
    // Recorded for a fixed while, never waited out: a hold in WebKit could outlast the 4 s the
    // quick-add toast lasts. Above it, the quota warning (12 s).
    const all: Frame[] = []
    for (const raise of [
      async () => {
        await quickAdd(page).fill('kopi 1.20')
        await quickAdd(page).press('Enter')
      },
      async () => {
        await warnStorageFull(page)
      },
    ])
      all.push(...(await record(page, { toasts: true, maxMs: 800 }, raise)))
    await expect(page.locator('[data-toast]')).toHaveCount(2)
    const leaving = await record(
      page,
      { toasts: true, until: 'rest', minMs: 400, maxMs: longest(testInfo, 3000) },
      async () => {
        await page
          .locator('[data-toast]')
          .filter({ hasText: 'Added "kopi" · S$1.20' })
          .getByRole('button', { name: 'Dismiss' })
          .click()
      },
    )
    all.push(...leaving)
    expect(movedFrames(all), 'no toast frame moved: no slide, no FLIP').toEqual([])
    const bars = all.flatMap((f) => (f.toasts ?? []).filter((t: ToastLook) => t.bar !== null))
    expect(bars.length, 'no countdown bar').toBe(0)
    const slot = firstOf(toastFrames(leaving, 'Added "kopi" · S$1.20'), 'dismissed toast').toast
      .place
    const remaining = lastOf(leaving, 'frame').toasts ?? []
    expect(remaining.length, 'the dismissed toast is gone').toBe(1)
    expect(
      (remaining[0]?.place.y ?? 0) + (remaining[0]?.place.height ?? 0),
      'the other toast takes the lowest slot',
    ).toBeCloseTo(slot.y + slot.height, 0)
    expect(
      Math.abs((remaining[0]?.box.y ?? 0) - (remaining[0]?.place.y ?? 0)),
      'drawn right in it',
    ).toBeLessThanOrEqual(1)
    if (isPhone(testInfo)) return
    const dismissed = toastFrames(leaving, 'Added "kopi" · S$1.20')
    const fading = dismissed.map((f) => ({ t: f.t, v: f.toast.opacity }))
    expect(
      transitionSpan(fading) - busyTime(dismissed, -Infinity, Infinity),
      'it fades for 150 ms at most',
    ).toBeLessThanOrEqual(150 + 17)
    const t0 = firstOf(leaving, 'frame').t
    const goneAt = leaving.find((f) => f.t > lastOf(dismissed, 'frame').t)?.t ?? Infinity
    const held = startDelay(fading)
    expect(
      goneAt - t0 - busyTime(leaving, t0, goneAt) - held,
      `gone within 300 ms, and a few frames for the page (${String(Math.round(held))} ms held)`,
    ).toBeLessThanOrEqual(350)
  })

  test('AC-R3: a released swipe snaps back at once; held, the row still follows the pointer', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'a mouse swipe: Chromium (keyboard.spec covers the iPhone)')
    await page.setViewportSize({ width: 390, height: 844 })
    await loadInMotion(page, '/ledger', { expenses: SIXTY, motion: 'reduce' })
    const row = await ledgerRow(page, 1)
    await mouseSwipe(page, grip(row.box), -40, {
      steps: 4,
      stepMs: 60,
      restMs: 150,
      release: false,
    })
    expect((await rowNow(page, row.id))?.x, 'held, the row follows the pointer').toBeCloseTo(-40, 0)
    const frames = await transformFrames(
      page,
      `[data-ledger-row="${row.id}"], [data-ledger-row="${row.id}"] *`,
      async () => {
        await page.mouse.up()
      },
      300,
    )
    // The frames the release lands in may still show the drag (more of them on a busy machine);
    // a spring back would show a run of ever smaller offsets, ~20 of them.
    expect(new Set(frames).size, frames.join(' | ')).toBeLessThanOrEqual(2)
    await expectRowAt(page, row.id, 0)

    await mouseSwipe(page, grip(row.box), -100, {
      steps: 10,
      stepMs: 60,
      restMs: 150,
      release: false,
    })
    const reveal = await transformFrames(
      page,
      `[data-ledger-row="${row.id}"], [data-ledger-row="${row.id}"] *`,
      async () => {
        await page.mouse.up()
      },
      300,
    )
    expect(new Set(reveal).size, `revealing: ${reveal.join(' | ')}`).toBeLessThanOrEqual(2)
    await expectRowAt(page, row.id, SWIPE.revealed)
  })

  test('AC-R4: Reduce Motion turned on while a sheet slides in holds it still at once, and later opens and closes do not move', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'timing a live switch: Chromium')
    await loadInMotion(page, '/pulse', { expenses: RICH })
    const key = await startRecording(page, { layer: 'Add expense', maxMs: 1500 })
    await openAddSheet(page, testInfo)
    await page.waitForTimeout(60) // mid-way up
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // From the moment the page itself sees the setting (it reaches the page a little later).
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
    const switchedAt = await page.evaluate(() => performance.now())
    const frames = await finishRecording(page, key)
    await keep(testInfo, 'switching', frames)
    expect(
      movedFrames(frames.filter((f) => f.t < switchedAt)).length,
      'it was sliding before the switch',
    ).toBeGreaterThan(0)
    // The style follows the setting within a few frames (it can reach script a little before
    // it reaches the style), and from then on every frame shows the sheet in its place. Not the
    // slide running on to its end: that lasts up to 400 ms, longer than this window.
    const still = switchedAt + 100 + busyTime(frames, switchedAt, switchedAt + 100)
    expect(frames.filter((f) => f.t > still).length, 'frames after the switch').toBeGreaterThan(5)
    expect(movedFrames(frames.filter((f) => f.t > still)), 'held still from the switch on').toEqual(
      [],
    )
    await expect(dialog(page, 'Add expense')).toBeVisible()

    const closing = await record(page, { layer: 'Add expense', until: 'gone', maxMs: 3000 }, () =>
      page.keyboard.press('Escape'),
    )
    expect(movedFrames(closing), 'closing: no frame moved').toEqual([])
    expectGoneWithin(closing, 1500, 'the Add sheet')
    const reopening = await record(
      page,
      { layer: 'Add expense', until: 'open', minMs: 400, maxMs: 3000 },
      async () => {
        await openAddSheet(page, testInfo)
      },
    )
    expect(movedFrames(reopening), 'opening again: no frame moved').toEqual([])
    const toasting = await record(
      page,
      { toasts: true, until: 'rest', minMs: 300, maxMs: 3000 },
      async () => {
        await page.keyboard.press('Escape')
        await quickAdd(page).fill('kopi 1.20')
        await quickAdd(page).press('Enter')
      },
    )
    expect(movedFrames(toasting), 'a toast after the switch: no frame moved').toEqual([])
  })
})
