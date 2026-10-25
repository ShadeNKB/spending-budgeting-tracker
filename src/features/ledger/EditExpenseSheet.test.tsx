import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditExpenseSheet } from './EditExpenseSheet'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { addDays, todayKey } from '../../lib/dates'
import type { Expense } from '../../types'

// Invented data.
const KOPI: Expense = {
  id: 'e-1',
  itemName: 'Kopi O',
  amount: 1.8,
  category: 'Food & Dining',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}
const GRAB: Expense = { ...KOPI, id: 'e-2', itemName: 'Grab to camp', amount: 14.2 }

/** jsdom has no matchMedia: answer every query as a phone (coarse pointer) or a laptop would. */
function stubPointer(pointer: 'fine' | 'coarse') {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), {
      media,
      matches: media.includes(`pointer: ${pointer}`),
    }),
  )
}

// jsdom does not lay out, so it has no scrollIntoView; record the calls instead.
const scrollIntoView = vi.fn()

beforeEach(() => {
  stubPointer('coarse')
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
  })
  useExpenseStore.setState({ expenses: [KOPI, GRAB], hydrated: true })
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  scrollIntoView.mockClear()
})

const item = () => screen.getByRole('textbox', { name: 'Item' })
const amount = () => screen.getByRole('spinbutton', { name: 'Amount' })

// Touch screens floor a select's own text at 16 px (index.css, against iOS focus zoom). Drawn
// by the select itself, this chip would grow past its 12 px neighbours.
describe('EditExpenseSheet "More…" category chip', () => {
  it('draws its label at chip size, with the native select invisible on top', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    const more = screen.getByRole('combobox', { name: 'More categories' })
    const chip = more.parentElement
    const label = () => chip?.querySelector('span[aria-hidden="true"]')
    expect(label()).toHaveTextContent('More…')
    expect(chip).toHaveClass('text-[12px]', 'h-9')
    expect(more).toHaveClass('opacity-0', 'absolute')

    await user.selectOptions(more, 'Investment')
    expect(more).toHaveValue('Investment')
    expect(label()).toHaveTextContent('Investment')
  })
})

describe('EditExpenseSheet initial focus', () => {
  it('focuses Item on a laptop (fine pointer), to type at once', () => {
    stubPointer('fine')
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    expect(item()).toHaveFocus()
  })

  it('focuses the dialog on a phone, so no keyboard pops up over the sheet', () => {
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    expect(item()).not.toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Edit expense' })).toHaveFocus()
  })
})

// The sheet scrolls on a phone. WebKit reveals only the caret line of a text field that Tab
// lands on (Tab wrapping back to Item left its frame and ring under the sheet's top edge):
// focus brings the whole control, ring included, into view.
describe('EditExpenseSheet focus scrolling', () => {
  it('brings a control that takes focus fully into view inside the sheet', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    item().focus()
    scrollIntoView.mockClear()
    await user.tab()
    expect(amount()).toHaveFocus()
    expect(scrollIntoView.mock.contexts).toContain(amount())
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })
})

describe('EditExpenseSheet validation', () => {
  it('marks an empty Item inline, focuses it, and toasts nothing', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={KOPI} onClose={onClose} />)
    await user.clear(item())
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(item()).toHaveFocus()
    expect(item()).toHaveAttribute('aria-invalid', 'true')
    expect(item()).toHaveAccessibleDescription('Required')
    expect(onClose).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts).toEqual([])
    expect(useExpenseStore.getState().expenses[0]?.itemName).toBe('Kopi O')
  })

  it('focuses Amount when only the amount is wrong, and clears the error as it is fixed', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    await user.clear(amount())
    await user.type(amount(), '0')
    await user.keyboard('{Enter}')

    expect(amount()).toHaveFocus()
    expect(amount()).toHaveAccessibleDescription('Enter a valid amount')
    expect(item()).not.toHaveAttribute('aria-invalid')

    await user.type(amount(), '.5')
    expect(amount()).not.toHaveAttribute('aria-invalid')
  })

  it('names the limit for an amount that is too large', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    await user.clear(amount())
    await user.type(amount(), '1e9')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(amount()).toHaveAccessibleDescription(/^Amount too large — the limit is /)
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('saves a valid change and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={KOPI} onClose={onClose} />)
    await user.clear(item())
    await user.type(item(), 'Kopi C')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useExpenseStore.getState().expenses.find((e) => e.id === 'e-1')?.itemName).toBe('Kopi C')
  })
})

