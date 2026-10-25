import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Heatmap } from './Heatmap'
import { useUIStore } from '../../stores/useUIStore'
import { useToday } from '../../hooks/useToday'
import type { HeatmapData } from '../../lib/analytics'
import { addDays, enumerateDays, sundayOnOrBefore, toDayKey, type DayKey } from '../../lib/dates'

/** The heatmap window analytics builds: 13 full weeks plus the week of `end`. */
function heatmap(end: DayKey, spend: Readonly<Record<DayKey, number>> = {}): HeatmapData {
  const start = sundayOnOrBefore(addDays(end, -13 * 7))
  return {
    start,
    end,
    days: enumerateDays({ start, end }).map((date) => ({ date, total: spend[date] ?? 0 })),
  }
}

// Oct 18, 2026 is a Sunday: the window is Jul 19 – Oct 18 (92 days; the last week has one day).
const TODAY = '2026-10-18'
const SPEND = { '2026-10-17': 12, '2026-10-14': 4.5, '2026-09-22': 120, '2026-07-19': 3 }

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{pathname + search}</output>
}

function renderAt(element: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        path: '/pulse',
        element: (
          <>
            {element}
            <LocationProbe />
          </>
        ),
      },
      { path: '/ledger', element: <LocationProbe /> },
    ],
    { initialEntries: ['/pulse'] },
  )
  return render(<RouterProvider router={router} />)
}

const grid = () => screen.getByRole('grid')
/** Every element that takes a Tab stop inside the heatmap. */
const tabStops = () =>
  Array.from(grid().querySelectorAll<HTMLElement>('[tabindex]')).filter((el) => el.tabIndex >= 0)
const cellOf = (day: DayKey) => {
  const cell = grid().querySelector<HTMLElement>(`[data-day="${day}"]`)
  if (!cell) throw new Error(`no cell for ${day}`)
  return cell
}
/** The element that takes focus for a day: the button of a spending day, else the cell. */
const focusTargetOf = (day: DayKey) => within(cellOf(day)).queryByRole('button') ?? cellOf(day)
const focusedDay = () =>
  document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>('[data-day]')?.dataset.day
    : undefined

