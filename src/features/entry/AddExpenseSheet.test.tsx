import { Suspense, lazy, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddExpenseSheet } from './AddExpenseSheet'
import { useUIStore } from '../../stores/useUIStore'
import { addDays, shortDateYear, todayKey } from '../../lib/dates'

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
