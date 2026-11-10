import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SettingsDrawer } from './SettingsDrawer'
import { keepPrevious } from './previousCode'
import { SyncPill } from '../../app/SyncPill'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// A build with sync configured; the stores are set directly, so no request is made.
vi.mock('../../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/syncConfig')>()),
  syncEnabled: true,
}))

const CODE = '11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const T1 = '2026-10-01T04:00:00.000Z'
/** The engine's too-large words (syncEngine.ts owns them; the panel shows them as they are). */
const TOO_LARGE =
  "Sync paused: your data (1365 KB) is too large for the sync server. It's still saved here — export a backup."

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

/**
 * The store booted from v4 keys (the public format, P2-14): its actions then run on real data.
 * Invented data.
 */
async function hydrateFrom(keys: Record<string, unknown>) {
  for (const [key, value] of Object.entries(keys)) localStorage.setItem(key, JSON.stringify(value))
  await act(async () => {
    await useExpenseStore.getState().hydrate()
  })
}

// The engine is a lazy chunk; its first import (transform included) is slow on a loaded machine.
beforeAll(async () => {
  await import('../../data/local/engine')
}, 60_000)

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  // jsdom does not lay out: the Settings panel scrolls a focused control into view.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** The drawer open on `tab`, after the sheet's opening focus has run. */
function openOn(tab: 'sync' | 'backup' | 'budgets' | 'categories') {
  useUIStore.setState({ settingsOpen: true, settingsTab: tab })
  render(<SettingsDrawer />)
  act(() => {
    vi.advanceTimersByTime(50)
  })
}

describe('SettingsDrawer focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // render tests: the views of a loaded store (P2-14)
    useExpenseStore.setState({ hydrated: true })
  })

  it("Sync's Export backup lands on the Download JSON backup button, and focus stays there", () => {
    useSyncStore.setState({
      syncId: CODE,
      cloudStatus: 'paused',
      lastError: { kind: 'too-large', message: TOO_LARGE, since: NOW },
    })
    openOn('sync')
    const exportButton = screen.getByRole('button', { name: 'Export backup' })
    exportButton.focus()
    fireEvent.click(exportButton)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getByRole('button', { name: /Download JSON backup/ })).toHaveFocus()
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('opening Backup any other way does not move focus to Download', () => {
    openOn('sync')
    const backupTab = screen.getByRole('tab', { name: 'Backup' })
    backupTab.focus()
    fireEvent.click(backupTab)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // The sheet's own opening focus does not run again on a tab switch either.
    expect(backupTab).toHaveFocus()
  })

  it('"Review" on the needs-attention toast opens Backup › Recovery on its list (PR-4)', async () => {
    // Recovery is its own chunk: it loads in real time.
    vi.useRealTimers()
    const item = {
      id: 'local-v4|abc',
      at: NOW,
      origin: 'local-v4',
      reason: 'bad-amount',
      kind: 'entry',
      salvage: null,
    } as const
    const api = {
      summary: () => ({ snapshots: 0, newChanges: 0, canWrite: true }),
      snapshots: () => [],
      previewSnapshot: () => Promise.reject(new Error('unused')),
      snapshotFile: () => Promise.resolve(null),
      changes: () => [],
      restoreChange: () => Promise.reject(new Error('unused')),
      markAllSeen: () => undefined,
      attention: () => [item],
      attentionFile: () => null,
      markFixed: () => undefined,
      discard: () => undefined,
      snapshotSkips: () => ({ back: 0, deletedSince: 0 }),
      unmarkFixed: () => undefined,
    }
    useExpenseStore.setState({
      attention: { quarantined: 1, copies: 0, unseen: 1, full: false },
      markAttentionSeen: vi.fn(),
      recovery: () => Promise.resolve(api),
    })
    useUIStore.setState({
      settingsOpen: true,
      settingsTab: 'backup',
      settingsFocus: 'recovery-attention',
    })
    render(<SettingsDrawer />)
    const heading = await screen.findByRole('heading', { name: 'Needs attention (1)' })
    await waitFor(() => {
      expect(heading).toHaveFocus()
    })
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })
})

