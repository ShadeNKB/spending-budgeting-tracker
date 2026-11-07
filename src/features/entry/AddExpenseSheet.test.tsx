import { Suspense, lazy, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddExpenseSheet } from './AddExpenseSheet'
import { undoOutcomeMessage, useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { addDays, shortDate, shortDateYear, todayKey } from '../../lib/dates'

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room: every boot after it is quick.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

const WHAT = /coffee, grab, spotify/i

// jsdom does not lay out, so it has no scrollIntoView; record the calls instead.
const scrollIntoView = vi.fn()
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
  })
})
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  scrollIntoView.mockClear()
})

describe('AddExpenseSheet form refill', () => {
  it('mounted already open, starts from the prefill', () => {
    render(
      <AddExpenseSheet open onClose={() => {}} prefill={{ itemName: 'Kopi O', amount: 1.8 }} />,
    )
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Kopi O')
    expect(screen.getByPlaceholderText('0.00')).toHaveValue(1.8)
  })

  it('refills from the prefill on every open, and keeps typing while open', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      const [prefill, setPrefill] = useState('Grab to camp')
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <button type="button" onClick={() => setPrefill('Changed prefill')}>
            change prefill
          </button>
          <AddExpenseSheet
            open={open}
            onClose={() => setOpen(false)}
            prefill={{ itemName: prefill }}
          />
        </>
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    const what = screen.getByPlaceholderText(WHAT)
    expect(what).toHaveValue('Grab to camp')

    await user.clear(what)
    await user.type(what, 'Bus ride')
    // A new prefill while open never overwrites what was typed.
    fireEvent.click(screen.getByRole('button', { name: 'change prefill' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Bus ride')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Changed prefill')
    // Real typing through user-event; it took 8 s once on a machine busy with other suites.
  }, 15_000)

  // The real first-tap path: the sheet's chunk loads, then the sheet mounts already open. That
  // render is not a click, so React runs its effects a moment after the form is on screen. A
  // refill done in an effect would wipe text typed in that moment (seen in e2e under load).
  it('keeps text typed the moment the lazily loaded sheet appears', async () => {
    const previous: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      let resolveChunk: (mod: { default: typeof AddExpenseSheet }) => void = () => undefined
      const chunk = new Promise<{ default: typeof AddExpenseSheet }>((resolve) => {
        resolveChunk = resolve
      })
      const LazySheet = lazy(() => chunk)

      // Type into the What field in the same task that puts it on screen, before React's
      // scheduled effects can run.
      const typed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          const what = document.querySelector<HTMLInputElement>('input[placeholder^="e.g. Coffee"]')
          if (!what) return
          observer.disconnect()
          fireEvent.change(what, { target: { value: 'Teh tarik' } })
          resolve()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })

      root.render(
        <Suspense fallback={null}>
          <LazySheet open onClose={() => {}} />
        </Suspense>,
      )
      resolveChunk({ default: AddExpenseSheet })
      await typed
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(document.querySelector('input[placeholder^="e.g. Coffee"]')).toHaveValue('Teh tarik')
    } finally {
      root.unmount()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    }
  })
})

// The + button, Ctrl+N and the home-screen "Add expense" shortcut all open this sheet to log
// something right away, one-handed: the What field takes focus, not Close.
describe('AddExpenseSheet focus', () => {
  it('opens with focus on What', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <AddExpenseSheet open={open} onClose={() => setOpen(false)} />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveFocus()
  })
})

// The data engine did not load: the + still opens the sheet, which says so before anything is
// typed (on Save it was too late: the Reload it asks for throws the form away).
describe('AddExpenseSheet when SpendTrack could not start', () => {
  it('says nothing can be added, with Reload, and offers no form to fill in', () => {
    const before = useExpenseStore.getState().bootError
    useExpenseStore.setState({ bootError: 'engine-load' })
    try {
      render(<AddExpenseSheet open onClose={() => {}} />)
      const dialog = screen.getByRole('dialog', { name: 'Add expense' })
      expect(within(dialog).getByText("SpendTrack couldn't start")).toBeInTheDocument()
      expect(within(dialog).getByText(/Nothing can be added until it does/)).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Reload' })).toBeInTheDocument()
      expect(within(dialog).queryByPlaceholderText(WHAT)).toBeNull()
      expect(within(dialog).queryByRole('button', { name: /^Add/ })).toBeNull()
    } finally {
      useExpenseStore.setState({ bootError: before })
    }
  })
})

