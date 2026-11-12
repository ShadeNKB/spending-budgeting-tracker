import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsDrawer } from './SettingsDrawer'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import type { Expense } from '../../types'

// Invented data, booted through the real engine from the v4 keys (P2-14), so the actions run.
const day = (id: string, itemName: string, category: string): Expense => ({
  id,
  itemName,
  amount: 4.5,
  category,
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
})
const EXPENSES = [
  day('a', 'Kopi O', 'Food'),
  day('b', 'Grab', 'Transport'),
  day('c', 'Bus', 'Transport'),
]

// jsdom does not lay out, so it has no scrollIntoView; record the calls instead.
const scrollIntoView = vi.fn()

/** Storage holds `keys` (v4, the public format); the store boots from it. */
async function hydrateFrom(keys: Record<string, unknown>) {
  localStorage.clear()
  for (const [key, value] of Object.entries(keys)) localStorage.setItem(key, JSON.stringify(value))
  await act(async () => {
    await useExpenseStore.getState().hydrate()
  })
}

// The engine is a lazy chunk; its first import (transform included) is slow on a loaded machine.
beforeAll(async () => {
  await import('../../data/local/engine')
}, 60_000)

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { media, matches: false }),
  )
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
  })
  await hydrateFrom({ expenses: EXPENSES, categories: ['Food', 'Transport', 'Gifts'] })
  useUIStore.setState({ settingsOpen: true, settingsTab: 'categories', toasts: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  scrollIntoView.mockClear()
  localStorage.clear()
})

/**
 * A tab by its name, looked up inside the tablist: a role query over the whole sheet computes
 * every element's role and visibility, and these tests ask for a tab many times.
 */
const tab = (name: string) =>
  within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name })

