import { test, expect, type Locator, type Page } from '@playwright/test'

// Correct numbers end to end (T3): one definition of "today", "last 7 days", "month" and
// "year" behind Pulse, Ledger and Insights, measured in a real browser at a fixed Singapore
// clock. Invented data only. Amounts are seeded in SGD so every figure reads "S$…".

interface SeedExpense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  createdAt: string
}

let seq = 0
/** A row as the app stores it: `date` is local noon unless a time / offset is given. */
function row(
  date: string,
  amount: number,
  itemName = 'item',
  category = 'Food & Dining',
): SeedExpense {
  seq += 1
  const stored = date.length === 10 ? `${date}T12:00:00` : date
  return {
    id: `n${String(seq).padStart(5, '0')}`,
    itemName,
    amount,
    category,
    date: stored,
    createdAt: stored,
  }
}

const SGT = (local: string) => new Date(`${local}+08:00`)

async function seed(
  page: Page,
  opts: {
    expenses: readonly SeedExpense[]
    budgets?: Record<string, number>
    now: Date
    /** Install a controllable clock (timers + Date) instead of a fixed `Date`. */
    controllable?: boolean
  },
) {
  if (opts.controllable) await page.clock.install({ time: opts.now })
  else await page.clock.setFixedTime(opts.now)
  await page.addInitScript(
    ({ expenses, budgets }) => {
      // Init scripts run on every navigation: seed once so reloads keep what the test changed.
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem('expenses', JSON.stringify(expenses))
      localStorage.setItem('categoryBudgets', JSON.stringify(budgets))
      localStorage.setItem('spendtrack:currency', 'SGD')
    },
    { expenses: opts.expenses, budgets: opts.budgets ?? {} },
  )
}

/** Ready = local data hydrated and the lazy screen loaded (both show a status inside main). */
async function waitForApp(page: Page) {
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.locator('main [role="status"][aria-live="polite"]')).toHaveCount(0)
}

/** The Pulse hero total (reduced motion: the final value from the first paint). */
const heroTotal = (page: Page) => page.locator('[class*="clamp(1.75rem"]')

/** The Ledger header block: total and entry count. */
const ledgerSummary = (page: Page) =>
  page.getByRole('heading', { name: 'Ledger' }).locator('xpath=..')

/** Item names of the listed rows ("Edit kopi, S$1.25, Food & Dining" → "kopi"). */
const ledgerItemNames = (page: Page) =>
  page
    .getByRole('button', { name: /^Edit / })
    .evaluateAll((els) =>
      els.map((el) => ((el.getAttribute('aria-label') ?? '').split(',')[0] ?? '').slice(5)),
    )

const centreY = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no box')
  return box.y + box.height / 2
}

test.use({
  timezoneId: 'Asia/Singapore',
  locale: 'en-US',
  contextOptions: { reducedMotion: 'reduce' },
})

// ─── AC-1: "Last 7 days" never depends on the time of day ──────────────────────

