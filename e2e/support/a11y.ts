import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import type * as Axe from 'axe-core'

// Shared harness for the accessibility suites (T6, F-066): invented seeds on a fixed Singapore
// clock, themes, the UI states every suite walks, axe, and the in-page audits for focus rings,
// touch targets and focus hidden under the sticky bars. All data here is made up.

declare global {
  interface Window {
    axe?: typeof Axe
  }
}

// ─── clock, data, theme ───────────────────────────────────────────────────────

/** Sun 18 Oct 2026, 10:00 in Singapore. */
export const NOW = new Date('2026-10-18T10:00:00+08:00')
export const TODAY = '2026-10-18'

export type Theme = 'dark' | 'light'
export const THEMES: readonly Theme[] = ['dark', 'light']

export interface SeedExpense {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  createdAt: string
}

export const CATEGORIES = [
  'Food & Dining',
  'Gaming',
  'Social & Leisure',
  'Transportation',
  'Shopping',
  'Healthcare',
  'Grooming',
  'Subscriptions',
  'Investment',
  'Travel',
  'Other',
] as const

const pad = (n: number) => String(n).padStart(2, '0')

/** `yyyy-MM-dd` of the calendar day `days` after `key` (UTC arithmetic on a date-only key). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days))
  return `${String(at.getUTCFullYear())}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** A row as the app stores it: the day at local noon, no zone. */
export function row(
  id: string,
  day: string,
  amount: number,
  itemName: string,
  category: string = 'Food & Dining',
): SeedExpense {
  const date = `${day}T12:00:00`
  return { id, itemName, amount, category, date, createdAt: date }
}

const ITEMS: Record<(typeof CATEGORIES)[number], readonly string[]> = {
  'Food & Dining': ['kopi', 'chicken rice', 'laksa', 'mee pok', 'teh peng'],
  Gaming: ['steam sale', 'switch game'],
  'Social & Leisure': ['movie', 'bowling'],
  Transportation: ['grab', 'mrt top-up'],
  Shopping: ['uniqlo tee', 'shopee'],
  Healthcare: ['clinic', 'plasters'],
  Grooming: ['haircut', 'shampoo'],
  Subscriptions: ['icloud', 'netflix'],
  Investment: ['etf top-up'],
  Travel: ['ferry', 'hostel'],
  Other: ['gift', 'stationery'],
}

/**
 * About 70 rows over the 14 heatmap weeks (13 Jul - 18 Oct 2026), all 11 categories, gaps on
 * some days, a monthly Spotify charge, and October set up for the three budgets: Food under,
 * Transportation ahead of pace (S$60 by the 18th of a S$80 month), Shopping over (S$120 of S$50).
 */
function richExpenses(): SeedExpense[] {
  const out: SeedExpense[] = []
  const start = '2026-07-13'
  for (let i = 0; i < 80; i++) {
    const day = addDays(start, i)
    if (i % 4 === 3) continue // days with no spending
    const category = CATEGORIES[i % CATEGORIES.length] ?? 'Other'
    if (category === 'Transportation' || category === 'Shopping') continue
    const names = ITEMS[category]
    const name = names[i % names.length] ?? 'item'
    out.push(row(`r${pad(i)}`, day, 2 + ((i * 7) % 23) + 0.4, `${name} ${String(i)}`, category))
  }
  for (const [i, day] of ['2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03'].entries()) {
    out.push(row(`spotify-${String(i)}`, day, 10.98, `spotify ${String(i)}`, 'Subscriptions'))
  }
  const october: SeedExpense[] = [
    row('oct-01', '2026-10-01', 4.2, 'kaya toast'),
    row('oct-02', '2026-10-02', 15, 'grab to work', 'Transportation'),
    row('oct-03', '2026-10-05', 60, 'running shoes', 'Shopping'),
    row('oct-04', '2026-10-06', 15, 'grab home', 'Transportation'),
    row('oct-05', '2026-10-08', 6.5, 'bubble tea'),
    row('oct-06', '2026-10-10', 15, 'grab airport', 'Transportation'),
    row('oct-07', '2026-10-12', 60, 'rain jacket', 'Shopping'),
    row('oct-08', '2026-10-14', 15, 'grab late', 'Transportation'),
    row('oct-09', '2026-10-16', 8.9, 'nasi lemak'),
    row('oct-10', '2026-10-17', 12, 'movie night', 'Social & Leisure'),
    row('oct-11', '2026-10-18', 1.8, 'kopi o'),
    row('oct-12', '2026-10-18', 5.5, 'chicken rice today'),
  ]
  return [...out, ...october].sort((a, b) => b.date.localeCompare(a.date))
}

export const RICH = richExpenses()
export const RICH_BUDGETS = { 'Food & Dining': 300, Transportation: 80, Shopping: 50 }

/** `count` rows spread over 1-18 October (this month), newest first, named `row 0000`. */
export function manyRows(count: number): SeedExpense[] {
  const out: SeedExpense[] = []
  for (let i = 0; i < count; i++) {
    const day = `2026-10-${pad(18 - (i % 18))}`
    out.push(
      row(
        `m${String(i).padStart(5, '0')}`,
        day,
        1 + (i % 9) + 0.25,
        `row ${String(i).padStart(4, '0')}`,
      ),
    )
  }
  return out
}

export interface SeedOptions {
  expenses?: readonly SeedExpense[]
  budgets?: Record<string, number>
  /** The stored theme. `system` follows the emulated OS scheme, which starts dark. */
  theme?: Theme | 'system'
  now?: Date
  /** Holds the one-shot stale-chunk reload, so a failed chunk shows its card at once. */
  holdChunkReload?: boolean
  /**
   * How the date is fixed. `fixed` (the default): Playwright's clock holds it at `now`, and
   * also runs the page's requestAnimationFrame off its own timers. `running`: the date alone
   * starts at `now` and runs on, and frames stay the browser's own, so what a frame callback
   * reads is what was painted then (CSS transitions and Web Animations move only on painted
   * frames; motion recordings need this).
   */
  date?: 'fixed' | 'running'
}