describe('EditExpenseSheet delete confirmation', () => {
  it('asks by name, focuses Cancel, and Cancel returns focus to "Delete expense"', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))

    const group = screen.getByRole('group', { name: 'Delete "Kopi O"?' })
    expect(group).toHaveAccessibleDescription('This cannot be undone.')
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.queryByRole('group', { name: /^Delete/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete expense' })).toHaveFocus()
  })

  it('deletes once and closes on confirm', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={KOPI} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm.className).toMatch(/bg-negative/)
    await user.dblClick(confirm)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useExpenseStore.getState().expenses.map((e) => e.id)).toEqual(['e-2'])
  })

  it('starts without the question when the sheet opens again, for this or another expense', async () => {
    const user = userEvent.setup()
    const view = render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    expect(screen.getByRole('group', { name: 'Delete "Kopi O"?' })).toBeInTheDocument()

    view.rerender(<EditExpenseSheet expense={GRAB} onClose={() => {}} />)
    expect(screen.queryByRole('group', { name: /^Delete/ })).not.toBeInTheDocument()
    expect(item()).toHaveValue('Grab to camp')

    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    view.rerender(<EditExpenseSheet expense={null} onClose={() => {}} />)
    view.rerender(<EditExpenseSheet expense={GRAB} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Delete expense' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Delete/ })).not.toBeInTheDocument()
  })
})

describe('EditExpenseSheet chips and presets', () => {
  it('exposes the chosen category and day as pressed', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    const food = screen.getByRole('button', { name: 'Food & Dining' })
    expect(food).toHaveAttribute('aria-pressed', 'true')
    const transport = screen.getByRole('button', { name: 'Transportation' })
    expect(transport).toHaveAttribute('aria-pressed', 'false')
    await user.click(transport)
    expect(transport).toHaveAttribute('aria-pressed', 'true')
    expect(food).toHaveAttribute('aria-pressed', 'false')

    const date = screen.getByRole('group', { name: 'Date' })
    for (const name of ['Today', 'Yesterday', '2d ago', '3d ago']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed')
    }
    expect(date).toContainElement(screen.getByRole('button', { name: 'Today' }))
  })

  // An entry from three days ago shows as "3d ago" pressed, and "Pick date" reads as such. The
  // calendar still opens on the entry's day, marked as chosen: the arrows step from there.
  it('opens the calendar on the entry’s day when a preset shows it', async () => {
    const user = userEvent.setup()
    const day = addDays(todayKey(), -3)
    render(<EditExpenseSheet expense={{ ...KOPI, date: `${day}T12:00:00` }} onClose={() => {}} />)
    const date = screen.getByRole('group', { name: 'Date' })
    expect(within(date).getByRole('button', { name: '3d ago' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(date).getByRole('button', { name: 'Pick date' }))
    expect(document.activeElement).toHaveAttribute('data-day', day)
    const chosen = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-selected') === 'true')
    expect(
      chosen.map((cell) => cell.querySelector('[data-day]')?.getAttribute('data-day')),
    ).toEqual([day])
  })
})

// Escape is the reflex for backing out of the delete question. It takes back the question
// only: the sheet stays open with the changes made in it, and focus goes back to the trigger.
describe('EditExpenseSheet Escape in the delete question', () => {
  /** Focus is handed back in a task after the one that closed a layer. */
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('takes back the question, keeps the sheet and its edits; a held key closes nothing more', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={KOPI} onClose={onClose} />)
    await user.clear(amount())
    await user.type(amount(), '13.40')
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    const question = screen.getByRole('group', { name: 'Delete "Kopi O"?' })
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /^Delete/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete expense' })).toHaveFocus()
    // The repeats of a held Escape land on the trigger: the sheet takes one Escape per press.
    for (let i = 0; i < 3; i++)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Delete expense' }), {
        key: 'Escape',
        repeat: true,
      })
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(amount()).toHaveValue(13.4)
    expect(useExpenseStore.getState().expenses.map((e) => e.id)).toEqual(['e-1', 'e-2'])

    // A new press of Escape closes the sheet, as ever.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
