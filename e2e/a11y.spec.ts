import { test, expect } from '@playwright/test'
import {
  STATES,
  auditTargets,
  axeViolations,
  enterState,
  fieldFillProblems,
  horizontalOverflow,
  isPhone,
  refreshTransient,
  settle,
  switchTheme,
} from './support/a11y'

// The accessibility gate (F-066). axe-core 4.13 (WCAG 2.0-2.2 A/AA + best practices) on every
// route and every open state, in both themes, on Chromium at 1280 px and WebKit (iPhone) at
// 375 px: zero violations. Each state is opened once in the dark theme and scanned, then the OS
// scheme flips to light (the stored theme is `system`, so the app re-themes in place) and it is
// scanned again. On the phone each state also gets the touch target audit (AC-F4: a 44 px hit
// area at every control, fields filling their boxes) and, at 320 px, a check that nothing
// scrolls sideways or sticks out. Invented data, Singapore clock, reduced motion.

test.use({ timezoneId: 'Asia/Singapore', locale: 'en-US' })

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize(
    isPhone(testInfo) ? { width: 375, height: 812 } : { width: 1280, height: 800 },
  )
})

/** Every check is reported, not only the first that fails. */
const softly = expect.configure({ soft: true })

for (const state of STATES) {
  test(`${state.id} ${state.title}: no axe violations, dark and light`, async ({
    page,
  }, testInfo) => {
    const phone = isPhone(testInfo)
    test.slow(phone, 'two scans, the touch target audit and a 320 px reflow in WebKit')
    await enterState(page, testInfo, state, 'system')
    softly(await axeViolations(page), 'axe, dark theme').toEqual([])

    await switchTheme(page, 'light')
    await refreshTransient(page, testInfo, state)
    softly(await axeViolations(page), 'axe, light theme').toEqual([])

    if (!phone) return
    await refreshTransient(page, testInfo, state)
    const targets = await auditTargets(page)
    softly(targets.checked, 'AC-F4: controls in reach').toBeGreaterThan(0)
    softly(targets.problems, 'AC-F4: 44 px touch targets').toEqual([])
    softly(await fieldFillProblems(page), 'AC-F4: fields fill their boxes').toEqual([])
    // The smallest phone. The layout reflows to it; a part the app sizes by script as it opens
    // (a calendar) is opened again, as it would open on that phone.
    await page.setViewportSize({ width: 320, height: 720 })
    await settle(page)
    if (state.reopen) {
      await state.reopen(page)
      await settle(page)
    }
    softly(
      await horizontalOverflow(page, 320, state.knownReflow?.selector),
      '320 px: no sideways scrolling',
    ).toEqual([])
  })
}