/** In the page, before its scripts: Date starts at `at` and runs on; no other timer changes. */
function startDateAt(at: number): void {
  const RealDate = Date
  const offset = at - RealDate.now()
  const now = () => RealDate.now() + offset
  window.Date = new Proxy(RealDate, {
    construct: (target, args: unknown[]) =>
      args.length === 0 ? new target(now()) : Reflect.construct(target, args),
    apply: () => new RealDate(now()).toString(),
    get: (target, property, receiver) =>
      property === 'now' ? now : Reflect.get(target, property, receiver),
  })
}

/**
 * Fixed date, invented data, SGD and the theme, written once per test (init scripts run on
 * every navigation, so a reload keeps what the test changed). Reduced motion is on: scans and
 * focus audits measure the settled page, never a frame of an animation.
 */
export async function seed(page: Page, opts: SeedOptions = {}): Promise<void> {
  const theme = opts.theme ?? 'dark'
  if (opts.date === 'running') await page.addInitScript(startDateAt, (opts.now ?? NOW).getTime())
  else await page.clock.setFixedTime(opts.now ?? NOW)
  await page.emulateMedia({
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'reduce',
  })
  await page.addInitScript(
    (s) => {
      if (s.holdChunkReload) {
        sessionStorage.setItem('spendtrack:chunk-reload-at', String(Date.now()))
      }
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      localStorage.setItem('expenses', JSON.stringify(s.expenses))
      localStorage.setItem('categoryBudgets', JSON.stringify(s.budgets))
      localStorage.setItem('spendtrack:currency', 'SGD')
      localStorage.setItem('spendtrack:theme', s.theme)
    },
    {
      expenses: opts.expenses ?? [],
      budgets: opts.budgets ?? {},
      theme,
      holdChunkReload: opts.holdChunkReload ?? false,
    },
  )
}

export const storedExpenses = async (page: Page): Promise<SeedExpense[]> =>
  JSON.parse(await page.evaluate(() => localStorage.getItem('expenses') ?? '[]')) as SeedExpense[]

/**
 * With the stored theme on `system`: flips the emulated OS scheme and waits until the app has
 * re-themed in place and stopped moving. One page, one opened state, both themes: on WebKit a
 * page load costs seconds (it holds animations at their first frame for a while after load).
 */
export async function switchTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await settle(page)
}

// ─── readiness and settling ───────────────────────────────────────────────────

/**
 * Local data hydrated and the lazy screen loaded. Screens are lazy chunks: cold, under a
 * parallel run of WebKit pages, one can take longer than the default 5 s to arrive.
 */
export async function waitForApp(page: Page): Promise<void> {
  const lazy = { timeout: 15_000 }
  await expect(page.getByRole('main')).toBeVisible(lazy)
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, lazy)
  await expect(page.getByText('Loading screen')).toHaveCount(0, lazy)
}

/**
 * Waits until nothing moves: finite CSS / Web Animations have finished and every dialog,
 * toast and the header keep the same box and opacity for three frames in a row.
 *
 * In WebKit here (Playwright on Windows) an animation or transition that starts with a style
 * change can stay pending, held at its first frame, for 2-5 s before it runs, even the 0.01 ms
 * ones of reduced motion: after a load the route content sits at opacity 0, and after a theme
 * change the old colours stay. Reading the page before they run measures a frame no one sees.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== 'running' ||
          !Number.isFinite(Number(a.effect?.getComputedTiming().endTime)),
      ),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const snapshot = () =>
          [...document.querySelectorAll('[role="dialog"], [data-layer-exempt] *, header')]
            .map((el) => {
              const r = el.getBoundingClientRect()
              const s = getComputedStyle(el)
              return `${String(r.x)},${String(r.y)},${String(r.width)},${String(r.height)},${s.opacity},${s.transform}`
            })
            .join('|')
        let last = snapshot()
        let still = 0
        const started = performance.now()
        const tick = () => {
          const now = snapshot()
          still = now === last ? still + 1 : 0
          last = now
          if (still >= 3 || performance.now() - started > 3000) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
}

// ─── the app's controls (C9 names) ────────────────────────────────────────────

export const isPhone = (testInfo: TestInfo) => testInfo.project.name === 'mobile'

export const dialog = (page: Page, name: string | RegExp) =>
  page.getByRole('dialog', { name, exact: typeof name === 'string' ? true : undefined })

/**
 * Waits for a closed layer to leave the page. Closing is immediate (focus moves on at once), but
 * a sheet stays for its exit fade, and WebKit here can hold a just-started animation for seconds
 * before it runs (see `settle`): this allows more than expect's default 5 s for that.
 */
export const expectGone = (layer: Locator, message?: string) =>
  expect(layer, message).toHaveCount(0, { timeout: 15_000 })

export const searchButton = (page: Page) =>
  page.getByRole('button', { name: 'Search', exact: true })

/** Add expense: the + button on a phone, Ctrl+N on a laptop. */
export async function openAddSheet(page: Page, testInfo: TestInfo): Promise<Locator> {
  if (isPhone(testInfo))
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
  else await page.keyboard.press('Control+n')
  const sheet = dialog(page, 'Add expense')
  await expect(sheet).toBeVisible()
  return sheet
}