describe('AddExpenseSheet "More..." category chip', () => {
  it('shows the chosen extra category at chip size, with the native select on top', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
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

describe('AddExpenseSheet invalid submit', () => {
  beforeEach(() => {
    useUIStore.setState({ toasts: [] })
  })

  it('focuses What, marked invalid and described by its error', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    await user.type(screen.getByPlaceholderText('0.00'), '4.50')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const what = screen.getByPlaceholderText(WHAT)
    expect(what).toHaveFocus()
    expect(what).toHaveAttribute('aria-invalid', 'true')
    expect(what).toHaveAccessibleDescription('Required')
    expect(onClose).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('focuses Amount when What is filled in, and keeps what was typed', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const what = screen.getByPlaceholderText(WHAT)
    await user.type(what, 'Coffee')
    await user.keyboard('{Enter}')

    const amount = screen.getByPlaceholderText('0.00')
    expect(amount).toHaveFocus()
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(amount).toHaveAccessibleDescription('Enter a valid amount')
    expect(what).not.toHaveAttribute('aria-invalid')
    expect(what).toHaveValue('Coffee')
  })
})

describe('AddExpenseSheet selected states', () => {
  it('exposes the chosen category as pressed, and toggles it off again', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const chip = screen.getByRole('button', { name: 'Gaming' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
  })

  it('groups the day presets under "Date", with today pressed', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const date = screen.getByRole('group', { name: 'Date' })
    const today = within(date).getByRole('button', { name: 'Today' })
    const yesterday = within(date).getByRole('button', { name: 'Yesterday' })
    expect(today).toHaveAttribute('aria-pressed', 'true')
    expect(yesterday).toHaveAttribute('aria-pressed', 'false')
    await user.click(yesterday)
    expect(yesterday).toHaveAttribute('aria-pressed', 'true')
    expect(today).toHaveAttribute('aria-pressed', 'false')
    for (const name of ['2d ago', '3d ago']) {
      expect(within(date).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
  })

  // "2d ago" pressed: "Pick date" opens the calendar on that day, marked as chosen, so the
  // arrows step from the entry's own day (← ← Enter is four days ago, never two).
  it('opens the calendar on the day a preset chose, marked as chosen', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const date = screen.getByRole('group', { name: 'Date' })
    await user.click(within(date).getByRole('button', { name: '2d ago' }))
    await user.click(within(date).getByRole('button', { name: 'Pick date' }))
    const day = addDays(todayKey(), -2)
    expect(document.activeElement).toHaveAttribute('data-day', day)
    const chosen = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-selected') === 'true')
    expect(
      chosen.map((cell) => cell.querySelector('[data-day]')?.getAttribute('data-day')),
    ).toEqual([day])
    await user.keyboard('{ArrowLeft}{ArrowLeft}{Enter}')
    const picked = shortDateYear(addDays(todayKey(), -4))
    expect(
      within(date).getByRole('button', { name: `Change date, selected ${picked}` }),
    ).toBeInTheDocument()
  })

  // The sheet scrolls when it is taller than the screen (landscape, a narrow phone, many
  // categories). WebKit reveals only the caret line of a text field that Tab lands on: focus
  // brings the whole field, ring included, into view.
  it('brings a text field that takes focus fully into view inside the sheet', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    expect(screen.getByPlaceholderText(WHAT)).toHaveFocus()
    scrollIntoView.mockClear()
    await user.tab()
    const amount = screen.getByPlaceholderText('0.00')
    expect(amount).toHaveFocus()
    expect(scrollIntoView.mock.contexts).toContain(amount)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  // The presets wrap on a narrow phone, as in the Edit sheet: every one stays in sight. A row
  // that scrolled sideways (with no scrollbar) cut "Pick date" in half at 375 px and hid it at
  // 320 px. Tab onto a preset still brings it, ring included, into view inside the sheet.
  it('wraps the date presets instead of scrolling them sideways', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const date = screen.getByRole('group', { name: 'Date' })
    expect(date).toHaveClass('flex', 'flex-wrap', 'gap-2')
    expect(date).not.toHaveClass('overflow-x-auto')
    within(date).getByRole('button', { name: '3d ago' }).focus()
    scrollIntoView.mockClear()
    await user.tab()
    const pickDate = within(date).getByRole('button', { name: 'Pick date' })
    expect(pickDate).toHaveFocus()
    expect(scrollIntoView.mock.contexts[0]).toBe(pickDate)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })
})

// P2-2: the sheet stores the picked day as the entry's day. P2-13: what the store refuses is said,
// and the sheet stays open with everything typed. Run in Asia/Singapore, Pacific/Honolulu and
// Pacific/Kiritimati (PowerShell $env:TZ).
describe('AddExpenseSheet saving', () => {
  beforeEach(async () => {
    // P2-14: an empty device, booted for real (whatever the last test left pending first).
    await useExpenseStore.getState().hydrate()
    localStorage.clear()
    await useExpenseStore.getState().hydrate()
    useUIStore.setState({ toasts: [], currency: 'SGD' })
  })

  async function fill(user: ReturnType<typeof userEvent.setup>, what: string, amount: string) {
    await user.type(screen.getByPlaceholderText(WHAT), what)
    await user.type(screen.getByPlaceholderText('0.00'), amount)
  }

  it("stores today's entry on today's day, at local noon with no zone", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    await fill(user, 'Kopi O', '1.80')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const today = todayKey()
    expect(useExpenseStore.getState().expenses).toMatchObject([
      { itemName: 'Kopi O', amount: 1.8, day: today, date: `${today}T12:00:00` },
    ])
    expect(useExpenseStore.getState().expenses[0]?.notes).toBeUndefined()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stores a back-dated entry on the picked day, and says which', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Yesterday' }))
    await fill(user, 'Teh', '1.20')
    const yesterday = addDays(todayKey(), -1)
    // On 1 Jan, yesterday is in another year and says so.
    const label =
      yesterday.slice(0, 4) === todayKey().slice(0, 4)
        ? shortDate(yesterday)
        : shortDateYear(yesterday)
    await user.click(screen.getByRole('button', { name: `Add for ${label}` }))
    expect(useExpenseStore.getState().expenses[0]).toMatchObject({
      day: yesterday,
      date: `${yesterday}T12:00:00`,
    })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(`Added "Teh" · S$1.20 · ${label}`)
  })

  it('shows why the store refused it, and stays open with what was typed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    await fill(user, 'Kopi O', '1.80')
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes (optional)' }), {
      target: { value: 'n'.repeat(501) },
    })
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'Notes are at most 500 characters.',
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Kopi O')
  })

  // PR-4: Recovery's Fix adds an unreadable row again from what still reads.
  it('a prefill can carry notes; onAdded gets the new entry, and the note follows the confirmation', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    const onClose = vi.fn()
    const today = todayKey()
    render(
      <AddExpenseSheet
        open
        onClose={onClose}
        prefill={{ itemName: 'Chicken rice', amount: 5.5, date: today, notes: 'with extra egg' }}
        onAdded={onAdded}
        addedNote="The unreadable original stays in your raw data download."
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Notes (optional)' })).toHaveValue('with extra egg')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const added = useExpenseStore.getState().expenses[0]
    expect(added).toMatchObject({ itemName: 'Chicken rice', amount: 5.5, notes: 'with extra egg' })
    expect(onAdded).toHaveBeenCalledOnce()
    expect(onAdded).toHaveBeenCalledWith(added)
    expect(onClose).toHaveBeenCalledOnce()
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
      'Added "Chicken rice" · S$5.50. The unreadable original stays in your raw data download.',
    )
  })

  it('onAdded is not called when the store refuses the entry', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    render(
      <AddExpenseSheet
        open
        onClose={() => {}}
        prefill={{ itemName: 'Kopi', amount: 1.8, notes: 'n'.repeat(501) }}
        onAdded={onAdded}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('Undo takes it back out, and says what it had to leave', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    await fill(user, 'Kopi O', '1.80')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const added = useExpenseStore.getState().expenses[0]
    if (!added) throw new Error('nothing added')
    const toast = useUIStore.getState().toasts.at(-1)
    act(() => {
      useExpenseStore.getState().updateExpense(added.id, { notes: 'with kaya toast' })
    })
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses).toHaveLength(1)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'warning',
      message: undoOutcomeMessage({ applied: 0, skipped: 1 }),
    })
  })
})
