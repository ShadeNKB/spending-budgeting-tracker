import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DueSoon } from './DueSoon'
import { getLedgerIndex } from '../../lib/ledgerIndex'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { detectRecurring, dueSoon } from '../../utils/recurring'
import type { Expense, ExpenseView } from '../../types'

const TODAY = '2026-10-18'
let seq = 0
// Invented charges: rent on the 18th, a subscription on the 20th, a transfer on the 19th.
const monthly = (itemName: string, day: string, amount: number, category: string): Expense[] =>
  ['07', '08', '09'].map((m) => {
    seq += 1
    return {
      id: `d${String(seq)}`,
      itemName,
      amount,
      category,
      date: `2026-${m}-${day}T12:00:00`,
      createdAt: `2026-${m}-${day}T12:00:00`,
    }
  })
const ROWS = [
  ...monthly('Rent', '18', 600, 'Housing'),
  ...monthly('Spotify', '20', 11.98, 'Subscriptions'),
  ...monthly('ETF transfer', '19', 300, 'Investment'),
]
const charges = () => dueSoon(detectRecurring(getLedgerIndex(ROWS)), TODAY)

const initialExpense = useExpenseStore.getState()
const initialUI = useUIStore.getState()

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useUIStore.setState(initialUI, true)
})

/** The store's add, recorded: it answers with the entry it was given, as the engine would. */
function fakeAdd() {
  const add = vi.fn(
    (input: {
      itemName: string
      amount: number
      category?: string
      day?: string
    }): ExpenseView => ({
      id: 'new-1',
      itemName: input.itemName,
      amount: input.amount,
      category: input.category ?? 'Other',
      date: `${input.day ?? TODAY}T12:00:00`,
      day: input.day ?? TODAY,
      createdAt: `${input.day ?? TODAY}T12:00:00`,
      ext: {},
    }),
  )
  // the confirmation asks how the save went before it says "Added"
  useExpenseStore.setState({ addExpense: add, saveNow: () => 'saved' })
  return add
}

describe('DueSoon', () => {
  it('lists each charge with when it is due, its category and its last amount', () => {
    render(<DueSoon charges={charges()} today={TODAY} notSpending={[]} />)
    expect(screen.getByRole('heading', { name: 'Due soon' })).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^RentDue today · Housing.*600\.00Log$/),
      expect.stringMatching(/^ETF transferTomorrow · Investment.*300\.00Log$/),
      expect.stringMatching(/^SpotifyTue, Oct 20 · Subscriptions.*11\.98Log$/),
    ])
  })

  it('says which charges are not spending', () => {
    render(<DueSoon charges={charges()} today={TODAY} notSpending={['Investment']} />)
    const [rent, etf] = screen.getAllByRole('listitem')
    expect(etf).toHaveTextContent('Tomorrow · Investment · not spending')
    expect(rent).not.toHaveTextContent('not spending')
  })

  it('Log adds the entry for today at its last amount, and says so with an Undo', () => {
    const add = fakeAdd()
    render(<DueSoon charges={charges()} today={TODAY} notSpending={[]} />)
    const row = screen.getAllByRole('listitem')[2]
    if (!row) throw new Error('no row')
    fireEvent.click(within(row).getByRole('button', { name: /^Log Spotify, .*11\.98, for today$/ }))
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith({
      itemName: 'Spotify',
      amount: 11.98,
      category: 'Subscriptions',
      day: TODAY,
    })
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.message).toMatch(/^Added "Spotify" · .*11\.98$/)
    expect(toast?.action?.label).toBe('Undo')
    expect(toast?.undoId).toBe('add-new-1')
  })

  it('an add the store refuses is said, and nothing else happens', () => {
    const add = vi.fn(() => {
      throw new Error('SpendTrack is still loading your data.')
    })
    useExpenseStore.setState({ addExpense: add })
    render(<DueSoon charges={charges()} today={TODAY} notSpending={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log Rent/ }))
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.kind).toBe('error')
    expect(toast?.action).toBeUndefined()
  })

  it('never adds by itself: rendering the list calls nothing', () => {
    const add = fakeAdd()
    render(<DueSoon charges={charges()} today={TODAY} notSpending={[]} />)
    expect(add).not.toHaveBeenCalled()
    expect(screen.getByText(/Nothing is added by itself\./)).toBeInTheDocument()
  })

  it('shows nothing when nothing is due', () => {
    const { container } = render(<DueSoon charges={[]} today={TODAY} notSpending={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
