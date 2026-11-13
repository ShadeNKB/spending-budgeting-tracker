import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MonthClosed, RECAP_SEEN_KEY } from './MonthClosed'
import { MonthReview } from './MonthReview'
import { computeMonthAnalytics } from '../../lib/analytics'
import { getLedgerIndex } from '../../lib/ledgerIndex'
import type { Expense } from '../../types'

let seq = 0
// Invented data, stored as the app stores it: local noon, no `Z`.
const at = (day: string, amount: number, itemName: string, category = 'Food'): Expense => {
  seq += 1
  return {
    id: `r${String(seq)}`,
    itemName,
    amount,
    category,
    date: `${day}T12:00:00`,
    createdAt: `${day}T12:00:00`,
  }
}

const ROWS = [
  at('2026-09-10', 1000, 'september rent', 'Housing'),
  at('2026-10-03', 60, 'groceries'),
  at('2026-10-03', 40, 'taxi', 'Transport'),
  at('2026-10-15', 700, 'flight to Tokyo', 'Travel'),
  at('2026-10-20', 120, 'dinner'),
]
/** October, closed, as seen on 2 November. */
const october = (budgets: Record<string, number> = {}, monthCap: number | null = null) =>
  computeMonthAnalytics(getLedgerIndex(ROWS), budgets, '2026-11-02', 1, monthCap)

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('MonthClosed: how last month ended, said once', () => {
  it('says the total and how it compares with the month before', () => {
    render(<MonthClosed month={october()} onSee={vi.fn()} />)
    const card = screen.getByRole('region', { name: 'October closed' })
    expect(card).toHaveTextContent(/October closed at .*920\.00/)
    expect(card).toHaveTextContent('8.0% less than September.')
  })

  it('adds how the month stood against its budget: under, or over', () => {
    const { unmount } = render(<MonthClosed month={october({}, 1000)} onSee={vi.fn()} />)
    expect(screen.getByRole('region')).toHaveTextContent(
      /8\.0% less than September · .*80\.00 under budget\./,
    )
    unmount()
    render(<MonthClosed month={october({}, 900)} onSee={vi.fn()} />)
    expect(screen.getByRole('region')).toHaveTextContent(/.*20\.00 over budget\./)
  })

  it('category caps are named as such: they measure their own categories, not the month', () => {
    const { unmount } = render(<MonthClosed month={october({ Food: 300 })} onSee={vi.fn()} />)
    // Food spent 180 of its 300 cap; the month spent 920
    expect(screen.getByRole('region')).toHaveTextContent(/.*120\.00 under its category caps\./)
    unmount()
    render(<MonthClosed month={october({ Food: 100 })} onSee={vi.fn()} />)
    expect(screen.getByRole('region')).toHaveTextContent(/.*80\.00 over its category caps\./)
  })

  it('with nothing to compare with, says how many entries made it', () => {
    const alone = computeMonthAnalytics(
      getLedgerIndex([at('2026-10-03', 60, 'groceries')]),
      {},
      '2026-11-02',
      1,
    )
    render(<MonthClosed month={alone} onSee={vi.fn()} />)
    expect(screen.getByRole('region')).toHaveTextContent('1 entry.')
  })

  it('See turns to the month and the card is not shown again, on this device', () => {
    const onSee = vi.fn()
    const { unmount } = render(<MonthClosed month={october()} onSee={onSee} />)
    fireEvent.click(screen.getByRole('button', { name: 'See October' }))
    expect(onSee).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region')).toBeNull()
    expect(localStorage.getItem(RECAP_SEEN_KEY)).toBe('2026-10')
    unmount()
    render(<MonthClosed month={october()} onSee={onSee} />)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('the × puts it away without turning the page', () => {
    const onSee = vi.fn()
    render(<MonthClosed month={october()} onSee={onSee} />)
    fireEvent.click(screen.getByRole('button', { name: "Dismiss October's summary" }))
    expect(onSee).not.toHaveBeenCalled()
    expect(screen.queryByRole('region')).toBeNull()
    expect(localStorage.getItem(RECAP_SEEN_KEY)).toBe('2026-10')
  })

  it('a month seen does not hide the next one', () => {
    localStorage.setItem(RECAP_SEEN_KEY, '2026-09')
    render(<MonthClosed month={october()} onSee={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'October closed' })).toBeInTheDocument()
  })

  it('an empty month says nothing', () => {
    const empty = computeMonthAnalytics(getLedgerIndex([]), {}, '2026-11-02', 1)
    render(<MonthClosed month={empty} onSee={vi.fn()} />)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('still shows when storage refuses: it is only not remembered', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<MonthClosed month={october()} onSee={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'October closed' })).toBeInTheDocument()
    get.mockRestore()
  })

  it('starts its sentence with a capital, whatever the first fact is', () => {
    const level = computeMonthAnalytics(
      getLedgerIndex([at('2026-09-10', 60, 'a'), at('2026-10-03', 60, 'b')]),
      {},
      '2026-11-02',
      1,
    )
    render(<MonthClosed month={level} onSee={vi.fn()} />)
    expect(screen.getByRole('region')).toHaveTextContent('The same as September.')
  })

  it('moves focus to the screen as it goes, never to <body>', () => {
    render(
      <main id="main" tabIndex={-1}>
        <MonthClosed month={october()} onSee={vi.fn()} />
      </main>,
    )
    const dismiss = screen.getByRole('button', { name: "Dismiss October's summary" })
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(screen.getByRole('main')).toHaveFocus()
  })

  // Last in this group: the month it puts away stays put away for the rest of this module's life
  // (that is the fix), so no test after it may expect October's card.
  it('a write storage refuses still puts the card away and turns the page (review finding 2)', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const onSee = vi.fn()
    const { unmount } = render(<MonthClosed month={october()} onSee={onSee} />)
    fireEvent.click(screen.getByRole('button', { name: 'See October' }))
    expect(onSee).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region')).toBeNull()
    expect(localStorage.getItem(RECAP_SEEN_KEY)).toBeNull()
    // paged back to this month: not said again, though nothing could be stored
    unmount()
    render(<MonthClosed month={october()} onSee={onSee} />)
    expect(screen.queryByRole('region')).toBeNull()
    set.mockRestore()
  })
})