export async function openSettings(page: Page, tab?: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const sheet = dialog(page, 'Settings')
  await expect(sheet).toBeVisible()
  if (tab) {
    await sheet.getByRole('tab', { name: tab, exact: true }).click()
    await expect(sheet.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  }
  return sheet
}

export async function openPalette(page: Page): Promise<Locator> {
  await searchButton(page).click()
  const palette = dialog(page, 'Command palette')
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toBeFocused()
  return palette
}

export async function openEditSheet(
  page: Page,
  item: string | RegExp = /^Edit /,
): Promise<Locator> {
  await page.getByRole('button', { name: item }).first().click()
  const sheet = dialog(page, 'Edit expense')
  await expect(sheet).toBeVisible()
  return sheet
}

/** The visible quick-add field (Pulse on a phone, the top bar on a laptop). */
export const quickAdd = (page: Page) =>
  page.getByRole('textbox', { name: 'Quick add expense' }).filter({ visible: true }).first()

// ─── the UI states every suite walks (spec §6) ────────────────────────────────

export interface UiState {
  id: string
  title: string
  path: string
  expenses: readonly SeedExpense[]
  budgets?: Record<string, number>
  /** A lazy chunk that fails to load, as resilience.spec does. */
  failChunk?: string
  /** Brings the page into the state, from a loaded `path`. */
  open?: (page: Page, testInfo: TestInfo) => Promise<void>
  /** The state goes by itself (a toast): `open` again before each look at it. */
  transient?: boolean
  /**
   * For a state the app places by script as it opens (a calendar beside its field): opens that
   * part again, as it would open on a screen of the new width.
   */
  reopen?: (page: Page) => Promise<void>
  /** What may stick out at 320 px because its fix is deferred, and why (horizontalOverflow). */
  knownReflow?: { readonly selector: string; readonly why: string }
}

const VIRTUAL_300 = manyRows(300)

export const STATES: readonly UiState[] = [
  { id: 'S01', title: 'Pulse, empty', path: '/pulse', expenses: [] },
  { id: 'S02', title: 'Pulse, month', path: '/pulse', expenses: RICH, budgets: RICH_BUDGETS },
  {
    id: 'S03',
    title: 'Pulse, year',
    path: '/pulse',
    expenses: RICH,
    budgets: RICH_BUDGETS,
    open: async (page) => {
      await page
        .getByRole('radiogroup', { name: 'Period' })
        .getByRole('radio', { name: 'Year' })
        .click()
      await expect(page.getByRole('slider', { name: /^Monthly totals, 2026$/ })).toBeVisible()
    },
  },
  { id: 'S04', title: 'Ledger, grouped', path: '/ledger?range=all', expenses: RICH },
  {
    id: 'S05',
    title: 'Ledger, virtual (300 rows)',
    path: '/ledger',
    expenses: VIRTUAL_300,
    open: async (page) => {
      await expect(page.getByText('300 entries', { exact: true })).toBeVisible()
    },
  },
  {
    id: 'S06',
    title: 'Ledger, no results',
    path: '/ledger?q=no-such-expense',
    expenses: RICH,
    open: async (page) => {
      await expect(page.getByText('No results for this view')).toBeVisible()
    },
  },
  {
    id: 'S07',
    title: 'Ledger, custom range with the date picker open',
    path: '/ledger?range=custom',
    expenses: RICH,
    open: async (page) => {
      await page.getByRole('button', { name: /^From, / }).click()
      await expect(dialog(page, /^Choose From date/)).toBeVisible()
    },
    reopen: async (page) => {
      await page.keyboard.press('Escape')
      await expectGone(dialog(page, /^Choose From date/))
      await page.getByRole('button', { name: /^From, / }).click()
      await expect(dialog(page, /^Choose From date/)).toBeVisible()
    },
  },
  { id: 'S08', title: 'Insights', path: '/insights', expenses: RICH, budgets: RICH_BUDGETS },
  { id: 'S09', title: 'Insights, empty', path: '/insights', expenses: [] },
  {
    id: 'S10',
    // Shopping: the chosen chip's label on the hardest hue for dark text (blue-violet).
    title: 'Add sheet, the Shopping chip chosen',
    path: '/pulse',
    expenses: RICH,
    open: async (page, testInfo) => {
      const sheet = await openAddSheet(page, testInfo)
      const chip = sheet
        .getByRole('group', { name: 'Category' })
        .getByRole('button', { name: 'Shopping', exact: true })
      await chip.click()
      await expect(chip).toHaveAttribute('aria-pressed', 'true')
    },
  },
  {
    id: 'S11',
    title: 'Add sheet, invalid submit',
    path: '/pulse',
    expenses: RICH,
    open: async (page, testInfo) => {
      const sheet = await openAddSheet(page, testInfo)
      await sheet.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(sheet.getByText('Required', { exact: true })).toBeVisible()
    },
  },
  {
    id: 'S12',
    title: 'Add sheet with the date picker open',
    path: '/pulse',
    expenses: RICH,
    open: async (page, testInfo) => {
      const sheet = await openAddSheet(page, testInfo)
      await sheet.getByRole('button', { name: 'Pick date' }).click()
      await expect(dialog(page, 'Choose date')).toBeVisible()
    },
    reopen: async (page) => {
      await page.keyboard.press('Escape')
      await expectGone(dialog(page, 'Choose date'))
      await dialog(page, 'Add expense').getByRole('button', { name: 'Pick date' }).click()
      await expect(dialog(page, 'Choose date')).toBeVisible()
    },
  },
  {
    id: 'S13',
    title: 'Edit sheet, a Shopping expense (its chip chosen)',
    path: '/ledger',
    expenses: RICH,
    open: async (page) => {
      const sheet = await openEditSheet(page, /^Edit rain jacket,/)
      await expect(
        sheet
          .getByRole('group', { name: 'Category' })
          .getByRole('button', { name: 'Shopping', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
    },
  },
  {
    id: 'S14',
    title: 'Edit sheet, delete confirmation',
    path: '/ledger',
    expenses: RICH,
    open: async (page) => {
      const sheet = await openEditSheet(page)
      await sheet.getByRole('button', { name: 'Delete expense' }).click()
      const question = sheet.getByRole('group', { name: /^Delete ".+"\?$/ })
      await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
    },
  },
  {
    id: 'S15',
    title: 'Settings, Categories with a delete confirmation',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      const sheet = await openSettings(page, 'Categories')
      await sheet.getByRole('button', { name: 'Delete category Gaming', exact: true }).click()
      await expect(sheet.getByRole('button', { name: 'Keep Gaming', exact: true })).toBeFocused()
    },
  },
  {
    id: 'S16',
    title: 'Settings, Budgets',
    path: '/pulse',
    expenses: RICH,
    budgets: RICH_BUDGETS,
    open: async (page) => {
      await openSettings(page, 'Budgets')
    },
  },
  {
    id: 'S17',
    title: 'Settings, Backup with the clear-all confirmation',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      const sheet = await openSettings(page, 'Backup')
      await sheet.getByRole('button', { name: 'Clear all expenses' }).click()
      await expect(sheet.getByRole('button', { name: 'Yes, delete all' })).toBeVisible()
    },
  },
  {
    id: 'S18',
    title: 'Settings, Sync',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      await openSettings(page, 'Sync')
    },
    // Only builds without relay settings show these setup steps (the deployed app has them); the
    // file names in them do not wrap. SyncPanel.tsx belongs to PR-0: the wrap lands after it.
    knownReflow: {
      selector: '[role="tabpanel"] ol span',
      why: 'SyncPanel setup steps (not-configured builds only); fix deferred to after PR-0',
    },
  },
  {
    id: 'S19',
    title: 'Command palette with results',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      const palette = await openPalette(page)
      await palette.getByRole('combobox').fill('kopi')
      await expect(palette.getByRole('option').first()).toBeVisible()
    },
  },
  {
    id: 'S20',
    title: 'Command palette, large-amount confirmation',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      const palette = await openPalette(page)
      await palette.getByRole('combobox').fill('tv 4500')
      await page.keyboard.press('Enter')
      await expect(
        palette.getByRole('option', { name: /^Confirm large amount: add "tv"/ }),
      ).toBeVisible()
    },
  },
  {
    id: 'S21',
    title: 'Toast after a quick add',
    path: '/pulse',
    expenses: RICH,
    transient: true,
    open: async (page) => {
      await quickAdd(page).fill('kopi 2.40')
      await quickAdd(page).press('Enter')
      // Opened again for the next look, it may stack on the first toast while that one lasts.
      await expect(
        page
          .getByRole('region', { name: 'Notifications' })
          .getByText('Added "kopi" · S$2.40', { exact: true })
          .first(),
      ).toBeVisible()
    },
  },
  {
    id: 'S22',
    title: 'Keyboard shortcuts sheet',
    path: '/pulse',
    expenses: RICH,
    open: async (page) => {
      await page.locator('body').press('?')
      await expect(dialog(page, 'Keyboard shortcuts')).toBeVisible()
    },
  },
  {
    id: 'S23',
    title: 'Route error card',
    path: '/pulse',
    expenses: RICH,
    failChunk: '**/assets/LedgerScreen-*.js',
    open: async (page) => {
      await page
        .getByRole('link', { name: 'Ledger', exact: true })
        .filter({ visible: true })
        .first()
        .click()
      await expect(
        page.getByRole('heading', { name: 'SpendTrack was just updated', level: 1 }),
      ).toBeFocused()
    },
  },
  {
    id: 'S24',
    title: 'Overlay error card',
    path: '/pulse',
    expenses: RICH,
    failChunk: '**/assets/SettingsDrawer-*.js',
    open: async (page) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      // The app's own live regions are alerts too (empty until something is announced).
      await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText(
        "This panel couldn't open because a new version was just released.",
      )
      await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeFocused()
    },
  },
]