describe('Settings sections', () => {
  it('is a named tablist with one tab stop on the selected tab', () => {
    render(<SettingsDrawer />)
    const list = screen.getByRole('tablist', { name: 'Settings sections' })
    const tabs = within(list).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent || t.getAttribute('aria-label'))).toEqual([
      'Categories',
      'Budgets',
      'Backup',
      'Sync',
    ])
    expect(tab('Categories')).toHaveAttribute('aria-selected', 'true')
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([tab('Categories')])
    expect(screen.getByRole('tabpanel', { name: 'Categories' })).toBeInTheDocument()
    expect(tab('Categories')).toHaveAttribute(
      'aria-controls',
      screen.getByRole('tabpanel').getAttribute('id'),
    )
  })

  it('moves and selects with the arrow keys, Home and End, wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(<SettingsDrawer />)
    act(() => {
      tab('Categories').focus()
    })

    await user.keyboard('{ArrowRight}')
    expect(tab('Budgets')).toHaveFocus()
    expect(tab('Budgets')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Budgets').tabIndex).toBe(0)
    expect(tab('Categories').tabIndex).toBe(-1)
    expect(screen.getByRole('tabpanel', { name: 'Budgets' })).toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    expect(tab('Backup')).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Backup' })).toBeInTheDocument()

    await user.keyboard('{Home}')
    expect(tab('Categories')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(tab('Sync')).toHaveFocus()
    expect(useUIStore.getState().settingsTab).toBe('sync')
    await user.keyboard('{ArrowRight}')
    expect(tab('Categories')).toHaveFocus()
    await user.keyboard('{End}')
    expect(tab('Sync')).toHaveFocus()
  })

  it('leaves arrows with a modifier to the browser (Alt+Left is Back)', () => {
    render(<SettingsDrawer />)
    act(() => {
      tab('Categories').focus()
    })
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      fireEvent.keyDown(tab('Categories'), { key: 'ArrowLeft', [mod]: true })
      fireEvent.keyDown(tab('Categories'), { key: 'End', [mod]: true })
    }
    expect(tab('Categories')).toHaveFocus()
    expect(useUIStore.getState().settingsTab).toBe('categories')
  })

  // Tab from the tabs always lands in the chosen section: on its first control, or on the panel
  // itself when it holds none (Sync without a relay, Budgets without categories). A panel that
  // holds controls is no extra stop of its own.
  it.each([
    ['budgets', 'Budgets', 'Monthly budget for all spending'],
    ['backup', 'Backup', 'Download JSON backup'],
    ['categories', 'Categories', 'Add category'],
  ] as const)('Tab from the %s tab moves to its first control', async (section, name, first) => {
    const user = userEvent.setup()
    useUIStore.setState({ settingsTab: section })
    render(<SettingsDrawer />)
    const panel = screen.getByRole('tabpanel', { name })
    expect(panel).not.toHaveAttribute('tabindex')
    act(() => {
      tab(name).focus()
    })
    await user.tab()
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toHaveAccessibleName(first)
  })

  // WebKit reveals only the caret line of a text field that Tab lands on, leaving the bottom of
  // the field and its ring under the edge of the sheet; the panel shows the whole control.
  it('scrolls a control that takes focus in the panel fully into view', async () => {
    const user = userEvent.setup()
    useUIStore.setState({ settingsTab: 'budgets' })
    render(<SettingsDrawer />)
    act(() => {
      tab('Budgets').focus()
    })
    // the whole month's field, Food's, then Transport's
    await user.tab()
    await user.tab()
    await user.tab()
    const field = screen.getByRole('spinbutton', { name: 'Monthly budget for Transport' })
    expect(field).toHaveFocus()
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(field)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('makes a panel with no control a tab stop of its own', async () => {
    const user = userEvent.setup()
    // A view with no categories (render only).
    useExpenseStore.setState({ categories: [] })
    useUIStore.setState({ settingsTab: 'budgets' })
    render(<SettingsDrawer />)
    act(() => {
      tab('Budgets').focus()
    })
    await user.tab()
    expect(screen.getByRole('tabpanel', { name: 'Budgets' })).toHaveFocus()

    // Sync without a relay is text only; switching on to it keeps the panel reachable.
    act(() => {
      tab('Budgets').focus()
    })
    await user.keyboard('{End}')
    expect(tab('Sync')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('tabpanel', { name: 'Sync' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(tab('Sync')).toHaveFocus()

    // Back on a section with controls, the panel stops being a stop.
    await user.keyboard('{Home}')
    expect(screen.getByRole('tabpanel', { name: 'Categories' })).not.toHaveAttribute('tabindex')
  })
})

describe('Settings category delete', () => {
  it('asks in the row, focuses Keep, and Keep returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<SettingsDrawer />)
    await user.click(screen.getByRole('button', { name: 'Delete category Transport' }))

    const group = screen.getByRole('group', { name: 'Delete Transport?' })
    expect(group).toHaveAccessibleDescription('2 expenses move to Other')
    expect(within(group).getByRole('button', { name: 'Keep Transport' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Delete category Transport' })).toHaveFocus()
    expect(useExpenseStore.getState().categories).toContain('Transport')
  })

  it('says what happens to the expenses and the budget, in plain English', async () => {
    const user = userEvent.setup()
    await hydrateFrom({
      expenses: EXPENSES,
      categories: ['Food', 'Transport', 'Gifts'],
      categoryBudgets: { Food: 120 },
    })
    render(<SettingsDrawer />)
    await user.click(screen.getByRole('button', { name: 'Delete category Food' }))
    expect(screen.getByRole('group', { name: 'Delete Food?' })).toHaveAccessibleDescription(
      'Its budget is deleted · 1 expense moves to Other',
    )
    await user.click(screen.getByRole('button', { name: 'Keep Food' }))
    await user.click(screen.getByRole('button', { name: 'Delete category Gifts' }))
    expect(screen.getByRole('group', { name: 'Delete Gifts?' })).toHaveAccessibleDescription(
      'No expenses use it',
    )
  })

  // Other is where a deleted category's entries go: the store refuses to rename or delete it, so
  // the row offers neither, and says why to a screen reader.
  it('keeps Other: no rename field and no delete button, with its count', async () => {
    await hydrateFrom({
      categories: ['Food', 'Other'],
      expenses: [day('o1', 'Misc', 'Other'), day('o2', 'Stuff', 'Other')],
    })
    render(<SettingsDrawer />)
    expect(screen.queryByRole('textbox', { name: 'Rename category Other' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete category Other' })).toBeNull()
    const row = screen.getByText(/^Other/).closest('li')
    expect(row).toHaveTextContent("Other: deleted categories' entries go here2 expenses")
    expect(screen.getByRole('textbox', { name: 'Rename category Food' })).toBeInTheDocument()
  })

  it('after a delete, focuses the next row, else the previous, else Add category', async () => {
    const user = userEvent.setup()
    // No entries; the store keeps Other (where a deleted category's entries would go) last.
    await hydrateFrom({ expenses: [], categories: ['Food', 'Transport', 'Gifts'] })
    render(<SettingsDrawer />)
    await user.click(screen.getByRole('button', { name: 'Delete category Transport' }))
    await user.click(screen.getByRole('button', { name: 'Delete category Transport' }))
    expect(useExpenseStore.getState().categories).toEqual(['Food', 'Gifts', 'Other'])
    expect(screen.getByRole('button', { name: 'Delete category Gifts' })).toHaveFocus()

    // Other cannot be deleted, so the next row to focus is the one before.
    await user.click(screen.getByRole('button', { name: 'Delete category Gifts' }))
    await user.click(screen.getByRole('button', { name: 'Delete category Gifts' }))
    expect(screen.getByRole('button', { name: 'Delete category Food' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Delete category Food' }))
    await user.click(screen.getByRole('button', { name: 'Delete category Food' }))
    expect(useExpenseStore.getState().categories).toEqual(['Other'])
    expect(screen.getByRole('textbox', { name: 'Add category' })).toHaveFocus()
  })

  it('says how many expenses each category holds', () => {
    render(<SettingsDrawer />)
    const list = screen.getByRole('list')
    expect(within(list).getByText(/^2/).textContent).toBe('2 expenses')
    expect(within(list).getByText(/^1/).textContent).toBe('1 expense')
  })
})

describe('Settings backup confirmations', () => {
  beforeEach(() => {
    useUIStore.setState({ settingsTab: 'backup' })
  })

  it('Delete all: focuses Cancel, and focus returns to the trigger after either choice', async () => {
    const user = userEvent.setup()
    render(<SettingsDrawer />)
    const trigger = () => screen.getByRole('button', { name: 'Delete all entries' })
    await user.click(trigger())
    const group = screen.getByRole('group', { name: 'Delete all 3 entries?' })
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(trigger()).toHaveFocus()
    expect(useExpenseStore.getState().expenses).toHaveLength(3)

    await user.click(trigger())
    const confirm = screen.getByRole('button', { name: 'Delete all' })
    expect(confirm.className).toMatch(/bg-negative/)
    await user.dblClick(confirm)
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(trigger()).toHaveFocus()

    // Its 30 s Undo brings every entry back.
    const toast = useUIStore.getState().toasts.find((t) => t.message === 'All entries deleted')
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    // Brought back as new copies (a forward write that syncs), the same entries.
    expect(
      useExpenseStore
        .getState()
        .expenses.map((e) => e.itemName)
        .sort(),
    ).toEqual(['Bus', 'Grab', 'Kopi O'])
  })

  async function chooseBackupFile() {
    const backup = { expenses: [day('z', 'Laksa', 'Food')], categories: ['Food'] }
    const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('no file input')
    screen.getByRole('button', { name: 'Import JSON backup' }).focus()
    fireEvent.change(input, { target: { files: [file] } })
    return screen.findByRole('region', { name: 'Import backup.json?' })
  }

  it('Import: the preview focuses Restore; Cancel returns focus to "Import JSON backup"', async () => {
    const user = userEvent.setup()
    render(<SettingsDrawer />)
    const preview = await chooseBackupFile()
    expect(preview).toHaveAccessibleDescription(
      'Nothing on this device or your other devices will be removed.',
    )
    expect(within(preview).getByRole('button', { name: 'Restore' })).toHaveFocus()
    await user.click(within(preview).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Import JSON backup' })).toHaveFocus()
    expect(useExpenseStore.getState().expenses).toHaveLength(3)
  })

  it('Import: Restore adds the file once, keeps everything here, and returns focus', async () => {
    const user = userEvent.setup()
    render(<SettingsDrawer />)
    const preview = await chooseBackupFile()
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1 in the file', '1 new'])
    await user.dblClick(within(preview).getByRole('button', { name: 'Restore' }))
    expect(
      useExpenseStore
        .getState()
        .expenses.map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'b', 'c', 'z'])
    expect(screen.getByRole('button', { name: 'Import JSON backup' })).toHaveFocus()
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Imported · 1 added')
  })
})