describe('Settings › Sync names and focus (PR-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    useExpenseStore.setState({ hydrated: true })
  })

  it("the pill's button opens Settings on the Sync tab, whose panel is named by it", () => {
    useSyncStore.setState({
      syncId: CODE,
      cloudStatus: 'error',
      lastError: { kind: 'network', message: "Couldn't reach the sync server.", since: NOW },
    })
    render(
      <>
        <SyncPill />
        <SettingsDrawer />
      </>,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^Sync retrying\. Opens Settings, Sync\.$/ }),
    )
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(screen.getByRole('tab', { name: 'Sync' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Sync' })).toHaveTextContent(
      "Couldn't reach the sync server.",
    )
  })

  it('linked: every control is named, Show says what it does, and Sync now comes first', () => {
    useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW })
    openOn('sync')
    const panel = screen.getByRole('tabpanel', { name: 'Sync' })
    const names = within(panel)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent.trim())
    expect(names).toEqual(['Sync now', 'Show code', 'Copy', 'Disconnect sync'])
    // its name changes to "Hide code" once shown, so it is no pressed toggle as well
    expect(within(panel).getByRole('button', { name: 'Show code' })).not.toHaveAttribute(
      'aria-pressed',
    )
  })

  it('unlinked: Reconnect is named without the code and described by its date; Join by its field', () => {
    keepPrevious(CODE, NOW)
    openOn('sync')
    const panel = screen.getByRole('tabpanel', { name: 'Sync' })
    const reconnect = within(panel).getByRole('button', {
      name: /^Reconnect to the code ending in /,
    })
    expect(reconnect).toHaveAccessibleDescription(/^This device remembers the code until /)
    const field = within(panel).getByRole('textbox', { name: 'Sync code' })
    expect(document.getElementById(field.getAttribute('aria-describedby') ?? '')).toHaveAttribute(
      'role',
      'status',
    )
    expect(within(panel).getByRole('button', { name: 'Join' })).toBeDisabled()
    expect(
      within(panel).getByRole('button', { name: 'Generate sync code for this device' }),
    ).toBeInTheDocument()
  })
})

// walk5: with the engine chunk failed, Categories listed the defaults at "0" each with live
// delete buttons, and Backup said "0 entries": it read as data that was gone.
describe('the data tabs without data', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  it.each(['categories', 'budgets', 'backup'] as const)(
    '%s says the data is loading, never empty lists',
    (tab) => {
      openOn(tab)
      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveTextContent('Loading your data…')
      expect(screen.queryByRole('button', { name: /Delete|Download JSON backup/ })).toBeNull()
    },
  )

  it.each(['categories', 'budgets', 'backup'] as const)(
    '%s says SpendTrack could not start, with Reload and the raw download',
    (tab) => {
      useExpenseStore.setState({ bootError: 'engine-load' })
      openOn(tab)
      const note = screen.getByRole('group', { name: "SpendTrack couldn't start" })
      expect(note).toHaveTextContent(
        "Your data can't be shown here. It's still saved on this device.",
      )
      expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Download my data' })).toBeEnabled()
      expect(screen.queryByText(/\b0 entries\b/)).toBeNull()
    },
  )

  it('Sync keeps working: it needs no local data', () => {
    useExpenseStore.setState({ bootError: 'engine-load' })
    openOn('sync')
    expect(screen.queryByRole('group', { name: "SpendTrack couldn't start" })).toBeNull()
  })
})