/**
 * Seeds, loads and opens a state, then waits for it to stop moving. With `system`, the state
 * opens in the dark theme and `switchTheme` turns it light in place.
 */
export async function enterState(
  page: Page,
  testInfo: TestInfo,
  state: UiState,
  theme: Theme | 'system' = 'dark',
): Promise<void> {
  if (state.failChunk) await page.route(state.failChunk, (route) => route.abort())
  await seed(page, {
    expenses: state.expenses,
    budgets: state.budgets,
    theme,
    holdChunkReload: state.failChunk !== undefined,
  })
  await page.goto(state.path)
  await waitForApp(page)
  await state.open?.(page, testInfo)
  await settle(page)
}

/** Brings a state that goes by itself (a toast) up again, so the next look finds it. */
export async function refreshTransient(
  page: Page,
  testInfo: TestInfo,
  state: UiState,
): Promise<void> {
  if (!state.transient) return
  await state.open?.(page, testInfo)
  await settle(page)
}

// ─── axe ──────────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url)
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/**
 * axe-core 4.13 on the whole document, every WCAG 2.0-2.2 A/AA rule plus best practices.
 * Injected by evaluation (DevTools protocol), so the page keeps its production CSP. Returns
 * one readable line per failing node; `incomplete` results are not failures.
 */
export async function axeViolations(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => window.axe !== undefined))) await page.evaluate(AXE_SOURCE)
  return page.evaluate(async (tags) => {
    const axe = window.axe
    if (!axe) throw new Error('axe-core did not load')
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations'],
    })
    return results.violations.flatMap((v) =>
      v.nodes.map(
        (n) =>
          `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${n.target.join(' ')} :: ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 240)}`,
      ),
    )
  }, AXE_TAGS)
}

// ─── geometry ─────────────────────────────────────────────────────────────────

/**
 * What scrolls sideways or sticks out past the edges on a screen `width` CSS px wide: the page,
 * every open dialog or alert, and every scroller or clipping box inside them or in <main> that
 * text or a control sticks out of (a sheet's own body scrolls inside a dialog that clips, so the
 * dialog alone never shows it). Rows built to scroll sideways (the heatmap's weeks) are marked
 * `data-scroll-x`; truncated text (an ellipsis) and a box clipping only decoration are fine.
 * `known` names what may stick out because its fix is deferred (see the state that passes it).
 * Measured against the screen's own width, not the document's client width: mobile WebKit
 * widens its layout viewport to fit content that is too wide, and then nothing would look too
 * wide.
 */