describe('MonthReview: a finished month in three facts', () => {
  const renderReview = (rows: Expense[] = ROWS) =>
    render(
      <MemoryRouter>
        <MonthReview month={computeMonthAnalytics(getLedgerIndex(rows), {}, '2026-11-02', 1)} />
      </MemoryRouter>,
    )

  it('names the biggest expense, the busiest day and the count, each with its figure', () => {
    renderReview()
    expect(screen.getByRole('heading', { name: 'Month in review' })).toBeInTheDocument()
    const biggest = screen.getByRole('link', { name: 'flight to Tokyo' })
    expect(biggest).toHaveAttribute('href', expect.stringContaining('/ledger?date=2026-10-15'))
    expect(biggest).toHaveAttribute('href', expect.stringContaining('edit='))
    expect(biggest.parentElement).toHaveTextContent(/700\.00 · Oct 15/)

    // Oct 15 carries the flight alone; Oct 3 two entries of 100 together
    expect(screen.getByText('Biggest day')).toBeInTheDocument()
    const busiest = screen.getByRole('link', { name: 'Oct 15' })
    expect(busiest).toHaveAttribute('href', '/ledger?date=2026-10-15')
    expect(busiest.parentElement).toHaveTextContent(/700\.00/)

    // four entries, on the 3rd, the 15th and the 20th
    const count = screen.getByText('Entries').parentElement
    expect(count).toHaveTextContent('4on 3 of 31 days')
  })

  it('shows nothing for a month without entries', () => {
    const { container } = renderReview([at('2026-09-10', 5, 'kopi')])
    expect(container).toBeEmptyDOMElement()
  })
})
