import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { DatePicker } from './DatePicker'

// Day keys and names in these tests are written out by hand; the picker must agree with them in
// every time zone the suite runs under (Asia/Singapore, Pacific/Honolulu, Pacific/Kiritimati).

/** Focus is handed back in a task after the one that closed the calendar. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const onChange = vi.fn<(value: string) => void>()

function Picker({
  initial = '',
  min,
  max,
  label,
  variant = 'pill',
  active,
}: {
  initial?: string
  min?: string
  max?: string
  label?: string
  variant?: 'pill' | 'input'
  active?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <button type="button">Before</button>
      <DatePicker
        value={value}
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        min={min}
        max={max}
        label={label}
        variant={variant}
        active={active}
      />
    </>
  )
}

function trigger() {
  return screen.getByRole('button', { expanded: false })
}

/** Open from the keyboard: focus the trigger, activate it. */
function openCalendar() {
  const button = trigger()
  act(() => {
    button.focus()
  })
  fireEvent.click(button)
  return button
}

function focusedDay(): string | null {
  return document.activeElement?.getAttribute('data-day') ?? null
}

function key(name: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement
  if (!target) throw new Error('nothing focused')
  fireEvent.keyDown(target, { key: name, ...init })
}

beforeEach(() => {
  onChange.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  // Sunday 18 October 2026, 10:00 local time, in whichever zone the suite runs.
  vi.setSystemTime(new Date(2026, 9, 18, 10, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('DatePicker opening', () => {
  it('moves focus into the grid, onto the selected day', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    expect(screen.getByRole('dialog', { name: 'Choose date' })).toBeInTheDocument()
    expect(focusedDay()).toBe('2026-10-03')
    expect(document.activeElement).toHaveAccessibleName('Saturday, October 3, 2026')
  })

  it('without a value, starts on today, marked as the current date', () => {
    render(<Picker />)
    openCalendar()
    expect(focusedDay()).toBe('2026-10-18')
    expect(document.activeElement).toHaveAttribute('aria-current', 'date')
  })

  it('starts on the nearest enabled day when neither the value nor today can be picked', () => {
    render(<Picker max="2026-09-30" />)
    openCalendar()
    expect(focusedDay()).toBe('2026-09-30')
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument()
  })

  it('makes exactly one day tabbable', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    const grid = screen.getByRole('grid')
    const tabbable = within(grid)
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0)
    expect(tabbable.map((b) => b.getAttribute('data-day'))).toEqual(['2026-10-03'])
  })
})

describe('DatePicker keys (APG grid)', () => {
  it.each([
    ['2026-10-15', 'ArrowRight', false, '2026-10-16'],
    ['2026-10-15', 'ArrowLeft', false, '2026-10-14'],
    ['2026-10-15', 'ArrowDown', false, '2026-10-22'],
    ['2026-10-15', 'ArrowUp', false, '2026-10-08'],
    ['2026-10-15', 'Home', false, '2026-10-11'],
    ['2026-10-15', 'End', false, '2026-10-17'],
    ['2026-01-31', 'PageDown', false, '2026-02-28'],
    ['2028-01-31', 'PageDown', false, '2028-02-29'],
    ['2026-03-31', 'PageUp', false, '2026-02-28'],
    ['2026-12-31', 'ArrowRight', false, '2027-01-01'],
    ['2026-01-01', 'ArrowLeft', false, '2025-12-31'],
    ['2026-12-28', 'ArrowDown', false, '2027-01-04'],
    ['2026-01-03', 'ArrowUp', false, '2025-12-27'],
    ['2028-02-29', 'PageDown', true, '2029-02-28'],
    ['2028-02-29', 'PageUp', true, '2027-02-28'],
    // Daylight-saving changes (Europe 29 Mar / 25 Oct 2026, US 1 Nov 2026): one day per step.
    ['2026-03-29', 'ArrowRight', false, '2026-03-30'],
    ['2026-03-29', 'ArrowLeft', false, '2026-03-28'],
    ['2026-10-25', 'ArrowLeft', false, '2026-10-24'],
    ['2026-11-01', 'ArrowLeft', false, '2026-10-31'],
    ['2026-11-01', 'ArrowRight', false, '2026-11-02'],
  ])('from %s, %s (shift %s) moves to %s', (from, name, shiftKey, to) => {
    render(<Picker initial={from} />)
    openCalendar()
    expect(focusedDay()).toBe(from)
    key(name, { shiftKey })
    expect(focusedDay()).toBe(to)
    const [y, m] = to.split('-').map(Number)
    const month = new Date(y ?? 0, (m ?? 1) - 1, 15).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    })
    expect(screen.getByRole('grid')).toHaveAccessibleName(month)
  })

  it('leaves keys with Alt, Ctrl or Meta to the browser and the app (Alt+Left goes back)', () => {
    render(<Picker initial="2026-10-15" />)
    openCalendar()
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      const day = document.activeElement
      if (!day) throw new Error('nothing focused')
      expect(fireEvent.keyDown(day, { key: 'ArrowLeft', [modifier]: true })).toBe(true)
      expect(fireEvent.keyDown(day, { key: 'Enter', [modifier]: true })).toBe(true)
      expect(focusedDay()).toBe('2026-10-15')
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('walks a whole month with the arrows and never loses focus', () => {
    render(<Picker initial="2026-02-01" />)
    openCalendar()
    for (let i = 0; i < 28; i++) key('ArrowRight')
    expect(focusedDay()).toBe('2026-03-01')
  })

  it('clamps at max (today) and at min', () => {
    render(<Picker initial="2026-10-16" min="2026-10-01" max="2026-10-18" />)
    openCalendar()
    key('ArrowDown')
    expect(focusedDay()).toBe('2026-10-18')
    key('ArrowRight')
    key('PageDown')
    key('PageDown', { shiftKey: true })
    expect(focusedDay()).toBe('2026-10-18')
    key('PageUp')
    expect(focusedDay()).toBe('2026-10-01')
    key('ArrowLeft')
    key('ArrowUp')
    expect(focusedDay()).toBe('2026-10-01')
  })

  it('disables the days outside the range, and the month buttons past it', () => {
    render(<Picker initial="2026-10-16" min="2026-10-01" max="2026-10-18" />)
    openCalendar()
    expect(screen.getByRole('button', { name: 'Monday, October 19, 2026' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Thursday, October 1, 2026' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next month, November 2026' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous month, September 2026' })).toBeDisabled()
  })

  it('Enter picks the focused day, closes and returns focus to the trigger', async () => {
    render(<Picker initial="2026-10-03" />)
    const button = openCalendar()
    key('ArrowRight')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('2026-10-04')
    expect(screen.queryByRole('dialog')).toBeNull()
    await settle()
    expect(button).toHaveFocus()
  })

  it('Space picks the focused day; a held key picks it once', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    key('ArrowLeft')
    key(' ')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-10-02')

    openCalendar()
    key('Enter', { repeat: true })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('Escape closes without a change and returns focus to the trigger', async () => {
    render(<Picker initial="2026-10-03" />)
    const button = openCalendar()
    key('ArrowRight')
    key('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await settle()
    expect(button).toHaveFocus()
  })

  it('marks the value with aria-selected on its gridcell', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    const selected = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(within(selected[0] ?? document.body).getByRole('button')).toHaveAccessibleName(
      'Saturday, October 3, 2026',
    )
  })

  // The day comes from a preset beside the pill ("3d ago" pressed): the pill reads "Pick date",
  // but the calendar starts on, and marks, the form's day, as the preset does. Two steps back
  // from there is five days ago, never two days from today.
  it('an inactive pill reads its placeholder, yet opens on its day and marks it', () => {
    render(<Picker initial="2026-10-15" active={false} />)
    expect(trigger()).toHaveAccessibleName('Pick date')
    expect(trigger()).toHaveTextContent('Pick date')
    openCalendar()
    expect(focusedDay()).toBe('2026-10-15')
    const selected = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-selected') === 'true')
    expect(
      selected.map((cell) => cell.querySelector('[data-day]')?.getAttribute('data-day')),
    ).toEqual(['2026-10-15'])
    key('ArrowLeft')
    key('ArrowLeft')
    key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('2026-10-13')
  })
})

describe('DatePicker month buttons, footer and Tab', () => {
  it('names the months it moves to, and keeps focus on the button', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    const next = screen.getByRole('button', { name: 'Next month, November 2026' })
    act(() => {
      next.focus()
    })
    fireEvent.click(next)
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next month, December 2026' })).toHaveFocus()
    const tabbable = within(screen.getByRole('grid'))
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0)
    expect(tabbable.map((b) => b.getAttribute('data-day'))).toEqual(['2026-11-03'])
  })

  it('moves focus into the grid when a month button turns disabled under it', () => {
    render(<Picker initial="2026-09-10" max="2026-10-18" />)
    openCalendar()
    const next = screen.getByRole('button', { name: 'Next month, October 2026' })
    act(() => {
      next.focus()
    })
    fireEvent.click(next)
    expect(focusedDay()).toBe('2026-10-10')
  })

  it('Today picks today; Clear empties the value', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(onChange).toHaveBeenLastCalledWith('2026-10-18')
    openCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('cycles Previous, Next, the day, Clear, Today with Tab', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    const today = screen.getByRole('button', { name: 'Today' })
    act(() => {
      today.focus()
    })
    key('Tab')
    expect(screen.getByRole('button', { name: 'Previous month, September 2026' })).toHaveFocus()
    key('Tab', { shiftKey: true })
    expect(today).toHaveFocus()
  })

  it('closes on a press outside it', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Before' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays beside its trigger while the trigger moves (a sheet still sliding in, a scroll)', async () => {
    render(<Picker initial="2026-10-03" />)
    const button = openCalendar()
    const calendar = screen.getByRole('dialog')
    const nextFrames = () =>
      act(async () => {
        for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
      })
    // jsdom does not lay out: the trigger reports where it is now.
    let y = 600
    button.getBoundingClientRect = () => DOMRect.fromRect({ x: 20, y, width: 90, height: 36 })
    await nextFrames()
    expect(calendar.style.top).toBe('642px')
    y = 300
    await nextFrames()
    expect(calendar.style.top).toBe('342px')

    // The calendar scrolling inside itself (pinned on a short screen) moves nothing.
    calendar.style.top = '123px'
    fireEvent.scroll(calendar)
    await nextFrames()
    expect(calendar.style.top).toBe('123px')
  })
})

describe('DatePicker announcements', () => {
  it('carries live regions of its own: content outside the open calendar is hidden from screen readers', () => {
    render(<Picker initial="2026-10-03" />)
    openCalendar()
    const calendar = screen.getByRole('dialog')
    expect(within(calendar).getByRole('status')).toBeEmptyDOMElement()
    expect(within(calendar).getByRole('alert')).toBeEmptyDOMElement()
  })
})

describe('DatePicker names', () => {
  it('names the trigger and the dialog after its label', () => {
    render(<Picker initial="2026-10-03" label="From" variant="input" />)
    expect(trigger()).toHaveAccessibleName('From, Change date, selected Oct 3, 2026')
    openCalendar()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Choose From date')
  })

  it('names an empty trigger by its placeholder, and the grid by its month', () => {
    render(<Picker />)
    expect(trigger()).toHaveAccessibleName('Pick date')
    openCalendar()
    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((h) => h.getAttribute('abbr'))).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ])
  })

  it('shows the year on the pill only for another year', () => {
    const view = render(<Picker initial="2026-10-03" />)
    expect(trigger()).toHaveTextContent('Oct 3')
    expect(trigger()).not.toHaveTextContent('2026')
    view.unmount()
    render(<Picker initial="2025-12-31" />)
    expect(trigger()).toHaveTextContent('Dec 31, 2025')
  })
})

describe('DatePicker in the local time zone', () => {
  it('opens on the local today, whatever the zone (UTC−10 to UTC+14)', () => {
    // 22:30 UTC: still the 18th in Honolulu, already the 19th in Singapore and Kiritimati.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 22, 30)))
    const now = new Date()
    const local = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'))
      .join('-')
    render(<Picker />)
    openCalendar()
    expect(focusedDay()).toBe(local)
    expect(document.activeElement).toHaveAttribute('aria-current', 'date')
  })
})