export async function horizontalOverflow(
  page: Page,
  width: number,
  known?: string,
): Promise<string[]> {
  return page.evaluate(
    ({ screen, known }) => {
      const out: string[] = []
      const doc = document.documentElement
      if (doc.scrollWidth > screen)
        out.push(`page is ${String(doc.scrollWidth)} px wide on a ${String(screen)} px screen`)
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect()
        // Empty or screen-reader-only (a 1 px clipped live region) is nothing on screen.
        return r.width > 2 && r.height > 2
      }
      const name = (el: Element) =>
        `${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`
      const roots = [
        ...document.querySelectorAll<HTMLElement>('main, [role="dialog"], [role="alert"]'),
      ]
      for (const el of roots) {
        if (el.tagName === 'MAIN' || !shown(el)) continue
        const r = el.getBoundingClientRect()
        if (r.left < -0.5 || r.right > screen + 0.5)
          out.push(
            `${el.getAttribute('aria-label') ?? el.id} spans ${String(r.left)}..${String(r.right)}`,
          )
        if (el.scrollWidth > el.clientWidth + 1)
          out.push(`${el.getAttribute('aria-label') ?? el.id} scrolls sideways inside`)
      }
      const CONTENT = 'a[href], button, input, select, textarea, [tabindex], [role]'
      /** A control, or an element with text of its own. */
      const isContent = (el: Element) =>
        el.matches(CONTENT) ||
        [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
      // The boxes inside (a dialog's own box is checked above).
      for (const root of roots) {
        for (const box of root.querySelectorAll<HTMLElement>('*')) {
          if (box.closest('[data-scroll-x]') || box.matches('input, select, textarea')) continue
          const style = getComputedStyle(box)
          if (!['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) continue
          if (style.textOverflow === 'ellipsis' || !shown(box)) continue
          if (box.scrollWidth <= box.clientWidth + 1) continue
          const edge = box.getBoundingClientRect()
          const sticking = [...box.querySelectorAll('*')].filter((el) => {
            if (!isContent(el) || !shown(el) || (known && el.matches(known))) return false
            // Inside a row built to scroll, or cut with an ellipsis: on purpose.
            const scroller = el.closest('[data-scroll-x]')
            if (scroller && box.contains(scroller)) return false
            for (let n = el.parentElement; n && n !== box; n = n.parentElement)
              if (getComputedStyle(n).textOverflow === 'ellipsis') return false
            const r = el.getBoundingClientRect()
            return r.right > edge.right + 1 || r.left < edge.left - 1
          })
          if (sticking.length)
            out.push(
              `${name(box)} scrolls sideways (${String(box.scrollWidth)}/${String(box.clientWidth)} px): ${sticking
                .slice(0, 4)
                .map(name)
                .join(', ')} stick out`,
            )
        }
      }
      return out
    },
    { screen: width, known },
  )
}

// ─── focus ring audit (AC-F1, AC-F2) ──────────────────────────────────────────

export interface FocusStop {
  /** Role and name, for messages. */
  name: string
  outlineStyle: string
  outlineWidth: number
  /** Contrast of the ring against the opaque background behind it. */
  ratio: number
  /** Sides of the ring cut off by an overflow ancestor. */
  clipped: string
}

/**
 * Describes the focused element's indicator once it has settled; null when focus is on <body>
 * or nowhere. `first` says the element is the one marked by an earlier call with `markAsFirst`
 * (a walk is back round).
 *
 * Settled matters twice. Under reduced motion index.css shortens every transition to 0.01 ms
 * rather than removing it, and `transition-property` defaults to `all`, so for one frame after
 * focus moves the outline can still be on its way from the initial values (3 px, current
 * colour, no offset). And the scroll that brings the control into view (the page, a sheet's
 * body, a chip row) can land a frame after the key: read before it, a ring at a scroller's edge
 * looks cut off. Either reading reports rings nobody ever sees.
 */
export function describeFocus(
  page: Page,
  markAsFirst = false,
): Promise<(FocusStop & { first: boolean }) | null> {
  return page.evaluate(async (mark) => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement) || el === document.body) return null
    const first = el.dataset.e2eStop === 'first'
    if (mark) el.dataset.e2eStop = 'first'
    const settling = [el, el.closest('.field-focus')].flatMap((n) =>
      n ? n.getAnimations().map((a) => a.finished.catch(() => undefined)) : [],
    )
    await Promise.race([Promise.all(settling), new Promise((resolve) => setTimeout(resolve, 500))])
    // Every scroller around the element (and the page) has kept still for two frames.
    const scrolled = () => {
      const at = [window.scrollX, window.scrollY]
      for (let n = el.parentElement; n; n = n.parentElement) at.push(n.scrollLeft, n.scrollTop)
      return at.join()
    }
    await new Promise<void>((resolve) => {
      let last = scrolled()
      let still = 0
      const started = performance.now()
      const tick = () => {
        const now = scrolled()
        still = now === last ? still + 1 : 0
        last = now
        if (still >= 2 || performance.now() - started > 1000) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    type Rgba = { r: number; g: number; b: number; a: number }
    const probe = document.createElement('canvas').getContext('2d')
    const parse = (value: string): Rgba => {
      const m = /rgba?\(([^)]+)\)/.exec(value)
      if (m?.[1]) {
        const [r = 0, g = 0, b = 0, a = 1] = m[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number)
        return { r, g, b, a }
      }
      if (!probe) return { r: 0, g: 0, b: 0, a: 0 }
      probe.clearRect(0, 0, 1, 1)
      probe.fillStyle = value
      probe.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data
      return { r, g, b, a: a / 255 }
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

    // A C2 field control draws no ring: its .field-focus wrapper does.
    const ringEl = (el.matches('.field-control') && el.closest<HTMLElement>('.field-focus')) || el
    const cs = getComputedStyle(ringEl)
    const width = parseFloat(cs.outlineWidth) || 0
    const offset = parseFloat(cs.outlineOffset) || 0

    // The opaque background the ring is drawn over: the element itself for an inset ring, else
    // its ancestors, compositing translucent layers down to the first opaque one.
    const layers: Rgba[] = []
    for (
      let n: Element | null = offset < 0 ? ringEl : ringEl.parentElement;
      n;
      n = n.parentElement
    ) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg.a > 0) layers.push(bg)
      if (bg.a >= 1) break
    }
    let base: Rgba = parse(getComputedStyle(document.body).backgroundColor)
    if (base.a < 1) base = parse(getComputedStyle(document.documentElement).backgroundColor)
    if (base.a < 1) base = { r: 0, g: 0, b: 0, a: 1 }
    for (const layer of layers.reverse()) base = over(layer, base)
    const ring = over(parse(cs.outlineColor), base)
    const [hi, lo] = [lum(ring), lum(base)].sort((a, b) => b - a)
    const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)

    // Cut off by an overflow ancestor (an inset ring draws inside the element's own box).
    const ext = offset < 0 ? 0 : offset + width
    const clippedBy = () => {
      const r = ringEl.getBoundingClientRect()
      const box = { l: r.left - ext, t: r.top - ext, r: r.right + ext, b: r.bottom + ext }
      for (let n = ringEl.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n)
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
        const a = n.getBoundingClientRect()
        const inner = {
          l: a.left + (parseFloat(s.borderLeftWidth) || 0),
          t: a.top + (parseFloat(s.borderTopWidth) || 0),
          r: a.right - (parseFloat(s.borderRightWidth) || 0),
          b: a.bottom - (parseFloat(s.borderBottomWidth) || 0),
        }
        const sides = [
          box.l < inner.l - 0.5 ? 'left' : '',
          box.t < inner.t - 0.5 ? 'top' : '',
          box.r > inner.r + 0.5 ? 'right' : '',
          box.b > inner.b + 0.5 ? 'bottom' : '',
        ].filter(Boolean)
        if (sides.length > 0)
          return `${sides.join('+')} by <${n.tagName.toLowerCase()} class="${String(n.className).slice(0, 60)}">`
      }
      return ''
    }
    // WebKit can reveal the focused control a few frames late, after the scroll looked still:
    // a ring that starts cut off gets 600 ms to come clear before it counts.
    let clipped = clippedBy()
    for (const until = performance.now() + 600; clipped && performance.now() < until; ) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      clipped = clippedBy()
    }

    const labelledBy = el.getAttribute('aria-labelledby')
    const label =
      el.getAttribute('aria-label') ??
      (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ??
      ((el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) ||
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.labels?.[0]?.textContent?.trim()
          : '') ||
        el.getAttribute('placeholder') ||
        el.tagName.toLowerCase())
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    return {
      name: `${role} "${label}"`,
      outlineStyle: cs.outlineStyle,
      outlineWidth: width,
      ratio: Math.round(ratio * 100) / 100,
      clipped,
      first,
    }
  }, markAsFirst)
}

