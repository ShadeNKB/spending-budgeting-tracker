import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditExpenseSheet } from './EditExpenseSheet'
import { UNDO_TOO_LATE, useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { addDays, shortDateYear, todayKey } from '../../lib/dates'
import type { Expense, ExpenseView } from '../../types'

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room: every boot after it is quick.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

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

/** P2-14: the rows as 0.9.x stored them (the public v4 keys), then a real boot of the engine. */
async function boot(rows: readonly Expense[]) {
  // Settle whatever the last test left pending, so nothing lands on top of this seed.
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  localStorage.setItem('expenses', JSON.stringify(rows))
  await useExpenseStore.getState().hydrate()
}

/** The store's view of a row, as the Ledger hands it to the sheet. */
function view(id: string): ExpenseView {
  const found = useExpenseStore.getState().expenses.find((e) => e.id === id)
  if (!found) throw new Error(`no expense ${id}`)
  return found
}

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

beforeEach(async () => {
  stubPointer('coarse')
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
  })
  await boot([KOPI, GRAB])
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

  it('offers Undo in the message, which puts the old values back', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.clear(amount())
    await user.type(amount(), '2.5')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'success', message: 'Expense updated' })
    expect(toast?.action?.label).toBe('Undo')
    expect(useExpenseStore.getState().expenses.find((e) => e.id === 'e-1')?.amount).toBe(2.5)
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses.find((e) => e.id === 'e-1')).toMatchObject({
      amount: 1.8,
      day: '2026-10-19',
    })
  })

  it('says so when its Undo comes too late, and keeps the change (F-115)', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.clear(amount())
    await user.type(amount(), '2.5')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const toast = useUIStore.getState().toasts.at(-1)
    // Its window closed meanwhile (the toast was held open, or another Undo took it).
    const undoId = toast?.undoId
    expect(undoId).toBeDefined()
    if (undoId !== undefined) useExpenseStore.getState().clearUndo(undoId)
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses.find((e) => e.id === 'e-1')?.amount).toBe(2.5)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'info',
      message: UNDO_TOO_LATE,
    })
  })

  it('offers no Undo for a save that changed nothing, so an older edit is never undone', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.clear(amount())
    await user.type(amount(), '2.5')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    cleanup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'success', message: 'Expense updated' })
    expect(toast?.action).toBeUndefined()
  })
})

describe('EditExpenseSheet delete confirmation', () => {
  it('asks by name, focuses Cancel, and Cancel returns focus to "Delete expense"', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))

    const group = screen.getByRole('group', { name: 'Delete "Kopi O"?' })
    expect(group).toHaveAccessibleDescription('You can undo it for a few seconds.')
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

  it('offers Undo in the message, which brings the entry back', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Delete expense' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'info', message: 'Deleted "Kopi O"' })
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    const back = useExpenseStore.getState().expenses
    expect(back.map((e) => e.itemName).sort()).toEqual(['Grab to camp', 'Kopi O'])
    expect(back.find((e) => e.itemName === 'Kopi O')).toMatchObject({
      amount: 1.8,
      day: '2026-10-19',
    })
    // All of it applied: nothing more to say.
    expect(useUIStore.getState().toasts.filter((t) => t.kind === 'warning')).toEqual([])
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

// P2-2: the sheet edits an entry's day, the one the Ledger lists it under, and saves a new day as
// that day. Run in Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati (PowerShell $env:TZ).
describe('EditExpenseSheet Save and Cancel', () => {
  const width = window.innerWidth
  afterEach(() => {
    window.innerWidth = width
  })

  it('on a phone they sit in the footer, in sight above the keyboard (F-071)', () => {
    window.innerWidth = 390
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    const footer = screen.getByRole('button', { name: 'Save changes' }).closest('.sheet-footer')
    expect(footer).not.toBeNull()
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Cancel' }))
    expect(footer).not.toContainElement(screen.getByRole('button', { name: 'Delete expense' }))
  })

  it('in the side panel they stay after Notes, before Delete: no footer in the corner', () => {
    window.innerWidth = 1280
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save.closest('.sheet-footer')).toBeNull()
    const after = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(after(screen.getByRole('textbox', { name: 'Notes' }), save)).toBe(true)
    expect(after(save, screen.getByRole('button', { name: 'Delete expense' }))).toBe(true)
  })
})

describe('EditExpenseSheet day contract', () => {
  /** A local wall time as 0.9.x stored it: the instant, in UTC with a Z. */
  const instant = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(y, m - 1, d, h, min).toISOString()
  const pickedDay = (day: string) =>
    within(screen.getByRole('group', { name: 'Date' })).getByRole('button', {
      name: `Change date, selected ${shortDateYear(day)}`,
    })

  it('opens on the day of the view, whatever its stored date reads as here', () => {
    const shown: ExpenseView = { ...KOPI, day: '2026-10-15', ext: {} }
    render(<EditExpenseSheet expense={shown} onClose={() => {}} />)
    expect(pickedDay('2026-10-15')).toBeInTheDocument()
  })

  it.each([
    ['a Z-noon date from the add sheet', instant(2026, 10, 15, 12), '2026-10-15'],
    ['a raw quick-add instant just after midnight', instant(2026, 10, 15, 0, 30), '2026-10-15'],
    ['a quick add at 23:59 on 31 Dec', instant(2025, 12, 31, 23, 59), '2025-12-31'],
    ['a quick add at 00:00 on 1 Jan', instant(2026, 1, 1, 0, 0), '2026-01-01'],
    ['a floating local noon', '2026-10-15T12:00:00', '2026-10-15'],
  ])(
    'keeps %s on its day, and an amount-only edit keeps the date byte for byte',
    async (_, date, day) => {
      const user = userEvent.setup()
      await boot([{ ...KOPI, date, createdAt: date }])
      expect(view('e-1')).toMatchObject({ day, date })
      render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
      expect(pickedDay(day)).toBeInTheDocument()

      await user.clear(amount())
      await user.type(amount(), '2.2')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      expect(view('e-1')).toMatchObject({ amount: 2.2, day, date })
    },
  )

  it('stores a new day as that day at local noon, with no zone', async () => {
    const user = userEvent.setup()
    const yesterday = addDays(todayKey(), -1)
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Yesterday' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1')).toMatchObject({ day: yesterday, date: `${yesterday}T12:00:00` })
  })

  it('clears the notes when they are emptied', async () => {
    const user = userEvent.setup()
    await boot([{ ...KOPI, notes: 'with kaya toast' }])
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1').notes).toBeUndefined()
  })
})

// P2-13: what the store refuses is said, and nothing typed is lost.
describe('EditExpenseSheet refused saves', () => {
  it('shows the reason and stays open with the edits', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={view('e-1')} onClose={onClose} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'n'.repeat(501) },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'Notes are at most 500 characters.',
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('n'.repeat(501))
    expect(view('e-1').notes).toBeUndefined()
  })

  it('says so when the entry was deleted while the sheet was open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditExpenseSheet expense={view('e-1')} onClose={onClose} />)
    act(() => {
      useExpenseStore.getState().deleteExpense('e-1')
    })
    await user.clear(item())
    await user.type(item(), 'Kopi C')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'That entry no longer exists.',
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})