describe('Display on a phone (F-109)', () => {
  const phone = () =>
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('max-width: 767px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))

  it('folds Theme and Currency into one row that says what is set', () => {
    phone()
    vi.useFakeTimers()
    useUIStore.setState({ theme: 'dark', currency: 'SGD' })
    openOn('categories')
    const row = screen.getByRole('button', { name: /^Display/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveTextContent('Dark · SGD')
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Currency' })).toBeNull()
    // The tabs and their section are what shows.
    expect(screen.getByRole('tab', { name: 'Categories' })).toBeVisible()

    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: 'Currency' }), {
      target: { value: 'USD' },
    })
    expect(row).toHaveTextContent('Dark · USD')
  })

  it('is folded again each time the drawer opens', () => {
    phone()
    vi.useFakeTimers()
    openOn('categories')
    fireEvent.click(screen.getByRole('button', { name: /^Display/ }))
    act(() => {
      useUIStore.setState({ settingsOpen: false })
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    act(() => {
      useUIStore.setState({ settingsOpen: true })
    })
    expect(screen.getByRole('button', { name: /^Display/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('from 768 px there is no row: Theme and Currency are always there', () => {
    vi.useFakeTimers()
    openOn('categories')
    expect(screen.queryByRole('button', { name: /^Display/ })).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Currency' })).toBeVisible()
  })
})

describe('Currency hint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  it('says the currency applies on every synced device only when a sync code is set', () => {
    openOn('categories')
    expect(screen.getByText(/^Changes the symbol only/)).toHaveTextContent(
      "Changes the symbol only — amounts aren't converted.",
    )
    cleanup()
    useSyncStore.setState({ syncId: CODE })
    openOn('categories')
    expect(screen.getByText(/^Changes the symbol only/)).toHaveTextContent(
      "Changes the symbol only — amounts aren't converted. Applies on all your synced devices.",
    )
  })
})

describe('Budgets', () => {
  it('leaving a budget field unchanged writes nothing and says nothing', async () => {
    await hydrateFrom({
      categories: ['Other', 'Meals'],
      categoryBudgets: { Meals: 200 },
      categoryBudgetUpdatedAt: { Meals: T1 },
    })
    vi.useFakeTimers()
    openOn('budgets')
    const before = useExpenseStore.getState().budgets
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Meals' })
    fireEvent.focus(field)
    fireEvent.blur(field)
    expect(useExpenseStore.getState().budgets).toBe(before)
    expect(useUIStore.getState().toasts).toEqual([])

    fireEvent.change(field, { target: { value: '250' } })
    fireEvent.blur(field)
    expect({ ...useExpenseStore.getState().budgets }).toEqual({ Meals: 250 })
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })

  it('a budget the store refuses is said, and the field shows the budget kept', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'], categoryBudgets: { Meals: 200 } })
    vi.useFakeTimers()
    openOn('budgets')
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Meals' })
    fireEvent.change(field, { target: { value: '20000000' } })
    fireEvent.blur(field)
    expect({ ...useExpenseStore.getState().budgets }).toEqual({ Meals: 200 })
    const [toast] = useUIStore.getState().toasts
    expect(toast?.kind).toBe('error')
    expect(toast?.message).not.toBe('')
    expect(field).toHaveValue(200)
  })

  it('text the field cannot read as a number is refused, never taken as an emptied field (F-114)', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'], categoryBudgets: { Meals: 200 } })
    vi.useFakeTimers()
    openOn('budgets')
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Meals' })
    // What a browser shows for "12,50" in a number field: an empty value, flagged bad input.
    Object.defineProperty(field, 'validity', { value: { badInput: true }, configurable: true })
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect({ ...useExpenseStore.getState().budgets }).toEqual({ Meals: 200 })
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'Enter the budget as a number, like 250 or 99.50.',
    })
    expect(field).toHaveValue(200)
  })

  it('a zero or negative cap is refused with the reason, not dropped in silence', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'], categoryBudgets: { Meals: 200 } })
    vi.useFakeTimers()
    openOn('budgets')
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Meals' })
    for (const typed of ['0', '-5']) {
      fireEvent.change(field, { target: { value: typed } })
      fireEvent.blur(field)
      expect({ ...useExpenseStore.getState().budgets }).toEqual({ Meals: 200 })
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        kind: 'error',
        message: 'Amount must be greater than 0 and at most 10,000,000.',
      })
      expect(field).toHaveValue(200)
    }
    // Emptying the field clears the budget.
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect({ ...useExpenseStore.getState().budgets }).toEqual({})
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Budget cleared')
  })

  it('never makes "constructor" or "__proto__" a category, nor shows a prototype value', async () => {
    await hydrateFrom({
      categories: ['Other', 'constructor', '__proto__'],
      expenses: [
        {
          id: 'e1',
          itemName: 'x',
          amount: 1,
          category: '__proto__',
          date: '2026-10-01T12:00:00',
          createdAt: T1,
        },
      ],
    })
    vi.useFakeTimers()
    openOn('budgets')
    for (const name of ['constructor', '__proto__']) {
      expect(screen.queryByRole('spinbutton', { name: `Monthly budget for ${name}` })).toBeNull()
    }
    expect(screen.getByRole('spinbutton', { name: 'Monthly budget for Other' })).toHaveValue(null)
    cleanup()
    // The entry filed under "__proto__" stays readable, in Other.
    openOn('categories')
    const row = screen.getByText(/^Other/).closest('li')
    expect(row).toHaveTextContent(/1 expense$/)
    // Typing one is refused with a message, and nothing is added.
    const field = screen.getByRole('textbox', { name: 'Add category' })
    fireEvent.change(field, { target: { value: 'constructor' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useExpenseStore.getState().categories).not.toContain('constructor')
    expect(useUIStore.getState().toasts.at(-1)?.kind).toBe('error')
  })
})

