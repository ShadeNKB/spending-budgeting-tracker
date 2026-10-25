import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsDrawer } from './SettingsDrawer'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { syncMessage, useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// A build with sync configured; the stores are set directly, so no request is made.
vi.mock('../../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/syncConfig')>()),
  syncEnabled: true,
}))

const CODE = '11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
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
  it("Sync's Export backup lands on the Download JSON backup button, and focus stays there", () => {
    useSyncStore.setState({
      syncId: CODE,
      cloudStatus: 'paused',
      lastError: { kind: 'too-large', message: syncMessage('too-large', 1365), since: NOW },
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
})

describe('Budgets', () => {
  const T1 = '2026-10-01T04:00:00.000Z'

  it('leaving a budget field unchanged writes nothing and says nothing', () => {
    useExpenseStore.setState({
      categories: ['Other', 'Meals'],
      budgets: { Meals: 200 },
      budgetUpdatedAt: { Meals: T1 },
    })
    openOn('budgets')
    const before = useExpenseStore.getState()
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Meals' })
    fireEvent.focus(field)
    fireEvent.blur(field)
    expect(useExpenseStore.getState().budgetUpdatedAt).toBe(before.budgetUpdatedAt)
    expect(useUIStore.getState().toasts).toEqual([])

    fireEvent.change(field, { target: { value: '250' } })
    fireEvent.blur(field)
    expect(useExpenseStore.getState().budgets).toEqual({ Meals: 250 })
    expect(useUIStore.getState().toasts).toHaveLength(1)
  })

  it('shows categories named "constructor" and "__proto__" with no budget and their real counts', () => {
    useExpenseStore.setState({
      categories: ['Other', 'constructor', '__proto__'],
      budgets: {},
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
    openOn('budgets')
    for (const name of ['constructor', '__proto__']) {
      expect(screen.getByRole('spinbutton', { name: `Monthly budget for ${name}` })).toHaveValue(
        null,
      )
    }
    cleanup()
    openOn('categories')
    const row = (name: string) =>
      screen.getByRole('textbox', { name: `Rename category ${name}` }).closest('li')
    expect(row('__proto__')).toHaveTextContent(/^1 expense$/)
    expect(row('constructor')).toHaveTextContent(/^0 expenses$/)
  })
})