test.describe('Last 7 days', () => {
  const expenses = [
    row('2026-10-11', 100, 'oct 11 noon'), // the 8th day back: out
    row('2026-10-11T15:59:00.000Z', 200, 'oct 11 late'), // 23:59 SGT on Oct 11: out
    row('2026-10-11T16:01:00.000Z', 3.1, 'oct 12 early'), // 00:01 SGT on Oct 12: in
    row('2026-10-12T00:00:00', 0.4, 'oct 12 midnight'), // in
    row('2026-10-15', 10, 'laksa'), // in
    row('2026-10-18T00:30:00', 1.25, 'kopi'), // today, early: in
    row('2026-10-18', 5.5, 'chicken rice'), // today at noon, still ahead of 09:00: in
    row('2026-10-19', 77, 'tomorrow'), // future-dated: out
  ]

  test('AC-1: the Ledger week is the same at 09:00 and 15:00 and matches Insights', async ({
    page,
  }) => {
    const lists: string[][] = []
    for (const clock of ['2026-10-18T09:00:00', '2026-10-18T15:00:00']) {
      await page.clock.setFixedTime(SGT(clock))
      if (lists.length === 0) await seed(page, { expenses, now: SGT(clock) })
      await page.goto('/ledger?range=week')
      await waitForApp(page)
      await expect(page.getByText('Last 7 days · Oct 12 – Oct 18', { exact: true })).toBeVisible()
      const summary = ledgerSummary(page)
      await expect(summary).toContainText('S$20.25')
      await expect(summary).toContainText('5 entries')
      lists.push((await ledgerItemNames(page)).sort())
    }
    expect(lists[0]).toEqual(['chicken rice', 'kopi', 'laksa', 'oct 12 early', 'oct 12 midnight'])
    expect(lists[1]).toEqual(lists[0])

    await page.goto('/insights')
    await waitForApp(page)
    await expect(page.getByRole('main')).toContainText('Last 7 days S$20.25')
    await expect(page.getByRole('main')).toContainText('Oct 12 – Oct 18')
  })
})

// ─── AC-2: like-for-like comparisons ──────────────────────────────────────────