describe('Categories', () => {
  it('a name the store refuses is said and the field keeps it for a fix', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'] })
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Add category' })
    const long = 'x'.repeat(200)
    fireEvent.change(field, { target: { value: long } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useExpenseStore.getState().categories).not.toContain(long)
    expect(useUIStore.getState().toasts.at(-1)?.kind).toBe('error')
    expect(field).toHaveValue(long)
  })

  it('a refused rename is said and the row shows the name kept', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'] })
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Meals' })
    fireEvent.change(field, { target: { value: 'y'.repeat(200) } })
    fireEvent.blur(field)
    expect(useExpenseStore.getState().categories).toContain('Meals')
    expect(useUIStore.getState().toasts.at(-1)?.kind).toBe('error')
    expect(field).toHaveValue('Meals')
  })

  it('adding a name that is listed already says so, keeps the text, and adds nothing', async () => {
    await hydrateFrom({ categories: ['Other', 'Food & Dining'] })
    vi.useFakeTimers()
    openOn('categories')
    const before = useExpenseStore.getState().categories
    const field = screen.getByRole('textbox', { name: 'Add category' })
    fireEvent.change(field, { target: { value: ' Food & Dining ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useExpenseStore.getState().categories).toEqual(before)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'info',
      message: '"Food & Dining" is already a category',
    })
    expect(useUIStore.getState().toasts.map((t) => t.message)).not.toContain('Category added')
    expect(field).toHaveValue(' Food & Dining ')
  })

  const gamingAndShopping = {
    categories: ['Other', 'Gaming', 'Shopping'],
    expenses: [
      {
        id: 'g1',
        itemName: 'Controller',
        amount: 89,
        category: 'Gaming',
        date: '2026-10-01T12:00:00',
        createdAt: T1,
      },
    ],
  }

  it('a rename onto a listed name asks first; Keep merges nothing and keeps the name (F-076)', async () => {
    await hydrateFrom(gamingAndShopping)
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Gaming' })
    fireEvent.change(field, { target: { value: ' Shopping ' } })
    fireEvent.blur(field)
    // Nothing merged by the blur: the row asks, with what would move.
    expect(useExpenseStore.getState().categories).toContain('Gaming')
    expect(useExpenseStore.getState().expenses[0]?.category).toBe('Gaming')
    expect(screen.getByText('Merge into Shopping?')).toBeInTheDocument()
    expect(screen.getByText('1 expense moves to Shopping')).toBeInTheDocument()
    const keep = screen.getByRole('button', { name: 'Keep Gaming' })
    expect(keep).toHaveFocus()
    fireEvent.click(keep)
    expect(useExpenseStore.getState().categories).toContain('Gaming')
    const again = screen.getByRole('textbox', { name: 'Rename category Gaming' })
    expect(again).toHaveValue('Gaming')
    expect(again).toHaveFocus()
    expect(useUIStore.getState().toasts.map((t) => t.message)).not.toContain(
      'Merged "Gaming" into "Shopping"',
    )
  })

  it.each([
    [{ Gaming: 50 }, "Shopping takes Gaming's budget · 1 expense moves to Shopping"],
    [
      { Gaming: 50, Shopping: 80 },
      "Shopping keeps its own budget, not Gaming's · 1 expense moves to Shopping",
    ],
  ])('a merge question says what happens to the budget first (%o)', async (budgets, detail) => {
    await hydrateFrom({ ...gamingAndShopping, categoryBudgets: budgets })
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Gaming' })
    fireEvent.change(field, { target: { value: 'Shopping' } })
    fireEvent.blur(field)
    expect(screen.getByText(detail)).toBeInTheDocument()
  })

  it('Return renames, and focus stays on the field under its new name', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'] })
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Meals' })
    field.focus()
    fireEvent.change(field, { target: { value: 'Food' } })
    // Its own Enter is cancelled: the browser's would press whatever took focus meanwhile.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    expect(useExpenseStore.getState().categories).toContain('Food')
    expect(useExpenseStore.getState().categories).not.toContain('Meals')
    expect(screen.getByRole('textbox', { name: 'Rename category Food' })).toHaveFocus()
  })

  it('Return onto a listed name asks, and a held or IME Enter does nothing', async () => {
    await hydrateFrom(gamingAndShopping)
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Gaming' })
    field.focus()
    fireEvent.change(field, { target: { value: 'Shopping' } })
    fireEvent.keyDown(field, { key: 'Enter', repeat: true })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(screen.queryByText('Merge into Shopping?')).toBeNull()
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    expect(screen.getByText('Merge into Shopping?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Gaming' })).toHaveFocus()
    expect(useExpenseStore.getState().categories).toContain('Gaming')
  })

  it('a merge confirmed says it merged them, and Undo takes the merge back', async () => {
    await hydrateFrom(gamingAndShopping)
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Gaming' })
    fireEvent.change(field, { target: { value: 'Shopping' } })
    fireEvent.blur(field)
    fireEvent.click(screen.getByRole('button', { name: 'Merge Gaming into Shopping' }))
    expect(screen.getByRole('textbox', { name: 'Rename category Shopping' })).toHaveFocus()
    expect(useExpenseStore.getState().categories).not.toContain('Gaming')
    expect(useExpenseStore.getState().expenses[0]?.category).toBe('Shopping')
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Merged "Gaming" into "Shopping"')
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().categories).toContain('Gaming')
    expect(useExpenseStore.getState().expenses[0]?.category).toBe('Gaming')
  })

  it('a plain rename offers Undo too', async () => {
    await hydrateFrom({ categories: ['Other', 'Meals'] })
    vi.useFakeTimers()
    openOn('categories')
    const field = screen.getByRole('textbox', { name: 'Rename category Meals' })
    fireEvent.change(field, { target: { value: 'Food' } })
    fireEvent.blur(field)
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'info', message: 'Renamed' })
    expect(toast?.action?.label).toBe('Undo')
  })

  it('deleting a category offers Undo, and Undo brings it back with its entries', async () => {
    await hydrateFrom({
      categories: ['Other', 'Meals'],
      expenses: [
        {
          id: 'm1',
          itemName: 'Laksa',
          amount: 6,
          category: 'Meals',
          date: '2026-10-01T12:00:00',
          createdAt: T1,
        },
      ],
    })
    vi.useFakeTimers()
    openOn('categories')
    fireEvent.click(screen.getByRole('button', { name: 'Delete category Meals' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete category Meals' }), { detail: 1 })
    expect(useExpenseStore.getState().categories).not.toContain('Meals')
    expect(useExpenseStore.getState().expenses[0]?.category).toBe('Other')
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Category deleted')
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().categories).toContain('Meals')
    expect(useExpenseStore.getState().expenses[0]?.category).toBe('Meals')
  })
})