/**
 * Presses Tab (or Shift+Tab) until focus comes back to the first stop, leaves the document, or
 * `max` presses, and describes every stop on the way.
 */
export async function tabWalk(
  page: Page,
  opts: { backwards?: boolean; max?: number; afterEach?: () => Promise<void> } = {},
): Promise<FocusStop[]> {
  const key = opts.backwards ? 'Shift+Tab' : 'Tab'
  const max = opts.max ?? 150
  const stops: FocusStop[] = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key)
    await opts.afterEach?.()
    const stop = await describeFocus(page, stops.length === 0)
    if (!stop) {
      if (stops.length === 0) continue
      break
    }
    if (stop.first && stops.length > 0) break
    stops.push(stop)
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-e2e-stop]'))
      delete el.dataset.e2eStop
  })
  return stops
}

/** One line per stop whose ring is missing, thin, faint or cut off. */
export function ringProblems(stops: readonly FocusStop[], opts: { contrast: boolean }): string[] {
  return stops.flatMap((s) => {
    const problems: string[] = []
    if (s.outlineStyle !== 'solid') problems.push(`outline-style ${s.outlineStyle}`)
    if (s.outlineWidth < 2) problems.push(`outline-width ${String(s.outlineWidth)}px`)
    if (opts.contrast && s.ratio < 3) problems.push(`ring contrast ${String(s.ratio)}:1`)
    if (s.clipped) problems.push(`ring clipped (${s.clipped})`)
    return problems.length > 0 ? [`${s.name}: ${problems.join(', ')}`] : []
  })
}

// ─── focus not obscured (AC-F5) ───────────────────────────────────────────────

/**
 * Tabs (or Shift+Tabs) through the page until focus comes back round, leaves the document or
 * `max` presses. After each press, once scrolling has settled, it reports the focused element
 * if any part of it is outside the band between the sticky header's bottom and the fixed tab
 * bar's top (WCAG 2.4.11). Controls in the header or the tab bar are part of those bars and
 * the skip link sits over the header by design, so they are not checked.
 */