test.describe('Comparison pill', () => {
  const expenses = [
    row('2025-03-10', 3000, 'rent 2025'),
    row('2025-10-18', 2000, 'last year, same day'), // inside "2025 to Oct 18"
    row('2025-10-19', 999, 'last year, day after'), // outside it
    row('2026-08-10', 800, 'august'),
    row('2026-09-03', 300, 'sep a'),
    row('2026-09-18T23:30:00', 202.67, 'sep b', 'Transportation'),
    row('2026-09-19', 400, 'sep c'), // after the like-for-like window
    row('2026-09-30', 95.2, 'sep d'),
    row('2026-10-01', 400, 'oct a'),
    row('2026-10-18T09:00:00', 308.8, 'oct b', 'Shopping'),
  ]

  test('AC-2: month to date vs the same days of last month, past months full vs full', async ({
    page,
  }) => {
    await seed(page, { expenses, now: SGT('2026-10-18T15:00:00') })
    await page.goto('/pulse')
    await waitForApp(page)

    await expect(heroTotal(page)).toHaveText('S$708.80')
    const up = page.locator('span.text-negative', { hasText: 'vs Sep 1–18' })
    await expect(up).toHaveText('Up 41.0% vs Sep 1–18')

    await page.getByRole('button', { name: 'View previous month' }).click()
    await expect(heroTotal(page)).toHaveText('S$997.87')
    await expect(page.locator('span.text-negative', { hasText: 'vs August' })).toHaveText(
      'Up 24.7% vs August',
    )

    await page.getByRole('radio', { name: 'Year' }).click()
    await expect(heroTotal(page)).toHaveText('S$2,506.67')
    await expect(page.locator('span.text-positive', { hasText: 'vs 2025 to Oct 18' })).toHaveText(
      'Down 49.9% vs 2025 to Oct 18',
    )
  })

  test('AC-2: on Mar 30 the comparison covers all of February', async ({ page }) => {
    await seed(page, {
      expenses: [row('2027-02-10', 100, 'feb'), row('2027-03-05', 150, 'mar')],
      now: SGT('2027-03-30T10:00:00'),
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(page.locator('span.text-negative', { hasText: 'vs' })).toHaveText(
      'Up 50.0% vs February',
    )
  })

  test('reduced motion: the hero shows only its final value, never a count-up', async ({
    page,
  }) => {
    // Record every value the hero total ever shows, from the first paint.
    await page.addInitScript(() => {
      const seen: string[] = []
      Reflect.set(window, '__heroValues', seen)
      new MutationObserver(() => {
        const text = document.querySelector('[class*="clamp(1.75rem"]')?.textContent
        if (text && seen[seen.length - 1] !== text) seen.push(text)
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })
    await seed(page, { expenses, now: SGT('2026-10-18T15:00:00') })
    await page.goto('/pulse')
    await waitForApp(page)
    await page.getByRole('button', { name: 'View previous month' }).click()
    await expect(heroTotal(page)).toHaveText('S$997.87')
    await page.waitForTimeout(800) // longer than the count-up would take
    const seen: unknown = JSON.parse(
      await page.evaluate(() => JSON.stringify(Reflect.get(window, '__heroValues'))),
    )
    expect(seen).toEqual(['S$708.80', 'S$997.87'])
  })
})

// ─── AC-4: one monthly average, partial month counted as partial ──────────────

test.describe('Year view', () => {
  /** S$1,000 a month spread evenly over each month's days, up to today. */
  function evenYear(today: string): SeedExpense[] {
    const out: SeedExpense[] = []
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(Date.UTC(2026, m, 0)).getUTCDate()
      for (let d = 1; d <= dim; d++) {
        const day = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        if (day > today) break
        out.push(row(day, Math.round((1000 / dim) * 100) / 100, 'even'))
      }
    }
    return out
  }

  test('AC-4: exactly one monthly average, S$1,000.00 for an even S$1,000 a month', async ({
    page,
  }) => {
    await seed(page, { expenses: evenYear('2026-10-18'), now: SGT('2026-10-18T12:00:00') })
    await page.goto('/pulse')
    await waitForApp(page)
    await page.getByRole('radio', { name: 'Year' }).click()
    const main = page.getByRole('main')
    await expect(main).toContainText('Monthly avg')
    const text = await main.innerText()
    expect(text.match(/monthly avg/gi)).toHaveLength(1)
    const avg = /Monthly avg\s*S\$([\d,]+\.\d\d)/.exec(text)?.[1] ?? ''
    expect(Math.abs(Number(avg.replace(/,/g, '')) - 1000)).toBeLessThanOrEqual(0.5)
    await expect(main).toContainText('to Oct 18')
  })
})

// ─── AC-5: the pace ring measures budgeted categories only ────────────────────

test.describe('Pace ring', () => {
  test('AC-5: 3% of a S$300 Food cap, accent, with the unbudgeted spend called out', async ({
    page,
  }) => {
    await seed(page, {
      expenses: [
        row('2026-10-03', 9, 'kopi'),
        row('2026-10-04', 400, 'etf top-up', 'Investment'),
        row('2026-09-20', 5, 'old'),
      ],
      budgets: { 'Food & Dining': 300 },
      now: SGT('2026-10-18T09:00:00'),
    })
    await page.goto('/pulse')
    await waitForApp(page)

    const ring = page.getByRole('img', { name: /^Budget 3% used/ })
    await expect(ring).toHaveAccessibleName(
      'Budget 3% used: S$9.00 of S$300.00. On track. S$291.00 left, S$20.79 a day, 14 days left. The tick marks an even pace: 58% of the budget by today. Budgeted categories only.',
    )
    await expect(ring.locator('circle[stroke="var(--accent)"]')).toHaveCount(1)
    await expect(ring.locator('circle[stroke="var(--negative)"]')).toHaveCount(0)
    await expect(ring).toContainText('3%')
    await expect(ring).toContainText('of S$300.00')
    await expect(ring).toContainText('S$291.00 left')
    await expect(ring).toContainText('S$20.79/day')
    await expect(ring.getByText('Budgeted categories only')).toBeVisible()
  })

  test('ahead of pace is spelled out, and a monthly charge already paid is not projected', async ({
    page,
  }) => {
    const monthly = ['08', '09', '10'].flatMap((m) => [
      row(`2026-${m}-01`, 9.99, 'spotify', 'Subscriptions'),
      row(`2026-${m}-12`, 15.98, 'netflix', 'Subscriptions'),
    ])
    await seed(page, {
      expenses: [...monthly, row('2026-10-06', 60, 'grab', 'Transportation')],
      budgets: { Subscriptions: 30, Transportation: 80 },
      now: SGT('2026-10-19T21:00:00'),
    })
    await page.goto('/pulse')
    await waitForApp(page)

    // Transport 60 by day 19 runs to 97.89 (> 80); the subscriptions are paid for October.
    const ring = page.getByRole('img', { name: /^Budget/ })
    await expect(ring.getByText('Ahead of pace', { exact: true })).toBeVisible()
    await expect(ring).toContainText('projected S$123.86')
    await expect(page.getByRole('button', { name: /^Subscriptions: / })).toHaveAccessibleName(
      'Subscriptions: S$25.97 of S$30.00 budget. 87% used · S$4.03 left',
    )
    await expect(page.getByRole('button', { name: /^Transportation: / })).toHaveAccessibleName(
      'Transportation: S$60.00 of S$80.00 budget. Projected S$97.89',
    )
  })
})

// ─── AC-7: a finished month or year shows its final state ─────────────────────

test.describe('Past periods', () => {
  const expenses = [
    row('2025-02-14', 50, 'valentine'),
    row('2025-12-24', 80, 'xmas'),
    row('2026-09-01', 10, 'sep 1'),
    row('2026-09-15', 20, 'grab', 'Transportation'),
    row('2026-09-30T23:59:00', 30, 'sep 30 late'),
    row('2026-10-18', 999, 'today'),
  ]

  test('AC-7: past month — no Today card, no ring, no days left, whole-month charts', async ({
    page,
  }) => {
    await seed(page, {
      expenses,
      budgets: { Transportation: 15 },
      now: SGT('2026-10-18T10:00:00'),
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

    await page.getByRole('button', { name: 'View previous month' }).click()
    await expect(heroTotal(page)).toHaveText('S$60.00')
    const main = page.getByRole('main')
    await expect(main).toContainText('September 2026')
    await expect(page.getByRole('heading', { name: 'Today' })).toHaveCount(0)
    await expect(page.getByRole('img', { name: /^Budget/ })).toHaveCount(0)
    await expect(main).toContainText('Budget · Final')
    await expect(main).toContainText('Final · September')
    expect(await main.innerText()).not.toMatch(/days left|last day/i)

    // Heatmap ends on the month's last day.
    const cells = page.getByRole('button', { name: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), / })
    await expect(cells.last()).toHaveAccessibleName('Wed, September 30: S$30.00')

    // The sparkline has a point for every day of September and adds up to the hero.
    const spark = page.getByRole('img', { name: /^Trend chart/ }).first()
    await expect(spark).toHaveAccessibleName(/^Trend chart\. Total S\$60\.00\./)
    await expect(spark.locator('rect')).toHaveCount(30)
  })

  test('AC-7: past year — no current or future month, twelve points', async ({ page }) => {
    await seed(page, { expenses, now: SGT('2026-10-18T10:00:00') })
    await page.goto('/pulse')
    await waitForApp(page)
    await page.getByRole('radio', { name: 'Year' }).click()

    const bars = page.getByRole('button', {
      name: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec): /,
    })
    await expect(bars).toHaveCount(12)
    await expect(bars.locator('div.bg-accent')).toHaveCount(1) // October, this year
    await expect(
      page
        .getByRole('img', { name: /^Trend chart/ })
        .first()
        .locator('rect'),
    ).toHaveCount(10)

    await page.getByRole('button', { name: 'View previous year' }).click()
    await expect(heroTotal(page)).toHaveText('S$130.00')
    await expect(bars.locator('div.bg-accent')).toHaveCount(0)
    await expect(
      page
        .getByRole('img', { name: /^Trend chart/ })
        .first()
        .locator('rect'),
    ).toHaveCount(12)
    const cells = page.getByRole('button', { name: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), / })
    await expect(cells.last()).toHaveAccessibleName(/^Wed, December 31: /)
  })
})

// ─── AC-8: heatmap labels sit on their rows; no overflow at 320 px ────────────

test.describe('Heatmap layout', () => {
  const expenses = [row('2026-10-12', 4, 'mon'), row('2026-10-14', 8, 'wed'), row('2026-10-18', 2)]

  for (const width of [375, 1280]) {
    test(`AC-8: Mon / Wed / Fri labels are centred on their rows at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await seed(page, { expenses, now: SGT('2026-10-18T10:00:00') })
      await page.goto('/pulse')
      await waitForApp(page)
      for (const day of ['Mon', 'Wed', 'Fri']) {
        const label = page.getByText(day, { exact: true }).first()
        const cell = page.getByRole('button', { name: new RegExp(`^${day}, `) }).last()
        expect(Math.abs((await centreY(label)) - (await centreY(cell)))).toBeLessThanOrEqual(1)
      }
    })
  }

  test('AC-8: at 320 px Pulse does not scroll sideways and today is in view', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await seed(page, {
      expenses: [...expenses, row('2026-10-17', 123456.78, 'big')],
      now: SGT('2026-10-18T10:00:00'),
    })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(heroTotal(page)).toHaveText('S$123,470.78')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const hero = await heroTotal(page).boundingBox()
    expect(hero && hero.x + hero.width).toBeLessThanOrEqual(320)

    // The heatmap scrolls inside its card and opens on the latest week: today's cell is
    // inside the scroller's visible box without any horizontal scrolling by the test.
    const today = page.getByRole('button', { name: /^Sun, October 18: / })
    const box = await today.boundingBox()
    const scroller = await today
      .locator('xpath=ancestor::div[contains(@class,"overflow-x-auto")]')
      .boundingBox()
    if (!box || !scroller) throw new Error('heatmap has no box')
    expect(box.x).toBeGreaterThanOrEqual(scroller.x)
    expect(box.x + box.width).toBeLessThanOrEqual(scroller.x + scroller.width)
  })
})

// ─── AC-9: the forecast chart draws its bars ──────────────────────────────────

test.describe('Insights forecast', () => {
  test('AC-9: forecast bars have height whenever the forecast has money in it', async ({
    page,
  }) => {
    const expenses = [
      ...['2026-06-25', '2026-07-25', '2026-08-25', '2026-09-25'].map((d) =>
        row(d, 10.98, 'spotify', 'Subscriptions'),
      ),
      ...['2026-07-20', '2026-08-20', '2026-09-20'].map((d) =>
        row(d, 15.98, 'netflix', 'Subscriptions'),
      ),
      row('2026-10-17', 6, 'kopi'),
    ]
    await seed(page, { expenses, now: SGT('2026-10-18T10:00:00') })
    await page.goto('/insights')
    await waitForApp(page)

    const forecast = page.getByRole('heading', { name: '14-day forecast' }).locator('xpath=../..')
    await expect(forecast).toContainText('S$26.96')
    // One control for the 14 days (one tab stop, one card-wide target), not a button per day.
    const chart = page.getByRole('slider', { name: '14-day forecast by day' })
    await expect(chart).toBeVisible()
    const heights = await chart.evaluate((el) =>
      Array.from(
        el.children,
        (day) => day.firstElementChild?.lastElementChild?.getBoundingClientRect().height ?? 0,
      ),
    )
    expect(heights).toHaveLength(14)
    // Oct 20 (netflix) and Oct 25 (spotify) carry the charges; every other day is the baseline.
    expect(heights[2]).toBeGreaterThanOrEqual(3)
    expect(heights[7]).toBeGreaterThanOrEqual(3)
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(60)
    expect(heights.filter((_, i) => i !== 2 && i !== 7).every((h) => h === 2)).toBe(true)

    // Keyboard: focus reads today, the arrows move a day at a time, End jumps to the last day.
    await chart.focus()
    await expect(chart).toHaveAttribute('aria-valuetext', 'Today, Oct 18 · nothing due')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(chart).toHaveAttribute('aria-valuetext', 'Oct 20 · S$15.98')
    await expect(chart.getByText('Oct 20 · S$15.98', { exact: true })).toBeVisible()
    await page.keyboard.press('End')
    await expect(chart).toHaveAttribute('aria-valuetext', 'Oct 31 · nothing due')

    // A tap anywhere in a day's column (here high above the short bar) reads that day.
    const box = await chart.boundingBox()
    if (!box) throw new Error('forecast chart has no box')
    await chart.click({ position: { x: box.width * (7.5 / 14), y: 4 } })
    await expect(chart.getByText('Oct 25 · S$10.98', { exact: true })).toBeVisible()
  })
})

// ─── AC-11: a session left open across midnight rolls over ────────────────────

test.describe('Midnight rollover', () => {
  const expenses = [
    row('2026-10-15', 20, 'october lunch'),
    row('2026-10-31T20:00:00', 4, 'halloween snack'),
    row('2026-11-01', 7.77, 'first of november'),
  ]

  test('AC-11: Pulse moves to the new day and month at midnight without a reload', async ({
    page,
  }) => {
    await seed(page, { expenses, now: SGT('2026-10-31T23:59:00'), controllable: true })
    await page.goto('/pulse')
    await waitForApp(page)
    await expect(heroTotal(page)).toHaveText('S$24.00')
    await expect(page.getByRole('main')).toContainText('October 2026')

    await page.clock.fastForward('02:00') // the midnight timer fires
    await expect(page.getByRole('main')).toContainText('November 2026')
    await expect(heroTotal(page)).toHaveText('S$7.77')
    await expect(page.getByRole('main')).toContainText('first of november')
  })

  test('AC-11: Ledger Today follows the clock when the app becomes visible again', async ({
    page,
  }) => {
    await seed(page, { expenses, now: SGT('2026-10-31T23:59:00'), controllable: true })
    await page.goto('/ledger?range=today')
    await waitForApp(page)
    await expect(page.getByText('Today · Sat, Oct 31', { exact: true })).toBeVisible()
    await expect(ledgerSummary(page)).toContainText('S$4.00')

    // A phone asleep over midnight: no timer ran, the clock simply moved on.
    await page.clock.setSystemTime(SGT('2026-11-01T07:30:00'))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByText('Today · Sun, Nov 1', { exact: true })).toBeVisible()
    await expect(ledgerSummary(page)).toContainText('S$7.77')
    expect(await ledgerItemNames(page)).toEqual(['first of november'])
  })
})

// ─── AC-14: ledger URL state and delete safety ────────────────────────────────

test.describe('Ledger state', () => {
  const expenses = [
    row('2026-01-05', 6, 'laksa'),
    row('2026-10-12', 5.2, 'laksa'),
    row('2026-10-14', 3, 'kopi'),
    row('2026-10-16', 14, 'grab', 'Transportation'),
  ]

  test('AC-14: a filter tapped while a search is settling is never reverted', async ({ page }) => {
    await seed(page, { expenses, now: SGT('2026-10-18T10:00:00') })
    await page.goto('/ledger')
    await waitForApp(page)
    await page.getByRole('textbox', { name: 'Search expenses' }).fill('laksa')
    await page.waitForTimeout(300) // still inside the 400 ms settle window
    await page.getByRole('radio', { name: 'Year' }).click()
    await page.waitForTimeout(700)
    const url = new URL(page.url())
    expect(url.searchParams.get('range')).toBe('year')
    expect(url.searchParams.get('q')).toBe('laksa')
    await expect(page.getByRole('radio', { name: 'Year' })).toHaveAttribute('aria-checked', 'true')
    await expect(ledgerSummary(page)).toContainText('2 entries')
  })

  test('an entry whose date cannot be read keeps it when another field is saved', async ({
    page,
  }) => {
    const broken = { ...row('2026-10-12', 7.5, 'mystery kopi'), date: 'garbage' }
    await seed(page, { expenses: [...expenses, broken], now: SGT('2026-10-18T10:00:00') })
    await page.goto('/ledger?range=all')
    await waitForApp(page)
    const unknown = page.locator('section').filter({ hasText: /^Unknown date/ })
    await unknown.getByRole('button', { name: /^Edit mystery kopi, / }).click()

    const sheet = page.getByRole('dialog', { name: 'Edit expense' })
    await expect(sheet).toContainText("This entry's date can't be read")
    // No day is chosen for it: no preset and no picked date lights up.
    await expect(sheet.getByRole('group', { name: 'Date' }).locator('.text-accent')).toHaveCount(0)
    await sheet.getByLabel('Item', { exact: true }).fill('mystery kopi o')
    await sheet.getByRole('button', { name: 'Save changes' }).click()
    await expect(sheet).toHaveCount(0)

    await expect(unknown.getByRole('button', { name: /^Edit mystery kopi o, / })).toBeVisible()
    const stored = async () => {
      const all = JSON.parse(
        await page.evaluate(() => localStorage.getItem('expenses') ?? '[]'),
      ) as SeedExpense[]
      return all.find((e) => e.id === broken.id)
    }
    await expect.poll(async () => (await stored())?.itemName).toBe('mystery kopi o')
    expect((await stored())?.date).toBe('garbage')
  })

  test('AC-14: palette navigation to an expense shows its search text', async ({ page }) => {
    await seed(page, { expenses, now: SGT('2026-10-18T10:00:00') })
    await page.goto('/ledger')
    await waitForApp(page)
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('textbox').fill('grab')
    await palette.getByRole('button', { name: /grab/ }).last().click()
    await expect(page).toHaveURL(/date=2026-10-16/)
    await expect(page.getByRole('textbox', { name: 'Search expenses' })).toHaveValue('grab')
    expect(await ledgerItemNames(page)).toEqual(['grab'])
  })

  test('AC-14: in a 300-row virtual list a second tap never deletes another expense', async ({
    page,
  }) => {
    const many: SeedExpense[] = []
    for (let i = 0; i < 300; i++) {
      const day = String(1 + (i % 18)).padStart(2, '0')
      many.push(row(`2026-10-${day}`, 1 + (i % 7), `row ${String(i).padStart(3, '0')}`))
    }
    // Swiping is the phone gesture: one-hand layout.
    await page.setViewportSize({ width: 390, height: 844 })
    await seed(page, { expenses: many, now: SGT('2026-10-18T10:00:00') })
    await page.goto('/ledger')
    await waitForApp(page)
    await expect(ledgerSummary(page)).toContainText('300 entries')

    const target = page.getByRole('button', { name: /^Edit row / }).nth(2)
    const name = ((await target.getAttribute('aria-label')) ?? '').split(',')[0]?.slice(5) ?? ''
    const box = await target.boundingBox()
    if (!box) throw new Error('row has no box')
    // Swipe the row left until its Delete action is armed (the row slides ~96 px).
    const midY = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 2, midY)
    await page.mouse.down()
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(box.x + box.width / 2 - step * 16, midY)
    }
    await page.mouse.up()
    await expect.poll(async () => (await target.boundingBox())?.x ?? 0).toBeLessThan(box.x - 60)
    const armed = page.getByRole('button', { name: `Delete ${name}`, exact: true })
    const spot = await armed.boundingBox()
    if (!spot) throw new Error('delete has no box')
    const x = spot.x + spot.width / 2
    const y = spot.y + spot.height / 2

    await page.mouse.click(x, y)
    await expect(ledgerSummary(page)).toContainText('299 entries')
    await page.waitForTimeout(600) // past the reflex guard: the slot itself must be safe
    await page.mouse.click(x, y)
    await page.waitForTimeout(300)
    await expect(ledgerSummary(page)).toContainText('299 entries')
    const stored = () => page.evaluate(() => localStorage.getItem('expenses') ?? '[]')
    await expect.poll(async () => (JSON.parse(await stored()) as unknown[]).length).toBe(299)
    expect(await stored()).not.toContain(`"${name}"`)
  })
})