beforeEach(() => {
  useUIStore.setState({ currency: 'SGD' })
  // jsdom has no layout: moving between days scrolls the cell into view.
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Heatmap grid', () => {
  it('is a named grid of seven weekday rows with one cell per day, described by a summary', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    const g = screen.getByRole('grid', { name: 'Daily spending, Jul 19 – Oct 18, 2026' })
    expect(g).toHaveAccessibleDescription(
      '4 of 92 days with spending. Busiest: Tue, Sep 22, S$120.00.',
    )
    const rows = within(g).getAllByRole('row')
    expect(rows).toHaveLength(7)
    // Row-major: the Sunday row reads Jul 19, Jul 26 … Oct 18 (14 weeks); the other rows
    // end on Sat Oct 17 / Mon Oct 12 and pad the missing day with an empty cell.
    const sunday = rows[0]?.querySelectorAll('[data-day]') ?? []
    expect(Array.from(sunday, (c) => c.getAttribute('data-day'))).toEqual(
      Array.from({ length: 14 }, (_, w) => addDays('2026-07-19', w * 7)),
    )
    for (const row of rows) expect(within(row).getAllByRole('gridcell')).toHaveLength(14)
    expect(g.querySelectorAll('[data-day]')).toHaveLength(92)
    const saturday = Array.from(rows[6]?.querySelectorAll('[data-day]') ?? [])
    expect(saturday.at(-1)?.getAttribute('data-day')).toBe('2026-10-17')
  })

  it('names every day; spending days hold a button with the same name, empty days are not buttons', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    // The button is named by its title alone (also the hover tooltip): browsers then expose no
    // description, so nothing is read twice, and name the cell from it (jsdom's engine does
    // neither, so those two are e2e checks).
    const spend = cellOf('2026-10-17')
    expect(spend).toHaveAttribute('role', 'gridcell')
    const button = within(spend).getByRole('button', { name: 'Sat, October 17: S$12.00' })
    expect(button).not.toHaveAttribute('aria-label')
    const empty = screen.getByRole('gridcell', { name: 'Thu, October 15: No spending' })
    expect(within(empty).queryByRole('button')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /No spending/ })).toHaveLength(0)
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('takes exactly one Tab stop: today, marked as the current date', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    const stops = tabStops()
    expect(stops).toHaveLength(1)
    expect(stops[0]).toBe(focusTargetOf(TODAY))
    expect(grid().querySelectorAll('[aria-current="date"]')).toHaveLength(1)
    expect(focusTargetOf(TODAY)).toHaveAttribute('aria-current', 'date')
  })

  it('without today in range (a past month) the Tab stop is the last day', () => {
    renderAt(<Heatmap data={heatmap('2026-09-30', SPEND)} today={TODAY} />)
    expect(tabStops()).toEqual([focusTargetOf('2026-09-30')])
    expect(grid().querySelectorAll('[aria-current]')).toHaveLength(0)
  })

  it('moves by day (up/down, across weeks), by week (left/right), by four weeks (Page) and to the ends', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    const key = (k: string) => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: k })
      return focusedDay()
    }
    expect(key('ArrowUp')).toBe('2026-10-17') // Sun → the Saturday before
    expect(key('ArrowUp')).toBe('2026-10-16')
    expect(key('ArrowDown')).toBe('2026-10-17')
    expect(key('ArrowDown')).toBe('2026-10-18') // Sat → next week's Sunday
    expect(key('ArrowDown')).toBe('2026-10-18') // clamped at the last day
    expect(key('ArrowRight')).toBe('2026-10-18') // clamped
    expect(key('ArrowLeft')).toBe('2026-10-11')
    expect(key('ArrowLeft')).toBe('2026-10-04')
    expect(key('ArrowRight')).toBe('2026-10-11')
    expect(key('PageUp')).toBe('2026-09-13')
    expect(key('PageDown')).toBe('2026-10-11')
    expect(key('PageDown')).toBe('2026-10-18') // clamped
    expect(key('Home')).toBe('2026-07-19')
    expect(key('ArrowUp')).toBe('2026-07-19') // clamped at the first day
    expect(key('PageUp')).toBe('2026-07-19')
    expect(key('End')).toBe('2026-10-18')
  })

  it('keeps one Tab stop on the cell last moved to (roving tabindex)', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(focusTargetOf('2026-10-17'))
    expect(tabStops()).toEqual([focusTargetOf('2026-10-17')])
    // A click (or a screen reader's focus) on another cell moves the stop there.
    act(() => {
      focusTargetOf('2026-10-15').focus()
    })
    expect(tabStops()).toEqual([focusTargetOf('2026-10-15')])
  })

  it('arrow keys do not scroll the page; modified keys and Tab pass through', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    expect(fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowLeft' })).toBe(
      false,
    )
    expect(fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })).toBe(true)
    expect(
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'ArrowLeft',
        altKey: true,
      }),
    ).toBe(true)
    expect(focusedDay()).toBe('2026-10-11')
  })

  // A day without spending has nothing to open, and Space there must not scroll the page either.
  // A spending day's button keeps its own Enter and Space (they open the day).
  it('takes Space and Enter on a day without spending; leaves them to a spending day’s button', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    act(() => {
      focusTargetOf('2026-10-15').focus()
    })
    const target = () => document.activeElement ?? document.body
    expect(fireEvent.keyDown(target(), { key: ' ' })).toBe(false)
    expect(fireEvent.keyDown(target(), { key: 'Enter' })).toBe(false)
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/pulse$/)
    act(() => {
      focusTargetOf('2026-10-17').focus()
    })
    expect(fireEvent.keyDown(target(), { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(target(), { key: 'Enter' })).toBe(true)
  })

  it('Enter or a click on a spending day opens that day in the ledger', async () => {
    const user = userEvent.setup()
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    await user.keyboard('{ArrowUp}{Enter}')
    expect(screen.getByTestId('location')).toHaveTextContent('/ledger?date=2026-10-17')
  })

  it('a click on a spending day navigates; empty days do nothing', async () => {
    const user = userEvent.setup()
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    await user.click(cellOf('2026-10-15'))
    await user.keyboard('{Enter} ')
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/pulse$/)
    await user.click(within(cellOf('2026-09-22')).getByRole('button'))
    expect(screen.getByTestId('location')).toHaveTextContent('/ledger?date=2026-09-22')
  })

  it('summarises an empty window', () => {
    renderAt(<Heatmap data={heatmap(TODAY)} today={TODAY} />)
    expect(grid()).toHaveAccessibleDescription('No spending in these 14 weeks.')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(tabStops()).toEqual([cellOf(TODAY)])
    expect(cellOf(TODAY)).toHaveAccessibleName('Sun, October 18: No spending')
  })

  it('labels months and weekdays visually only', () => {
    renderAt(<Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />)
    for (const label of ['Mon', 'Wed', 'Fri', 'Aug', 'Sep', 'Oct']) {
      const node = screen.getByText(label, { exact: true })
      expect(node.closest('[aria-hidden="true"]')).not.toBeNull()
    }
  })

  it('shows the focused day under the grid, as a hover shows its tooltip; the range returns on leaving', () => {
    renderAt(
      <>
        <Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />
        <button type="button">Next control</button>
      </>,
    )
    const range = 'Jul 19 – Oct 18, 2026'
    // The footer repeats what the grid's name says, so it is for the eyes only.
    expect(screen.getByText(range).closest('[aria-hidden="true"]')).not.toBeNull()

    // A day without spending says so (a tap on one gets an answer, not silence).
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    expect(screen.getByText('Oct 18 · No spending')).toBeInTheDocument()
    expect(screen.queryByText(range)).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp' })
    const reading = screen.getByText('Oct 17 · S$12.00')
    expect(reading.closest('[aria-hidden="true"]')).not.toBeNull()

    act(() => {
      focusTargetOf('2026-10-15').focus()
    })
    expect(screen.getByText('Oct 15 · No spending')).toBeInTheDocument()

    act(() => {
      screen.getByRole('button', { name: 'Next control' }).focus()
    })
    expect(screen.getByText(range)).toBeInTheDocument()
    expect(screen.queryByText(/ · (S\$|No spending)/)).toBeNull()
  })
})