export async function obscuredWalk(
  page: Page,
  opts: { backwards?: boolean; max?: number } = {},
): Promise<{ stops: number; problems: string[] }> {
  const key = opts.backwards ? 'Shift+Tab' : 'Tab'
  const max = opts.max ?? 150
  const problems: string[] = []
  let stops = 0
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key)
    const step = await page.evaluate(async (isFirst) => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement) || el === document.body) return { round: false, at: null }
      if (el.dataset.e2eStop === 'first') return { round: true, at: null }
      if (isFirst) el.dataset.e2eStop = 'first'

      // The page and every scroller around the element have stopped for two frames.
      const scrolled = () => {
        const at = [window.scrollX, window.scrollY]
        for (let n = el.parentElement; n; n = n.parentElement) at.push(n.scrollLeft, n.scrollTop)
        return at.join()
      }
      await new Promise<void>((resolve) => {
        let last = scrolled()
        let still = 0
        const started = performance.now()
        const tick = () => {
          const now = scrolled()
          still = now === last ? still + 1 : 0
          last = now
          if (still >= 2 || performance.now() - started > 2000) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })

      if (el.closest('header, nav') || el.matches('a[href^="#"]')) return { round: false, at: '' }
      /** Where the element sits against the band between the two bars ('' = inside it). */
      const outside = () => {
        const header = document.querySelector('header')?.getBoundingClientRect()
        const bars = [...document.querySelectorAll('nav')]
          .filter((n) => getComputedStyle(n).position === 'fixed')
          .map((n) => n.getBoundingClientRect())
          .filter((b) => b.height > 0)
        const top = header ? header.bottom : 0
        const bottom = Math.min(innerHeight, ...bars.map((b) => b.top))
        const r = el.getBoundingClientRect()
        if (r.top >= top - 0.5 && r.bottom <= bottom + 0.5) return ''
        return `${String(Math.round(r.top))}..${String(Math.round(r.bottom))} outside ${String(Math.round(top))}..${String(Math.round(bottom))}`
      }
      // As for rings (describeFocus): a reveal WebKit makes late gets 600 ms to land.
      let at = outside()
      for (const until = performance.now() + 600; at && performance.now() < until; ) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        at = outside()
      }
      if (!at) return { round: false, at: '' }
      const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40)
      return { round: false, at: `${name}: ${at}` }
    }, stops === 0)
    if (step.round) break
    if (step.at === null) {
      if (stops === 0) continue
      break
    }
    stops += 1
    if (step.at) problems.push(step.at)
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-e2e-stop]'))
      delete el.dataset.e2eStop
  })
  return { stops, problems }
}

// ─── touch targets (AC-F4) ────────────────────────────────────────────────────

const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="option"], [role="slider"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'

/**
 * Marks with `data-e2e-reach` what a finger can reach now: the top modal layer (the dialog that
 * holds focus, else the open one drawn highest) and the toast region beside it, or the whole
 * page when no modal layer is open. Returns which of the two it is.
 */
function markReachable(page: Page): Promise<'layer' | 'page'> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-e2e-reach]'))
      el.removeAttribute('data-e2e-reach')
    const open = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
    ].filter((d) => d.getBoundingClientRect().width > 0 && !d.closest('[inert]'))
    const z = (d: HTMLElement) => Number(getComputedStyle(d).zIndex) || 0
    const holder = document.activeElement?.closest<HTMLElement>('[role="dialog"]')
    const top = holder && open.includes(holder) ? holder : open.sort((a, b) => z(b) - z(a)).at(0)
    if (!top) {
      document.body.setAttribute('data-e2e-reach', '')
      return 'page'
    }
    for (const el of [top, ...document.querySelectorAll('[data-layer-exempt]')])
      el.setAttribute('data-e2e-reach', '')
    return 'layer'
  })
}

const clearReachable = (page: Page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-e2e-reach]'))
      el.removeAttribute('data-e2e-reach')
  })

/**
 * Coarse pointer: every visible, enabled interactive element a finger can reach (see
 * `markReachable`) is hit at its centre ± 20 px in 8 directions: a 44 × 44 hit area that no
 * neighbour overlaps. Heatmap days with spending are probed at ± 11 px and only have to keep
 * clear of their neighbours (20 px squares at a 24 px pitch, WCAG 2.5.8's spacing rule).
 *
 * In a modal layer every probe must land on the target: one on the backdrop means the hit area
 * is clipped. On the page, a probe that lands on a fixed bar or card drawn over the target (the
 * tab bar, a toast, a recovery card) is occlusion at this scroll position, not a small target,
 * and is left to the focus-not-obscured audit. `checked` counts the controls probed, so an audit
 * that found nothing to probe cannot pass for a clean one.
 */
export async function auditTargets(page: Page): Promise<{ checked: number; problems: string[] }> {
  const reach = await markReachable(page)
  const audit = await page.evaluate(
    ({ selector, onPage }) => {
      const out: string[] = []
      let checked = 0
      const heatmap = document.querySelector('[role="grid"]:has([data-day])')

      const hidden = (el: Element) => {
        if (el.closest('[aria-hidden="true"], [inert]')) return true
        if (el.matches(':disabled')) return true
        const s = getComputedStyle(el)
        if (s.visibility === 'hidden' || s.display === 'none') return true
        for (let n: Element | null = el; n; n = n.parentElement) {
          const style = getComputedStyle(n)
          // A see-through control over a styled box (the "More…" select) is still the target.
          if (n !== el && style.opacity === '0') return true
          // Screen-reader-only (the skip link until it has focus): never under a finger.
          if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)')
            return true
        }
        const r = el.getBoundingClientRect()
        return r.width < 2 || r.height < 2
      }
      /** The fixed-position element `el` is drawn in, if any. */
      const fixedLayer = (el: Element): Element | null => {
        for (let n: Element | null = el; n && n !== document.body; n = n.parentElement)
          if (getComputedStyle(n).position === 'fixed') return n
        return null
      }

      const seen = new Set<Element>()
      for (const scope of document.querySelectorAll('[data-e2e-reach]')) {
        for (const el of scope.querySelectorAll(selector)) {
          if (seen.has(el) || hidden(el)) continue
          seen.add(el)
          const cell = heatmap?.contains(el) ? el.closest('[role="gridcell"]') : null
          // Heatmap: only days with spending are pointer targets (their button); the cell is it.
          if (heatmap?.contains(el) && !(cell && el.matches('button'))) continue
          const target = cell ?? el
          const ownLayer = fixedLayer(target)
          checked += 1
          target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          const r = target.getBoundingClientRect()
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          // Eight probes, `d` px from the centre in each direction (a round 48 px button passes).
          const d = cell ? 11 : 20
          const k = Math.round(d * Math.SQRT1_2 * 10) / 10
          const misses: string[] = []
          for (const [dx, dy] of [
            [-d, 0],
            [d, 0],
            [0, -d],
            [0, d],
            [-k, -k],
            [k, -k],
            [-k, k],
            [k, k],
          ] as const) {
            const x = Math.min(innerWidth - 1, Math.max(0, cx + dx))
            const y = Math.min(innerHeight - 1, Math.max(0, cy + dy))
            const hit = document.elementFromPoint(x, y)
            if (hit === null) {
              misses.push(`(${String(dx)},${String(dy)})→nothing`)
              continue
            }
            if (hit === target || target.contains(hit)) continue
            // A heatmap day may sit in the 4 px gap; it must never land on a neighbouring day.
            if (cell !== null && !hit.closest('[role="gridcell"], button, a[href]')) continue
            const over = fixedLayer(hit)
            if (onPage && over !== null && over !== ownLayer && !over.contains(target)) continue
            const label = hit.getAttribute('aria-label')
            misses.push(
              `(${String(dx)},${String(dy)})→${hit.tagName.toLowerCase()}${label ? `[${label}]` : ''}`,
            )
          }
          if (misses.length > 0) {
            const name =
              target.getAttribute('aria-label') ??
              ((target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30) ||
                target.tagName.toLowerCase())
            out.push(
              `${name} (${String(Math.round(r.width))}×${String(Math.round(r.height))}): ${misses.join(' ')}`,
            )
          }
        }
      }
      return { checked, problems: out }
    },
    { selector: INTERACTIVE, onPage: reach === 'page' },
  )
  await clearReachable(page)
  return audit
}

const TEXT_FIELD =
  'input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"], textarea'

/**
 * Text fields a finger can reach (see `markReachable`): a tap 2 px inside the field box's top
 * and bottom edges (its `.field-focus` frame, or the input itself) focuses the input, so the
 * whole box is the target and no strip of it is dead.
 */
export async function fieldFillProblems(page: Page): Promise<string[]> {
  await markReachable(page)
  const count = await page.evaluate((selector) => {
    const all = [...document.querySelectorAll('[data-e2e-reach]')]
      .flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(selector)])
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 2 && r.height > 2 && !el.closest('[aria-hidden="true"], [inert]')
      })
    all.forEach((el, i) => {
      el.dataset.e2eField = String(i)
    })
    return all.length
  }, TEXT_FIELD)
  await clearReachable(page)
  const problems: string[] = []
  for (let i = 0; i < count; i++) {
    const box = await page.evaluate((index) => {
      const el = document.querySelector<HTMLInputElement>(`[data-e2e-field="${String(index)}"]`)
      if (!el) return null
      const field = el.closest<HTMLElement>('.field-focus') ?? el
      field.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = field.getBoundingClientRect()
      const label = el.labels?.[0]?.textContent?.trim()
      return {
        name: el.getAttribute('aria-label') ?? label ?? el.getAttribute('placeholder') ?? el.id,
        x: r.left + r.width / 2,
        top: r.top + 2,
        bottom: r.bottom - 2,
      }
    }, i)
    if (!box) continue
    for (const y of [box.top, box.bottom]) {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      await page.mouse.click(box.x, y)
      const focused = await page.evaluate(
        (index) => document.activeElement?.getAttribute('data-e2e-field') === String(index),
        i,
      )
      if (!focused)
        problems.push(`${box.name}: a tap at y=${String(Math.round(y))} misses the input`)
    }
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-e2e-field]'))
      delete el.dataset.e2eField
  })
  return problems
}

// ─── motion (AC-S3, AC-A3, AC-M1) ─────────────────────────────────────────────

/**
 * Records, on every animation frame for `ms`, how everything matching `selector` is moved off
 * its place while `action` runs: its `transform` when that is not the identity, and its
 * individual `translate`, `scale` and `rotate` when set to anything but the identity (`none`, a
 * zero translation, a scale of 1, a zero rotation). One entry per moved element per frame, the
 * transform first (`matrix(…)`, then `translate: …`, `scale: …`, `rotate: …`). Empty = nothing
 * moved on any frame.
 */
export async function transformFrames(
  page: Page,
  selector: string,
  action: () => Promise<void>,
  ms = 400,
): Promise<string[]> {
  await page.evaluate(
    ({ sel, duration }) => {
      const seen: string[] = []
      Reflect.set(window, '__e2eTransforms', seen)
      const until = performance.now() + duration
      const identity =
        /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\))$/
      const nums = (v: string) => (v.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
      const tick = () => {
        for (const el of document.querySelectorAll(sel)) {
          const s = getComputedStyle(el)
          const parts: string[] = []
          if (!identity.test(s.transform)) parts.push(s.transform)
          if (s.translate !== 'none' && nums(s.translate).some((n) => n !== 0))
            parts.push(`translate: ${s.translate}`)
          if (s.scale !== 'none' && nums(s.scale).some((n) => n !== 1))
            parts.push(`scale: ${s.scale}`)
          // A rotation's angle is its last number (an axis may come first: `1 0 0 45deg`).
          if (s.rotate !== 'none' && nums(s.rotate).at(-1) !== 0) parts.push(`rotate: ${s.rotate}`)
          if (parts.length > 0) seen.push(parts.join(' '))
        }
        if (performance.now() < until) requestAnimationFrame(tick)
        else Reflect.set(window, '__e2eTransformsDone', true)
      }
      Reflect.set(window, '__e2eTransformsDone', false)
      requestAnimationFrame(tick)
    },
    { sel: selector, duration: ms },
  )
  await action()
  await page.waitForFunction(() => Reflect.get(window, '__e2eTransformsDone') === true)
  const seen: unknown = await page.evaluate(() => Reflect.get(window, '__e2eTransforms'))
  return Array.isArray(seen) ? seen.slice(0, 200).map(String) : []
}