describe('Heatmap range changes', () => {
  function Switcher({ end }: { end: DayKey }) {
    return <Heatmap data={heatmap(end, SPEND)} today={TODAY} />
  }

  it('resets the Tab stop to the default cell of the new window', () => {
    const { rerender } = render(
      <RouterHarness>
        <Switcher end={TODAY} />
      </RouterHarness>,
    )
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'PageUp' })
    expect(tabStops()).toEqual([focusTargetOf('2026-09-20')])

    rerender(
      <RouterHarness>
        <Switcher end="2026-08-31" />
      </RouterHarness>,
    )
    expect(tabStops()).toEqual([focusTargetOf('2026-08-31')])

    rerender(
      <RouterHarness>
        <Switcher end={TODAY} />
      </RouterHarness>,
    )
    expect(tabStops()).toEqual([focusTargetOf(TODAY)])
  })

  it('keeps the stop when only the amounts change (a new expense)', () => {
    const { rerender } = render(
      <RouterHarness>
        <Heatmap data={heatmap(TODAY, SPEND)} today={TODAY} />
      </RouterHarness>,
    )
    act(() => {
      focusTargetOf(TODAY).focus()
    })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowLeft' })
    rerender(
      <RouterHarness>
        <Heatmap data={heatmap(TODAY, { ...SPEND, '2026-10-11': 7 })} today={TODAY} />
      </RouterHarness>,
    )
    // Oct 11 became a spending day: its new button carries the stop.
    expect(tabStops()).toEqual([focusTargetOf('2026-10-11')])
    expect(focusTargetOf('2026-10-11').tagName).toBe('BUTTON')
  })
})

describe('Heatmap today in the local time zone', () => {
  // 09:30 UTC on Oct 18: Singapore Oct 18 17:30, Honolulu Oct 17 23:30, Kiritimati Oct 18 23:30.
  const LOCAL_TODAY: Readonly<Record<string, DayKey>> = {
    'Asia/Singapore': '2026-10-18',
    'Pacific/Honolulu': '2026-10-17',
    'Pacific/Kiritimati': '2026-10-18',
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-18T09:30:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function PulseHeatmap() {
    const today = useToday()
    return <Heatmap data={heatmap(today, SPEND)} today={today} />
  }

  it("marks and focuses the device's local today", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const expected = LOCAL_TODAY[zone] ?? toDayKey(new Date())
    render(
      <RouterHarness>
        <PulseHeatmap />
      </RouterHarness>,
    )
    expect(tabStops()).toEqual([focusTargetOf(expected)])
    expect(focusTargetOf(expected)).toHaveAttribute('aria-current', 'date')
    expect(grid().querySelectorAll('[data-day]')).toHaveLength(
      enumerateDays({ start: sundayOnOrBefore(addDays(expected, -91)), end: expected }).length,
    )
  })
})

function RouterHarness({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}
